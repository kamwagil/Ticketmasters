import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsBoolean, IsEmail, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import {
  AllowSuspendedBrand, CurrentCustomer, CustomerCtx, IdempotencyService, OptionalCustomerGuard, RateLimit, RateLimitGuard, Storefront, StorefrontCtx,
  StorefrontGuard,
} from '../../common/auth';
import { reference } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/infra';
import { normEmail, normPhone } from '../../common/util';
import { CatalogService } from '../catalog/catalog.service';
import { CustomerService } from '../customers/customer.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationService } from '../notifications/notification.service';
import { PaymentService } from '../payments/payment.service';
import { PricingService, Quote } from '../payments/pricing.service';
import { OrderService, UNPAID_OPEN } from './order.service';

class ItemDto {
  @IsUUID() ticketCategoryId: string;
  @IsInt() @Min(1) @Max(100) quantity: number;
}
class QuoteDto {
  /** Event id or slug. */
  @IsString() @MaxLength(100) eventId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ItemDto) items: ItemDto[];
  @IsOptional() @IsString() @MaxLength(40) promoCode?: string;
}
class BuyerDto {
  @IsEmail() email: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
}
class CreateOrderDto extends QuoteDto {
  @ValidateNested() @Type(() => BuyerDto) customer: BuyerDto;
  /** The buyer must accept the storefront's current terms and refund policy. */
  @Equals(true, { message: 'The terms and refund policy must be accepted' }) acceptPolicies: boolean;
  /** Explicit opt-in to marketing from THIS brand only. Absent or false records nothing. */
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
  /** Where the gateway returns the buyer. Must be on one of this storefront's verified domains. */
  @IsOptional() @IsString() @MaxLength(500) returnUrl?: string;
  /** Campaign tracking token from a marketing email link, for revenue attribution. */
  @IsOptional() @IsString() @MaxLength(100) campaignToken?: string;
}
class OrderAccessQuery {
  /** Required for guests: must match the email the order was placed with. */
  @IsOptional() @IsEmail() email?: string;
}

const quoteView = (q: Quote) => ({
  currency: q.currency,
  lines: q.lines,
  subtotalMinor: q.subtotalMinor,
  discountMinor: q.discountMinor,
  feesMinor: q.feesMinor,
  taxMinor: q.taxMinor,
  totalMinor: q.totalMinor,
  promoCode: q.promo?.code ?? null,
});

@ApiTags('Storefront · Checkout')
@ApiSecurity('storefront-key')
@Controller('v1/storefront')
@UseGuards(StorefrontGuard, OptionalCustomerGuard, RateLimitGuard)
export class StorefrontCheckoutController {
  constructor(
    private prisma: PrismaService,
    private catalog: CatalogService,
    private pricing: PricingService,
    private inventory: InventoryService,
    private customers: CustomerService,
    private orders: OrderService,
    private payments: PaymentService,
    private notifications: NotificationService,
    private idempotency: IdempotencyService,
  ) {}

  /** Calculates the order total (prices, promo, fees, tax). Nothing is reserved. */
  @Post('checkout/quote')
  @HttpCode(200)
  async quote(@Storefront() sf: StorefrontCtx, @Body() dto: QuoteDto) {
    const event = await this.catalog.storefrontEvent(sf.brand.id, dto.eventId);
    return quoteView(await this.pricing.quote(sf.brand, event, dto.items, dto.promoCode));
  }

