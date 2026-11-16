import { Injectable, OnModuleInit } from '@nestjs/common';
import { Order, Payment, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { config } from '../../common/config';
import { log } from '../../common/context';
import { decryptJson, reference } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { AlertService, PrismaService, QueueService, Tx } from '../../common/infra';
import { formatMoney, formatWhen } from '../../common/util';
import { CustomerService } from '../customers/customer.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationService } from '../notifications/notification.service';
import { OrderService, UNPAID_OPEN } from '../orders/order.service';
import { TicketService } from '../tickets/ticket.service';
import { Allocation, LedgerService } from './ledger.service';
import { ProviderAccountCtx, ProviderRegistry, VerifiedPayment } from './providers';

export type PaymentOutcome = 'ISSUED' | 'ALREADY_PROCESSED' | 'PENDING' | 'FAILED' | 'MISMATCH' | 'DUPLICATE_PAYMENT' | 'UNFULFILLABLE';

@Injectable()
export class PaymentService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private registry: ProviderRegistry,
    private orders: OrderService,
    private inventory: InventoryService,
    private tickets: TicketService,
    private ledger: LedgerService,
    private notifications: NotificationService,
    private customers: CustomerService,
    private alerts: AlertService,
    private queue: QueueService,
  ) {}

  onModuleInit() {
    this.queue.register('payment-webhook', (d) => this.processWebhookEvent(d.eventId), 10);
  }

  // ───────────────────────── Merchant account selection ─────────────────────────

  async accountCtx(accountId: string): Promise<ProviderAccountCtx> {
    const a = await this.prisma.paymentProviderAccount.findUnique({ where: { id: accountId } });
    if (!a) throw new AppError('NOT_FOUND', 'Merchant account not found', 404);
    return { id: a.id, providerCode: a.providerCode, livemode: a.livemode, merchantRef: a.merchantRef, credentials: decryptJson(a.credentialsEnc) };
  }

  /**
   * Picks the merchant account for a brand and currency. Only links an operator has marked
   * as approved by the payment provider are eligible; the owning legal entity becomes the
   * order's legal seller. There is no fallback to another brand's account.
   */
  async selectAccount(brandId: string, currency: string, db: Tx | PrismaService = this.prisma) {
    const configs = await db.brandPaymentConfiguration.findMany({
      where: {
        brandId, active: true, providerApproved: true, currencies: { has: currency },
        providerAccount: { active: true, currencies: { has: currency }, provider: { enabled: true } },
      },
      include: { providerAccount: { include: { provider: true } } },
      orderBy: { priority: 'asc' },
    });
    const usable = configs.filter((c) => !(c.providerAccount.provider.isTestOnly && config.isProd && !config.allowSandboxProvider));
    if (!usable.length) {
      throw new AppError('PAYMENT_NOT_CONFIGURED', `This storefront has no approved payment configuration for ${currency}`, 409);
    }
    return usable[0].providerAccount;
  }

  /** Creates the payment record inside the checkout transaction. */
  createPayment(tx: Tx, order: Pick<Order, 'id' | 'brandId' | 'totalMinor' | 'currency'>, account: { id: string; providerCode: string; livemode: boolean }) {
    return tx.payment.create({
      data: {
        orderId: order.id, brandId: order.brandId, providerAccountId: account.id, providerCode: account.providerCode,
        reference: reference('PAY', 16), amountMinor: order.totalMinor, currency: order.currency, livemode: account.livemode,
      },
    });
  }

  /**
   * Opens a hosted checkout session with the gateway (outside any DB transaction).
   * If the gateway cannot be reached the order fails and its tickets are released at once.
   */
  async initiate(paymentId: string, callbackUrl: string) {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { order: { include: { brand: true } } } });
    const account = await this.accountCtx(payment.providerAccountId);
    const adapter = this.registry.get(payment.providerCode);
    const started = Date.now();
    try {
      const init = await adapter.initialize(account, {
        reference: payment.reference, amountMinor: payment.amountMinor, currency: payment.currency,
        email: payment.order.customerEmail, name: payment.order.customerName, callbackUrl,
        metadata: { order_reference: payment.order.reference, brand: payment.order.brand.slug },
        channels: payment.order.brand.enabledPaymentMethods,
      });
      await this.prisma.tx(async (tx) => {
        const order = await this.orders.lock(tx, payment.orderId);
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'PENDING', checkoutUrl: init.checkoutUrl } });
        await tx.paymentAttempt.create({ data: { paymentId: payment.id, kind: 'INITIALIZE', outcome: 'OK', detail: { providerReference: init.providerReference ?? null } } });
        if (['RESERVED', 'AWAITING_PAYMENT', 'FAILED'].includes(order.status)) {
          await this.orders.transition(tx, order, 'AWAITING_PAYMENT', { type: 'SYSTEM' }, `Hosted checkout opened with ${payment.providerCode}`, {
            gatewayCode: payment.providerCode, gatewayReference: payment.reference,
          });
        }
      });
      await this.alerts.integration({ integration: payment.providerCode, direction: 'OUTBOUND', operation: 'initialize', status: 'OK', durationMs: Date.now() - started, brandId: payment.brandId, reference: payment.reference });
      return { checkoutUrl: init.checkoutUrl, reference: payment.reference, provider: payment.providerCode };
    } catch (e) {
      const error = (e as Error).message;
      await this.prisma.paymentAttempt.create({ data: { paymentId: payment.id, kind: 'INITIALIZE', outcome: 'ERROR', detail: { error } } });
      await this.prisma.tx((tx) => this.orders.close(tx, payment.orderId, 'FAILED', { type: 'GATEWAY' }, `Payment could not be started: ${error}`.slice(0, 300)));
      await this.alerts.integration({ integration: payment.providerCode, direction: 'OUTBOUND', operation: 'initialize', status: 'ERROR', durationMs: Date.now() - started, brandId: payment.brandId, reference: payment.reference, error });
      await this.alerts.raise({
        type: 'PAYMENT_INIT_FAILED', severity: 'CRITICAL', brandId: payment.brandId, message: `Could not start ${payment.providerCode} payment: ${error}`,
        dedupeKey: `payinit:${payment.providerAccountId}:${new Date().toISOString().slice(0, 13)}`,
      });
      throw new AppError('PAYMENT_INIT_FAILED', 'We could not start the payment. You have not been charged; please try again.', 502);
    }
  }

  // ───────────────────────── Webhooks ─────────────────────────

  /**
   * Receives a gateway webhook on the account-specific URL. The signature is checked with
   * that merchant account's own secret, the event is stored exactly once, and processing is
   * handed to the queue so the gateway gets a fast 200.
   */
  async receiveWebhook(providerCode: string, accountId: string, headers: Record<string, string | string[] | undefined>, rawBody: Buffer) {
    const accountRow = await this.prisma.paymentProviderAccount.findUnique({ where: { id: accountId } }).catch(() => null);
    if (!accountRow || accountRow.providerCode !== providerCode) throw new AppError('NOT_FOUND', 'Unknown webhook endpoint', 404);
    const account = await this.accountCtx(accountId);
    const parsed = this.registry.get(providerCode).parseWebhook(account, headers, rawBody);

    if (!parsed.signatureValid) {
      await this.prisma.paymentWebhookEvent.create({
        data: {
          providerCode, providerAccountId: accountId, eventKey: `rejected:${randomUUID()}`, eventType: parsed.eventType, reference: parsed.reference,
          signatureValid: false, status: 'REJECTED', error: 'Invalid signature', payload: { bytes: rawBody.length }, processedAt: new Date(),
        },
      });
      await this.alerts.integration({ integration: providerCode, direction: 'INBOUND', operation: 'webhook', status: 'ERROR', reference: parsed.reference ?? undefined, error: 'Invalid webhook signature' });
      await this.alerts.raise({
        type: 'WEBHOOK_SIGNATURE_INVALID', severity: 'WARNING', message: `Rejected ${providerCode} webhook with an invalid signature`,
        dedupeKey: `whsig:${accountId}:${new Date().toISOString().slice(0, 13)}`,
      });
      throw new AppError('INVALID_SIGNATURE', 'Webhook signature verification failed', 401);
    }

    let body: Prisma.InputJsonValue = {};
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new AppError('INVALID_PAYLOAD', 'Webhook body is not valid JSON', 400);
    }
    const created = await this.prisma.paymentWebhookEvent.createMany({
      data: [{
        providerCode, providerAccountId: accountId, eventKey: parsed.eventKey, eventType: parsed.eventType, reference: parsed.reference,
        signatureValid: true, payload: { kind: parsed.kind, body },
      }],
      skipDuplicates: true,
    });
    const event = await this.prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { providerCode_eventKey: { providerCode, eventKey: parsed.eventKey } } });
    if (created.count === 0 && !['RECEIVED', 'FAILED'].includes(event.status)) return { received: true, duplicate: true };
    await this.enqueueWebhook(event.id, event.attempts);
    return { received: true, duplicate: created.count === 0 };
  }

  private async enqueueWebhook(eventId: string, attempts: number) {
    try {
      await this.queue.add('payment-webhook', { eventId }, { jobId: `${eventId}-${attempts}` });
    } catch (e) {
      log.error('webhook_enqueue_failed', { eventId, error: (e as Error).message }); // the sweep re-enqueues RECEIVED events
    }
  }

  async processWebhookEvent(eventId: string): Promise<void> {
    const event = await this.prisma.paymentWebhookEvent.findUnique({ where: { id: eventId } });
    if (!event || !['RECEIVED', 'FAILED'].includes(event.status)) return;
    const done = (status: 'PROCESSED' | 'IGNORED' | 'REJECTED', error?: string) =>
      this.prisma.paymentWebhookEvent.update({ where: { id: eventId }, data: { status, error: error ?? null, processedAt: new Date(), attempts: { increment: 1 } } });
    try {
      const kind = (event.payload as { kind?: string })?.kind;
      if (kind === 'REFUND') {
        if (/fail/i.test(event.eventType)) {
          await this.alerts.raise({ type: 'GATEWAY_REFUND_FAILED', severity: 'CRITICAL', message: `${event.providerCode} reported a failed refund for transaction ${event.reference}`, entityType: 'payment', entityId: event.reference ?? undefined });
        }
        await done('IGNORED', 'Refund events are informational; refunds are tracked from the refund workflow');
        return;
      }
      if (kind !== 'PAYMENT' || !event.reference) {
        await done('IGNORED', 'Event type not relevant to order processing');
        return;
      }
      const payment = await this.prisma.payment.findUnique({ where: { reference: event.reference } });
      if (!payment) {
        await done('IGNORED', 'No payment with this reference');
        return;
      }
      // Gateway account verification: the event must come from the account the payment was created on.
      if (payment.providerAccountId !== event.providerAccountId || payment.providerCode !== event.providerCode) {
        await done('REJECTED', 'Webhook arrived on a different merchant account than the payment');
        await this.alerts.raise({ type: 'WEBHOOK_ACCOUNT_MISMATCH', severity: 'CRITICAL', brandId: payment.brandId, entityType: 'payment', entityId: payment.id, message: `Webhook for ${payment.reference} arrived on the wrong merchant account` });
        return;
      }
      const outcome = await this.confirmPayment(payment.reference, 'WEBHOOK');
      await done('PROCESSED', outcome === 'ISSUED' || outcome === 'ALREADY_PROCESSED' ? undefined : outcome);
    } catch (e) {
      await this.prisma.paymentWebhookEvent.update({ where: { id: eventId }, data: { status: 'FAILED', error: (e as Error).message.slice(0, 500), attempts: { increment: 1 } } });
      throw e; // let the queue retry with backoff
    }
  }

  // ───────────────────────── Verification and fulfilment ─────────────────────────

  /**
   * Asks the provider for the transaction's real state and applies it. This is the only
   * path to a paid order: webhooks, return-page polling and the reconciliation sweep all
   * end up here, and none of them trusts data supplied by a browser.
   */
  async confirmPayment(paymentReference: string, source: 'WEBHOOK' | 'RETURN' | 'SWEEP' | 'ADMIN'): Promise<PaymentOutcome> {
    const payment = await this.prisma.payment.findUnique({ where: { reference: paymentReference } });
    if (!payment) throw new AppError('NOT_FOUND', 'Payment not found', 404);
    if (payment.status === 'SUCCEEDED') return 'ALREADY_PROCESSED';
    const account = await this.accountCtx(payment.providerAccountId);
    const started = Date.now();
    let verified: VerifiedPayment;
    try {
      verified = await this.registry.get(payment.providerCode).verify(account, payment.reference, payment.providerTransactionId);
    } catch (e) {
      await this.alerts.integration({ integration: payment.providerCode, direction: 'OUTBOUND', operation: 'verify', status: 'ERROR', durationMs: Date.now() - started, brandId: payment.brandId, reference: payment.reference, error: (e as Error).message });
      throw e;
    }
    const outcome = await this.applyVerification(payment.id, verified, source);
    if (outcome === 'ISSUED') await this.notifications.kick();
    return outcome;
  }

  private allocation(order: Order, commissions: { type: string; amountMinor: bigint }[]): Allocation {
    const sum = (type: string) => commissions.filter((c) => c.type === type).reduce((s, c) => s + c.amountMinor, 0n);
    const platformCommissionMinor = sum('PLATFORM_COMMISSION');
    const brandCommissionMinor = sum('BRAND_COMMISSION');
    return {
      totalMinor: order.totalMinor, feesMinor: order.feesMinor, taxMinor: order.taxMinor, platformCommissionMinor, brandCommissionMinor,
      promoterMinor: order.totalMinor - order.feesMinor - order.taxMinor - platformCommissionMinor - brandCommissionMinor,
    };
  }

  async orderAllocation(tx: Tx | PrismaService, order: Order): Promise<Allocation> {
    return this.allocation(order, await tx.commission.findMany({ where: { orderId: order.id } }));
  }

  /**
   * Applies a provider-verified result in ONE transaction under the order row lock:
   * payment → inventory → tickets → ledger → payables → CRM → notification outbox.
   * Re-running it for an already-successful payment changes nothing, which is what makes
   * duplicate and concurrent webhooks harmless.
   */
  async applyVerification(paymentId: string, v: VerifiedPayment, source: string): Promise<PaymentOutcome> {
    const outcome = await this.prisma.tx(async (tx): Promise<PaymentOutcome> => {
      const stale = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const order = await this.orders.lock(tx, stale.orderId);
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (payment.status === 'SUCCEEDED') return 'ALREADY_PROCESSED';
      const attempt = (outcome: string, detail: Record<string, unknown> = {}) =>
        tx.paymentAttempt.create({ data: { paymentId, kind: source === 'WEBHOOK' ? 'WEBHOOK' : 'VERIFY', outcome, detail: { source, ...detail, provider: v.raw } as Prisma.InputJsonValue } });

      if (v.status === 'PENDING') {
        await attempt('PENDING');
        if (order.status === 'AWAITING_PAYMENT' && source === 'WEBHOOK') {
          await this.orders.transition(tx, order, 'PAYMENT_PROCESSING', { type: 'GATEWAY' }, 'Gateway reports payment in progress', { paymentStatus: 'PROCESSING' });
        }
        return 'PENDING';
      }

      if (v.status === 'FAILED') {
        await attempt('FAILED', { reason: v.failureReason });
        await tx.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureReason: v.failureReason, providerTransactionId: v.providerTransactionId ?? undefined, verification: v.raw as Prisma.InputJsonValue } });
        // A failed older attempt must not close an order the customer is retrying with a newer payment.
        const newer = await tx.payment.count({ where: { orderId: order.id, id: { not: paymentId }, createdAt: { gt: payment.createdAt }, status: { in: ['INITIATED', 'PENDING'] } } });
        if (!newer && UNPAID_OPEN.includes(order.status)) {
          await this.orders.close(tx, order.id, 'FAILED', { type: 'GATEWAY' }, `Payment failed: ${v.failureReason ?? 'declined'}`.slice(0, 300));
        }
        return 'FAILED';
      }

      // ── The gateway says money was captured. Check it is the money we asked for. ──
      const problems: string[] = [];
      if (v.amountMinor === null || v.amountMinor !== payment.amountMinor) problems.push(`amount ${v.amountMinor} != expected ${payment.amountMinor}`);
      if (!v.currency || v.currency.toUpperCase() !== payment.currency) problems.push(`currency ${v.currency} != expected ${payment.currency}`);
      if (v.reference !== payment.reference) problems.push(`reference ${v.reference} != ${payment.reference}`);
      if (problems.length) {
        await attempt('MISMATCH', { problems });
        await tx.payment.update({ where: { id: paymentId }, data: { failureReason: `VERIFICATION_MISMATCH: ${problems.join('; ')}`.slice(0, 500), verification: v.raw as Prisma.InputJsonValue } });
        await tx.order.update({ where: { id: order.id }, data: { needsAttention: true, attentionReason: 'Gateway captured a payment that does not match the order. No tickets issued.' } });
        await this.alerts.raise({ type: 'PAYMENT_MISMATCH', severity: 'CRITICAL', brandId: order.brandId, entityType: 'payment', entityId: paymentId, message: `Payment ${payment.reference} verification mismatch: ${problems.join('; ')}`, dedupeKey: `mismatch:${paymentId}` });
        return 'MISMATCH';
      }
      if (await tx.payment.count({ where: { orderId: order.id, status: 'SUCCEEDED' } })) {
        await attempt('DUPLICATE_PAYMENT');
        await tx.payment.update({ where: { id: paymentId }, data: { failureReason: 'DUPLICATE_PAYMENT: order already paid by another transaction; refund this capture at the gateway', providerTransactionId: v.providerTransactionId ?? undefined, verification: v.raw as Prisma.InputJsonValue } });
        await tx.order.update({ where: { id: order.id }, data: { needsAttention: true, attentionReason: 'Customer was charged twice. The second capture needs a gateway refund.' } });
        await this.alerts.raise({ type: 'DUPLICATE_PAYMENT', severity: 'CRITICAL', brandId: order.brandId, entityType: 'payment', entityId: paymentId, message: `Order ${order.reference} received a second successful payment (${payment.reference})`, dedupeKey: `duppay:${paymentId}` });
        return 'DUPLICATE_PAYMENT';
      }

      const paidAt = v.paidAt ?? new Date();
      await attempt('OK');
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'SUCCEEDED', providerTransactionId: v.providerTransactionId, channel: v.channel, paidAt, failureReason: null,
          gatewayFeeMinor: v.feeMinor, netSettlementMinor: v.feeMinor === null ? null : payment.amountMinor - v.feeMinor, verification: v.raw as Prisma.InputJsonValue,
        },
      });

      const full = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, event: { include: { venue: true, organizer: true } }, brand: true, legalEntity: true, commissions: true } });
      const lines = full.items.map((i) => ({ ticketCategoryId: i.ticketCategoryId, quantity: i.quantity }));

      // ── Financial records: the capture is journaled whether or not tickets can be issued. ──
      const alloc = this.allocation(full, full.commissions);
      const organizerId = full.event.organizerId;
      await this.ledger.post(tx, {
        type: 'PAYMENT_CAPTURE', description: `Payment captured for order ${order.reference}`, idempotencyKey: `capture:${paymentId}`, currency: order.currency,
        brandId: order.brandId, legalEntityId: order.legalEntityId, orderId: order.id, paymentId, lines: this.ledger.captureLines(alloc, organizerId),
      });
      if (v.feeMinor && v.feeMinor > 0n) {
        await this.ledger.post(tx, {
          type: 'GATEWAY_FEE', description: `Gateway charge on ${payment.reference}`, idempotencyKey: `gwfee:${paymentId}`, currency: order.currency,
          brandId: order.brandId, legalEntityId: order.legalEntityId, orderId: order.id, paymentId,
          lines: [{ account: 'GATEWAY_FEE_EXPENSE', direction: 'DEBIT', amountMinor: v.feeMinor }, { account: 'GATEWAY_CLEARING', direction: 'CREDIT', amountMinor: v.feeMinor }],
        });
      }
      if (organizerId && alloc.promoterMinor > 0n) {
        const eventEnd = full.event.endsAt ?? full.event.startsAt;
        await tx.promoterPayable.create({
          data: {
            organizerId, eventId: full.eventId, orderId: order.id, brandId: order.brandId, kind: 'SALE',
            grossMinor: full.subtotalMinor - full.discountMinor, commissionMinor: alloc.platformCommissionMinor + alloc.brandCommissionMinor,
            amountMinor: alloc.promoterMinor, currency: order.currency,
            availableAt: new Date(eventEnd.getTime() + (full.event.organizer?.payoutHoldDays ?? 3) * 86400_000),
          },
        });
      }

      await this.customers.recordPurchase(tx, order.relationshipId, paidAt);

      // Inventory is touched last: from here to COMMIT the shared inventory row is locked, so only a
      // handful of statements may follow. Everything slower already ran above.
      const fulfilled = (await this.inventory.confirm(tx, order.id, order.brandId)) || (await this.inventory.allocateLate(tx, lines, { orderId: order.id, brandId: order.brandId }));
      const paid = await this.orders.transition(tx, order, 'PAID', { type: 'GATEWAY' }, `Payment verified with ${payment.providerCode} (${source.toLowerCase()})`, {
        paymentStatus: 'PAID', paidAt, gatewayCode: payment.providerCode, gatewayReference: payment.reference, reservationExpiresAt: null,
      });

      if (!fulfilled) {
        // Paid after the reservation lapsed and the tickets have since been sold. Never oversell: queue a full refund for approval.
        await tx.order.update({ where: { id: order.id }, data: { needsAttention: true, attentionReason: 'Paid after the reservation expired and tickets are no longer available. Full refund required.' } });
        await tx.refund.create({
          data: {
            reference: reference('RFD', 10), orderId: order.id, paymentId, brandId: order.brandId, amountMinor: order.totalMinor, currency: order.currency,
            reason: 'Payment arrived after the reservation expired; tickets no longer available', ticketIds: [], returnInventory: false,
            requestedByType: 'SYSTEM', idempotencyKey: `unfulfillable:${paymentId}`,
          },
        });
        await this.alerts.raise({ type: 'PAID_ORDER_UNFULFILLABLE', severity: 'CRITICAL', brandId: order.brandId, entityType: 'order', entityId: order.id, message: `Order ${order.reference} was paid after its tickets were released and resold. A refund request is awaiting approval.`, dedupeKey: `unfulfillable:${order.id}` });
        return 'UNFULFILLABLE';
      }

      const issued = await this.tickets.issueForOrder(tx, full);
      await this.orders.transition(tx, paid, 'TICKETS_ISSUED', { type: 'SYSTEM' }, `${issued} ticket(s) issued`, { ticketsIssuedAt: new Date() });
      await this.enqueueOrderEmails(tx, full, issued, payment.reference, paidAt);
      return 'ISSUED';
    }, { timeoutMs: 30_000 });
    return outcome;
  }

  /** Completes an order whose total is zero (100% discount or free tickets). No gateway is involved. */
  async fulfilFreeOrder(tx: Tx, orderId: string) {
    const order = await this.orders.lock(tx, orderId);
    if (order.totalMinor !== 0n) throw new Error('fulfilFreeOrder called for a non-zero order');
    const full = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, event: { include: { venue: true, organizer: true } }, brand: true, legalEntity: true, commissions: true } });
    await this.inventory.confirm(tx, order.id, order.brandId);
    const now = new Date();
    const paid = await this.orders.transition(tx, order, 'PAID', { type: 'SYSTEM' }, 'No payment required', { paymentStatus: 'PAID', paidAt: now, gatewayCode: 'none', reservationExpiresAt: null });
    const issued = await this.tickets.issueForOrder(tx, full);
    await this.orders.transition(tx, paid, 'TICKETS_ISSUED', { type: 'SYSTEM' }, `${issued} ticket(s) issued`, { ticketsIssuedAt: now });
    await this.customers.recordPurchase(tx, order.relationshipId, now);
    await this.enqueueOrderEmails(tx, full, issued, null, now);
  }

  private async enqueueOrderEmails(
    tx: Tx,
    o: Prisma.OrderGetPayload<{ include: { items: true; event: { include: { venue: true } }; brand: true; legalEntity: true } }>,
    ticketCount: number, paymentReference: string | null, paidAt: Date,
  ) {
    const money = (m: bigint) => formatMoney(m, o.currency);
    const policy = (o.policyVersions ?? {}) as Record<string, number>;
    const payload = {
      name: o.customerName, email: o.customerEmail, orderReference: o.reference, ticketCount,
      event: { name: o.event.name, when: formatWhen(o.event.startsAt, o.event.timezone), venue: o.event.venue ? `${o.event.venue.name}, ${o.event.venue.city}` : '' },
      items: o.items.map((i) => ({ name: i.categoryName, quantity: i.quantity, total: money(i.lineTotalMinor) })),
      fees: o.feesMinor > 0n ? money(o.feesMinor) : null, tax: o.taxMinor > 0n ? money(o.taxMinor) : null,
      discount: o.discountMinor > 0n ? money(o.discountMinor) : null, total: money(o.totalMinor),
      seller: o.legalEntity.name, policy: { terms: policy.TERMS ?? '-', refund: policy.REFUND ?? '-', privacy: policy.PRIVACY ?? '-' },
      paymentReference, paidAt: formatWhen(paidAt, o.brand.timezone),
    };
    const base = { brandId: o.brandId, to: o.customerEmail, toName: o.customerName, customerId: o.customerId, orderId: o.id, payload };
    // Both emails use the brand the order was placed on, never the brand of whoever triggers delivery.
    await this.notifications.enqueue({ ...base, type: 'ORDER_CONFIRMATION', dedupeKey: `order-confirmation:${o.id}` }, tx);
    await this.notifications.enqueue({ ...base, type: 'TICKET_DELIVERY', attachTickets: true, dedupeKey: `ticket-delivery:${o.id}` }, tx);
    const sms = await tx.brandSetting.findUnique({ where: { brandId_key: { brandId: o.brandId, key: 'notifications.smsOnTicketDelivery' } } });
    if (o.customerPhone && (sms?.value as { enabled?: boolean } | null)?.enabled) {
      await this.notifications.enqueue({ ...base, channel: 'SMS', to: o.customerPhone, type: 'TICKET_DELIVERY', dedupeKey: `ticket-delivery-sms:${o.id}` }, tx);
    }
  }

  /** Re-sends an order's tickets, always with the order's originating brand identity. */
  async resendTickets(orderId: string) {
    const o = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, event: { include: { venue: true } }, brand: true, legalEntity: true } });
    const ticketCount = await this.prisma.ticket.count({ where: { orderId, status: 'VALID' } });
    if (!ticketCount) throw new AppError('NO_VALID_TICKETS', 'This order has no valid tickets to send', 409);
    await this.notifications.enqueue({
      brandId: o.brandId, type: 'TICKET_DELIVERY', to: o.customerEmail, toName: o.customerName, customerId: o.customerId, orderId: o.id, attachTickets: true,
      payload: {
        name: o.customerName, email: o.customerEmail, orderReference: o.reference, ticketCount,
        event: { name: o.event.name, when: formatWhen(o.event.startsAt, o.event.timezone), venue: o.event.venue ? `${o.event.venue.name}, ${o.event.venue.city}` : '' },
      },
    });
    await this.notifications.kick();
    return { queued: true, to: o.customerEmail, ticketCount };
  }

  // ───────────────────────── Sweeps (scheduled) ─────────────────────────

  /** Re-queues webhook events that were stored but not processed, and alerts on a backlog. */
  async sweepWebhooks() {
    const stuck = await this.prisma.paymentWebhookEvent.findMany({
      where: { status: { in: ['RECEIVED', 'FAILED'] }, receivedAt: { lt: new Date(Date.now() - 60_000) }, attempts: { lt: 12 } },
      select: { id: true, attempts: true }, take: 200,
    });
    for (const e of stuck) await this.enqueueWebhook(e.id, e.attempts + 100);
    const old = await this.prisma.paymentWebhookEvent.count({ where: { status: { in: ['RECEIVED', 'FAILED'] }, receivedAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
    if (old > 0) {
      await this.alerts.raise({ type: 'UNPROCESSED_WEBHOOKS', severity: 'CRITICAL', message: `${old} payment webhook(s) have been unprocessed for more than 10 minutes`, dedupeKey: `whbacklog:${new Date().toISOString().slice(0, 13)}` });
    }
    return { requeued: stuck.length, backlog: old };
  }

  /** Catches payments whose webhook never arrived by asking the provider directly. */
  async sweepPendingPayments() {
    const pending = await this.prisma.payment.findMany({
      where: { status: 'PENDING', failureReason: null, createdAt: { lt: new Date(Date.now() - 3 * 60_000), gt: new Date(Date.now() - 48 * 3600_000) } },
      select: { reference: true }, orderBy: { createdAt: 'asc' }, take: 100,
    });
    let resolved = 0;
    for (const p of pending) {
      try {
        const outcome = await this.confirmPayment(p.reference, 'SWEEP');
        if (outcome !== 'PENDING') resolved++;
      } catch (e) {
        log.warn('payment_sweep_verify_failed', { reference: p.reference, error: (e as Error).message });
      }
    }
    // Abandoned checkouts: stop polling once the order is closed and the gateway still reports nothing.
    await this.prisma.payment.updateMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 6 * 3600_000) }, order: { status: { in: ['EXPIRED', 'CANCELLED', 'FAILED'] } } },
      data: { status: 'CANCELLED', failureReason: 'Abandoned at gateway' },
    });
    return { checked: pending.length, resolved };
  }
}

export type { Payment };
