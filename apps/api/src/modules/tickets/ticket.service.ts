import { Injectable } from '@nestjs/common';
import { ScanResult, TicketStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { encrypt, randomToken, reference, sha256 } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { AlertService, PrismaService, Tx } from '../../common/infra';
import { formatWhen, normEmail } from '../../common/util';
import { NotificationService } from '../notifications/notification.service';

export interface ScanOutcome {
  result: ScanResult;
  admitted: boolean;
  message: string;
  ticket?: { reference: string; category: string; holderName: string | null; status: TicketStatus; brand: string; event: string };
  firstScan?: { at: Date; gate: string | null } | null;
}

const MESSAGES: Record<ScanResult, string> = {
  ADMITTED: 'Valid ticket. Admit one.',
  ALREADY_USED: 'Already scanned. Do not admit.',
  INVALID_TOKEN: 'Not a recognised ticket.',
  WRONG_EVENT: 'This ticket is for a different event.',
  NOT_VALID: 'Ticket is not valid.',
  OFFLINE_CONFLICT: 'Duplicate entry detected during offline sync.',
};

@Injectable()
export class TicketService {
  constructor(private prisma: PrismaService, private notifications: NotificationService, private alerts: AlertService) {}

  private async newQrToken(tx: Tx, ticketId: string) {
    // 256 bits from the OS CSPRNG. The QR shows only this value; the database stores its hash.
    const token = randomToken(32);
    await tx.ticketQrToken.create({ data: { ticketId, tokenHash: sha256(token), tokenEnc: encrypt(token) } });
    return token;
  }

  /**
   * Issues one ticket per unit purchased. Must run inside the transaction that holds the
   * order row lock and has just confirmed payment and inventory; calling it again for the
   * same order issues nothing.
   */
  async issueForOrder(
    tx: Tx,
    order: { id: string; brandId: string; customerId: string; eventId: string; customerName: string; customerEmail: string; items: { id: string; ticketCategoryId: string; quantity: number }[] },
  ): Promise<number> {
    if (await tx.ticket.count({ where: { orderId: order.id } })) return 0;
    // Three bulk inserts regardless of quantity: this runs while the inventory row is locked,
    // so it is kept as short as possible.
    const tickets = order.items.flatMap((item) =>
      Array.from({ length: item.quantity }, () => ({
        id: randomUUID(), reference: reference('TKT', 12), orderId: order.id, orderItemId: item.id, eventId: order.eventId,
        ticketCategoryId: item.ticketCategoryId, brandId: order.brandId, customerId: order.customerId, holderName: order.customerName,
        holderEmail: order.customerEmail,
      })),
    );
    await tx.ticket.createMany({ data: tickets });
    await tx.ticketQrToken.createMany({
      data: tickets.map((t) => {
        const token = randomToken(32); // 256 bits from the OS CSPRNG; only its hash is searchable
        return { ticketId: t.id, tokenHash: sha256(token), tokenEnc: encrypt(token) };
      }),
    });
    await tx.ticketStatusHistory.createMany({
      data: tickets.map((t) => ({ ticketId: t.id, toStatus: 'VALID' as const, reason: 'Issued after verified payment', actorType: 'SYSTEM' })),
    });
    return tickets.length;
  }

  /** Invalidates tickets (refund, revocation, cancellation). Their QR tokens stop working immediately. */
  async invalidate(tx: Tx, ticketIds: string[], to: 'REFUNDED' | 'REVOKED' | 'CANCELLED', reason: string, actor: { type: string; id?: string | null }) {
    const tickets = await tx.ticket.findMany({ where: { id: { in: ticketIds }, status: { in: ['VALID', 'USED'] } } });
    for (const t of tickets) {
      await tx.ticket.update({ where: { id: t.id }, data: { status: to } });
      await tx.ticketStatusHistory.create({ data: { ticketId: t.id, fromStatus: t.status, toStatus: to, reason, actorType: actor.type, actorId: actor.id ?? null } });
    }
    await tx.ticketQrToken.updateMany({ where: { ticketId: { in: tickets.map((t) => t.id) }, active: true }, data: { active: false, revokedAt: new Date() } });
    return tickets;
  }

  /**
   * Validates a scanned QR token for an event and admits the holder at most once.
   * The VALID → USED change is a single conditional UPDATE, so two gates scanning the same
   * ticket at the same instant cannot both admit it. Every attempt is recorded.
   */
  async scan(input: {
    token: string; eventId: string; scannedById: string; deviceId?: string; gate?: string;
    offline?: boolean; scannedAt?: Date; clientScanId?: string;
  }): Promise<ScanOutcome> {
    if (input.clientScanId) {
      const dup = await this.prisma.ticketScan.findUnique({ where: { clientScanId: input.clientScanId }, include: { ticket: { include: { ticketCategory: true, event: true, order: { include: { brand: true } } } } } });
      if (dup) return { result: dup.result, admitted: dup.result === 'ADMITTED', message: MESSAGES[dup.result], ticket: dup.ticket ? this.view(dup.ticket) : undefined };
    }
    const scannedAt = input.scannedAt ?? new Date();
    const record = (result: ScanResult, ticketId: string | null) =>
      this.prisma.ticketScan.create({
        data: {
          ticketId, eventId: input.eventId, result, scannedById: input.scannedById, deviceId: input.deviceId, gate: input.gate,
          offline: input.offline ?? false, scannedAt, clientScanId: input.clientScanId,
        },
      });

    const qr = input.token.length <= 200 ? await this.prisma.ticketQrToken.findUnique({ where: { tokenHash: sha256(input.token.trim()) } }) : null;
    if (!qr) {
      await record('INVALID_TOKEN', null);
      return { result: 'INVALID_TOKEN', admitted: false, message: MESSAGES.INVALID_TOKEN };
    }
    const ticket = await this.prisma.ticket.findUniqueOrThrow({
      where: { id: qr.ticketId }, include: { ticketCategory: true, event: true, order: { include: { brand: true } } },
    });
    if (ticket.eventId !== input.eventId) {
      await record('WRONG_EVENT', ticket.id);
      return { result: 'WRONG_EVENT', admitted: false, message: `${MESSAGES.WRONG_EVENT} (${ticket.event.name})`, ticket: this.view(ticket) };
    }
    if (!qr.active) {
      await record('NOT_VALID', ticket.id);
      return { result: 'NOT_VALID', admitted: false, message: `Ticket is ${ticket.status.toLowerCase()}. Do not admit.`, ticket: this.view(ticket) };
    }

    const claimed = await this.prisma.ticket.updateMany({ where: { id: ticket.id, status: 'VALID' }, data: { status: 'USED', usedAt: scannedAt } });
    if (claimed.count === 1) {
      await record('ADMITTED', ticket.id);
      await this.prisma.ticketStatusHistory.create({
        data: { ticketId: ticket.id, fromStatus: 'VALID', toStatus: 'USED', reason: input.gate ? `Scanned at ${input.gate}` : 'Scanned', actorType: 'USER', actorId: input.scannedById },
      });
      return { result: 'ADMITTED', admitted: true, message: MESSAGES.ADMITTED, ticket: this.view({ ...ticket, status: 'USED' }) };
    }

    const current = await this.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    const first = await this.prisma.ticketScan.findFirst({ where: { ticketId: ticket.id, result: 'ADMITTED' }, orderBy: { scannedAt: 'asc' } });
    if (current.status === 'USED') {
      // An offline device admitted someone on a ticket that was already used elsewhere.
      const result: ScanResult = input.offline ? 'OFFLINE_CONFLICT' : 'ALREADY_USED';
      await record(result, ticket.id);
      if (input.offline) {
        await this.alerts.raise({
          type: 'OFFLINE_SCAN_CONFLICT', severity: 'WARNING', brandId: ticket.brandId, entityType: 'ticket', entityId: ticket.id,
          message: `Ticket ${ticket.reference} was admitted offline at ${scannedAt.toISOString()} but had already been used`,
        });
      }
      return { result, admitted: false, message: MESSAGES[result], ticket: this.view({ ...ticket, status: 'USED' }), firstScan: first ? { at: first.scannedAt, gate: first.gate } : null };
    }
    await record('NOT_VALID', ticket.id);
    return { result: 'NOT_VALID', admitted: false, message: `Ticket is ${current.status.toLowerCase()}. Do not admit.`, ticket: this.view({ ...ticket, status: current.status }) };
  }

  private view(t: { reference: string; holderName: string | null; status: TicketStatus; ticketCategory: { name: string }; event: { name: string }; order: { brand: { name: string } } }) {
    return { reference: t.reference, category: t.ticketCategory.name, holderName: t.holderName, status: t.status, brand: t.order.brand.name, event: t.event.name };
  }

  // ── Transfers ──

  /** Starts a transfer: the recipient receives a claim link; the ticket stays with the sender until it is accepted. */
  async startTransfer(ticketId: string, from: { customerId: string; brandId: string; name: string }, to: { email: string; name?: string }, siteUrl: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, customerId: from.customerId, brandId: from.brandId }, include: { event: { include: { venue: true } } },
    });
    if (!ticket) throw notFound('Ticket');
    if (ticket.status !== 'VALID') throw new AppError('TICKET_NOT_TRANSFERABLE', `A ${ticket.status.toLowerCase()} ticket cannot be transferred`, 409);
    if (ticket.event.startsAt < new Date()) throw new AppError('TICKET_NOT_TRANSFERABLE', 'The event has already started', 409);
    const token = randomToken(32);
    const expiresAt = new Date(Math.min(Date.now() + 72 * 3600_000, ticket.event.startsAt.getTime()));
    const transfer = await this.prisma.tx(async (tx) => {
      await tx.ticketTransfer.updateMany({ where: { ticketId, status: 'PENDING' }, data: { status: 'CANCELLED', completedAt: new Date() } });
      const tr = await tx.ticketTransfer.create({
        data: { ticketId, brandId: ticket.brandId, fromCustomerId: from.customerId, toEmail: normEmail(to.email), toName: to.name, claimTokenHash: sha256(token), expiresAt },
      });
      await this.notifications.enqueue({
        brandId: ticket.brandId, type: 'TICKET_TRANSFER', to: normEmail(to.email), toName: to.name,
        payload: {
          fromName: from.name, claimUrl: `${siteUrl}/transfers/claim?token=${token}`, expiresAt: formatWhen(expiresAt, ticket.event.timezone),
          event: { name: ticket.event.name, when: formatWhen(ticket.event.startsAt, ticket.event.timezone), venue: ticket.event.venue ? `${ticket.event.venue.name}, ${ticket.event.venue.city}` : '' },
        },
        dedupeKey: `transfer:${tr.id}`,
      }, tx);
      return tr;
    });
    await this.notifications.kick();
    return { id: transfer.id, status: transfer.status, toEmail: transfer.toEmail, expiresAt };
  }

  /**
   * Completes a transfer. The original ticket becomes TRANSFERRED and its QR dies; the
   * recipient gets a new ticket with a new QR token. Inventory is unaffected.
   */
  async claimTransfer(token: string, brandId: string, resolveRecipient: (tx: Tx, email: string, name: string) => Promise<{ customerId: string }>) {
    const result = await this.prisma.tx(async (tx) => {
      const tr = await tx.ticketTransfer.findUnique({ where: { claimTokenHash: sha256(token) }, include: { ticket: true } });
      if (!tr || tr.brandId !== brandId || tr.status !== 'PENDING' || tr.expiresAt < new Date()) {
        throw new AppError('TRANSFER_INVALID', 'This transfer link is invalid or has expired', 400);
      }
      const claimed = await tx.ticket.updateMany({ where: { id: tr.ticketId, status: 'VALID' }, data: { status: 'TRANSFERRED' } });
      if (claimed.count !== 1) throw new AppError('TICKET_NOT_TRANSFERABLE', 'This ticket can no longer be transferred', 409);
      await tx.ticketQrToken.updateMany({ where: { ticketId: tr.ticketId, active: true }, data: { active: false, revokedAt: new Date() } });
      await tx.ticketStatusHistory.create({ data: { ticketId: tr.ticketId, fromStatus: 'VALID', toStatus: 'TRANSFERRED', reason: `Transferred to ${tr.toEmail}`, actorType: 'CUSTOMER', actorId: tr.fromCustomerId } });

      const recipient = await resolveRecipient(tx, tr.toEmail, tr.toName ?? tr.toEmail);
      const old = tr.ticket;
      const fresh = await tx.ticket.create({
        data: {
          reference: reference('TKT', 12), orderId: old.orderId, orderItemId: old.orderItemId, eventId: old.eventId, ticketCategoryId: old.ticketCategoryId,
          brandId: old.brandId, customerId: recipient.customerId, holderName: tr.toName ?? null, holderEmail: tr.toEmail,
          history: { create: { toStatus: 'VALID', reason: `Received by transfer from ticket ${old.reference}`, actorType: 'SYSTEM' } },
        },
      });
      await this.newQrToken(tx, fresh.id);
      await tx.ticketTransfer.update({ where: { id: tr.id }, data: { status: 'ACCEPTED', completedAt: new Date(), toCustomerId: recipient.customerId } });
      return { ticketId: fresh.id, reference: fresh.reference };
    });
    return result;
  }
}