  /**
   * Creates the order, atomically reserves inventory and opens a hosted payment session.
   * Send an `Idempotency-Key` header: retrying with the same key returns the original order
   * instead of reserving twice.
   */
  @Post('checkout/orders')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @RateLimit({ limit: 3000, windowSec: 60, by: 'storefront' })
  async createOrder(
    @Storefront() sf: StorefrontCtx, @Body() dto: CreateOrderDto, @Headers('idempotency-key') idemKey?: string, @CurrentCustomer() authed?: CustomerCtx,
  ) {
    if (!idemKey) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header with checkout requests', 400);
    const brand = sf.brand;
    return this.idempotency.run(`checkout:${brand.id}`, idemKey, dto, async () => {
      const event = await this.catalog.storefrontEvent(brand.id, dto.eventId);
      const quote = await this.pricing.quote(brand, event, dto.items, dto.promoCode);
      const free = quote.totalMinor === 0n;

      // The merchant account decides the legal seller; both are fixed on the order for good.
      const account = free ? null : await this.payments.selectAccount(brand.id, quote.currency);
      const legalEntityId = account?.legalEntityId
        ?? (await this.prisma.brandLegalEntityAssignment.findFirst({ where: { brandId: brand.id }, orderBy: { isDefault: 'desc' } }))?.legalEntityId;
      if (!legalEntityId) throw new AppError('SELLER_NOT_CONFIGURED', 'This storefront has no legal seller configured', 409);

      const policyRows = await this.prisma.brandPolicy.findMany({ where: { brandId: brand.id }, orderBy: { version: 'desc' } });
      const policyVersions: Record<string, number> = {};
      for (const p of policyRows) policyVersions[p.type] ??= p.version;

      let campaignId: string | null = null;
      if (dto.campaignToken) {
        const delivery = await this.prisma.campaignDelivery.findUnique({ where: { trackingToken: dto.campaignToken }, include: { campaign: true } });
        if (delivery?.campaign.brandId === brand.id) campaignId = delivery.campaignId;
      }
      campaignId ??= quote.promo?.campaignId ?? null;

      const expiresAt = new Date(Date.now() + brand.reservationTtlSeconds * 1000);
      const created = await this.prisma.tx(async (tx) => {
        const buyer = await this.customers.resolveForCheckout(tx, brand.id, dto.customer, authed);
        const order = await tx.order.create({
          data: {
            reference: reference('ORD', 10), brandId: brand.id, sourceDomain: sf.domain, legalEntityId, customerId: buyer.customerId,
            relationshipId: buyer.relationshipId, eventId: event.id, currency: quote.currency, subtotalMinor: quote.subtotalMinor,
            feesMinor: quote.feesMinor, taxMinor: quote.taxMinor, discountMinor: quote.discountMinor, totalMinor: quote.totalMinor,
            customerName: dto.customer.fullName.trim(), customerEmail: normEmail(dto.customer.email), customerPhone: normPhone(dto.customer.phone),
            customerCountry: dto.customer.country ?? null, policyVersions, promoCodeId: quote.promo?.id ?? null, campaignId,
            livemode: account?.livemode ?? false, reservationExpiresAt: expiresAt,
            items: { create: quote.lines.map((l) => ({ ticketCategoryId: l.ticketCategoryId, categoryName: l.categoryName, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })) },
            history: { create: { toStatus: 'PENDING', reason: `Checkout started on ${sf.domain}`, actorType: authed ? 'CUSTOMER' : 'SYSTEM', actorId: authed?.customerId ?? null } },
            commissions: {
              create: quote.charges.filter((c) => c.amountMinor > 0n).map((c) => ({
                brandId: brand.id, ruleId: c.ruleId, type: c.type, baseMinor: c.baseMinor, percentBps: c.percentBps, fixedMinor: c.fixedMinor, amountMinor: c.amountMinor, currency: quote.currency,
              })),
            },
          },
        });

        if (quote.promo) {
          const n = await tx.$executeRaw`
            UPDATE "promo_codes" SET "redeemedCount" = "redeemedCount" + 1
             WHERE "id" = ${quote.promo.id}::uuid AND ("maxRedemptions" IS NULL OR "redeemedCount" < "maxRedemptions")`;
          if (n !== 1) throw new AppError('PROMO_EXHAUSTED', 'This promo code has been fully redeemed', 422);
        }
        if (dto.marketingOptIn) {
          await this.customers.recordConsent(tx, buyer.customerId, brand.id, 'EMAIL', 'GRANTED', 'checkout', `I would like to receive news and offers from ${brand.name}.`);
        }
        const payment = free ? null : await this.payments.createPayment(tx, order, account!);

        // The authoritative stock check runs last so the shared inventory row is locked for the shortest
        // possible time. It either holds every ticket or rolls the whole order back.
        await this.inventory.reserve(tx, quote.lines, { orderId: order.id, brandId: brand.id, expiresAt });
        await this.orders.transition(tx, order, 'RESERVED', { type: 'SYSTEM' }, 'Inventory reserved', {}, { expiresAt: expiresAt.toISOString() });
        if (free) await this.payments.fulfilFreeOrder(tx, order.id);
        return { order, paymentId: payment?.id ?? null };
      });

      const base = {
        orderReference: created.order.reference, currency: quote.currency, totalMinor: quote.totalMinor, pricing: quoteView(quote),
        reservationExpiresAt: free ? null : expiresAt,
      };
      if (!created.paymentId) {
        await this.notifications.kick();
        return { ...base, status: 'TICKETS_ISSUED', payment: null };
      }
      const init = await this.payments.initiate(created.paymentId, this.callbackUrl(sf, created.order.reference, dto.returnUrl));
      return { ...base, status: 'AWAITING_PAYMENT', payment: init };
    });
  }

  private siteUrl(sf: StorefrontCtx) {
    return this.customers.brandSiteUrl(sf.brand, sf.domain);
  }

  private callbackUrl(sf: StorefrontCtx, orderReference: string, returnUrl?: string) {
    const fallback = `${this.siteUrl(sf)}/orders/${orderReference}`;
    if (!returnUrl) return fallback;
    try {
      const u = new URL(returnUrl);
      // Open-redirect protection: only this storefront's own domain is an acceptable return target.
      return u.host.toLowerCase() === sf.domain && ['http:', 'https:'].includes(u.protocol) ? u.toString() : fallback;
    } catch {
      return fallback;
    }
  }

  /** Loads an order for its buyer: a signed-in customer who owns it, or a guest who knows its reference and email. */
  private async accessOrder(sf: StorefrontCtx, orderReference: string, email?: string, authed?: CustomerCtx) {
    const order = await this.prisma.order.findFirst({ where: { reference: orderReference.toUpperCase(), brandId: sf.brand.id } });
    const owner = !!order && !!authed && order.customerId === authed.customerId;
    const guest = !!order && !!email && normEmail(email) === order.customerEmail;
    if (!order || !(owner || guest)) throw notFound('Order'); // same answer for "missing" and "not yours"
    return order;
  }

  /** Order and payment status. Poll this after the buyer returns from the gateway. */
  @Get('orders/:reference')
  @AllowSuspendedBrand()
  @RateLimit({ limit: 6000, windowSec: 60, by: 'storefront' })
  async orderStatus(@Storefront() sf: StorefrontCtx, @Param('reference') ref: string, @Query() q: OrderAccessQuery, @CurrentCustomer() authed?: CustomerCtx) {
    const o = await this.accessOrder(sf, ref, q.email, authed);
    const [items, event, tickets, payment] = await Promise.all([
      this.prisma.orderItem.findMany({ where: { orderId: o.id } }),
      this.prisma.event.findUniqueOrThrow({ where: { id: o.eventId }, include: { venue: true } }),
      this.prisma.ticket.findMany({ where: { orderId: o.id, status: { not: 'TRANSFERRED' } }, include: { ticketCategory: { select: { name: true } } }, orderBy: { reference: 'asc' } }),
      this.prisma.payment.findFirst({ where: { orderId: o.id }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      reference: o.reference, status: o.status, paymentStatus: o.paymentStatus, currency: o.currency, subtotalMinor: o.subtotalMinor,
      feesMinor: o.feesMinor, taxMinor: o.taxMinor, discountMinor: o.discountMinor, totalMinor: o.totalMinor, refundedMinor: o.refundedMinor,
      createdAt: o.createdAt, paidAt: o.paidAt, reservationExpiresAt: o.reservationExpiresAt,
      customer: { name: o.customerName, email: o.customerEmail },
      event: { id: event.id, slug: event.slug, name: event.name, startsAt: event.startsAt, timezone: event.timezone, status: event.status, venue: event.venue ? `${event.venue.name}, ${event.venue.city}` : null },
      items: items.map((i) => ({ name: i.categoryName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor })),
      // The hosted checkout link is only offered while the order can still be paid.
      payment: payment && UNPAID_OPEN.includes(o.status) ? { provider: payment.providerCode, reference: payment.reference, checkoutUrl: payment.checkoutUrl } : null,
      tickets: tickets.map((t) => ({ id: t.id, reference: t.reference, status: t.status, category: t.ticketCategory.name, holderName: t.holderName })),
    };
  }

  /**
   * Asks the platform to confirm the payment with the gateway now (use when the buyer
   * returns before the webhook arrives). The result always comes from the provider, never
   * from parameters on the return URL.
   */
  @Post('orders/:reference/verify')
  @HttpCode(200)
  @AllowSuspendedBrand()
  @RateLimit({ limit: 20, windowSec: 60 })
  async verify(@Storefront() sf: StorefrontCtx, @Param('reference') ref: string, @Query() q: OrderAccessQuery, @CurrentCustomer() authed?: CustomerCtx) {
    const o = await this.accessOrder(sf, ref, q.email, authed);
    const payment = await this.prisma.payment.findFirst({ where: { orderId: o.id, status: { in: ['PENDING', 'INITIATED'] } }, orderBy: { createdAt: 'desc' } });
    if (payment?.status === 'PENDING') await this.payments.confirmPayment(payment.reference, 'RETURN');
    const fresh = await this.prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    return { reference: fresh.reference, status: fresh.status, paymentStatus: fresh.paymentStatus };
  }

  /** Starts a new payment attempt for an order that is still reserved (for example after a declined card). */
  @Post('orders/:reference/pay')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSec: 60 })
  async pay(@Storefront() sf: StorefrontCtx, @Param('reference') ref: string, @Query() q: OrderAccessQuery, @CurrentCustomer() authed?: CustomerCtx) {
    const o = await this.accessOrder(sf, ref, q.email, authed);
    const paymentId = await this.prisma.tx(async (tx) => {
      const order = await this.orders.lock(tx, o.id);
      if (!['RESERVED', 'AWAITING_PAYMENT'].includes(order.status) || !order.reservationExpiresAt || order.reservationExpiresAt < new Date()) {
        throw new AppError('ORDER_NOT_PAYABLE', 'This order can no longer be paid. Please start a new order.', 409, { status: order.status });
      }
      const account = await this.payments.selectAccount(order.brandId, order.currency, tx);
      if (account.legalEntityId !== order.legalEntityId) throw new AppError('ORDER_NOT_PAYABLE', 'Payment configuration changed. Please start a new order.', 409);
      await tx.payment.updateMany({ where: { orderId: order.id, status: { in: ['INITIATED', 'PENDING'] } }, data: { status: 'CANCELLED', failureReason: 'Superseded by a new payment attempt' } });
      return (await this.payments.createPayment(tx, order, account)).id;
    });
    return this.payments.initiate(paymentId, this.callbackUrl(sf, o.reference));
  }

  /** Lets a buyer abandon an unpaid order, releasing its tickets immediately. */
  @Post('orders/:reference/cancel')
  @HttpCode(200)
  @AllowSuspendedBrand()
  async cancel(@Storefront() sf: StorefrontCtx, @Param('reference') ref: string, @Query() q: OrderAccessQuery, @CurrentCustomer() authed?: CustomerCtx) {
    const o = await this.accessOrder(sf, ref, q.email, authed);
    const closed = await this.prisma.tx((tx) => this.orders.close(tx, o.id, 'CANCELLED', { type: 'CUSTOMER', id: o.customerId }, 'Cancelled by the customer before payment'));
    if (!closed) throw new AppError('ORDER_NOT_CANCELLABLE', 'Only unpaid orders can be cancelled here. Contact support about a refund.', 409);
    return { reference: closed.reference, status: closed.status };
  }
}
