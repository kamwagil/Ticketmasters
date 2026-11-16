import { Injectable } from '@nestjs/common';
import { InventoryMovementType, Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import { AlertService, PrismaService, Tx } from '../../common/infra';

export interface ReserveLine {
  ticketCategoryId: string;
  quantity: number;
}
interface Counters {
  total: number;
  sold: number;
  reserved: number;
}

/**
 * The single authority for ticket availability across every storefront.
 *
 * Each ticket category has exactly one `ticket_inventory` row. Every change is a single
 * conditional UPDATE (`... WHERE total - sold - reserved >= qty`), which PostgreSQL executes
 * under a row lock: concurrent checkouts from different storefronts queue on that row and
 * each sees the committed result of the previous one. A CHECK constraint
 * (sold + reserved <= total) backs this up, so overselling is impossible even if
 * application code were wrong. Nothing here reads from a cache.
 */
@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService, private alerts: AlertService) {}

  private move(
    tx: Tx, ticketCategoryId: string, type: InventoryMovementType, quantity: number,
    d: { total?: number; sold?: number; reserved?: number },
    ctx: { orderId?: string | null; brandId?: string | null; actorId?: string | null; note?: string },
  ) {
    return tx.inventoryMovement.create({
      data: {
        ticketCategoryId, type, quantity, deltaTotal: d.total ?? 0, deltaSold: d.sold ?? 0, deltaReserved: d.reserved ?? 0,
        orderId: ctx.orderId ?? null, brandId: ctx.brandId ?? null, actorId: ctx.actorId ?? null, note: ctx.note,
      },
    });
  }

  /** Creates the inventory row for a new ticket category. */
  async initialise(tx: Tx, ticketCategoryId: string, total: number, actorId?: string) {
    await tx.ticketInventory.create({ data: { ticketCategoryId, total } });
    if (total > 0) await this.move(tx, ticketCategoryId, 'INITIAL', total, { total }, { actorId });
  }

  /**
   * Atomically holds tickets for an order. Lines are processed in a stable order so two
   * multi-category checkouts can never deadlock. Throws INSUFFICIENT_INVENTORY (and the
   * caller's transaction rolls back) if any line cannot be satisfied in full.
   */
  async reserve(tx: Tx, lines: ReserveLine[], ctx: { orderId: string; brandId: string; expiresAt: Date }) {
    const sorted = [...lines].sort((a, b) => a.ticketCategoryId.localeCompare(b.ticketCategoryId));
    for (const line of sorted) {
      const rows = await tx.$queryRaw<Counters[]>`
        UPDATE "ticket_inventory"
           SET "reserved" = "reserved" + ${line.quantity}, "updatedAt" = now()
         WHERE "ticketCategoryId" = ${line.ticketCategoryId}::uuid
           AND "total" - "sold" - "reserved" >= ${line.quantity}
        RETURNING "total", "sold", "reserved"`;
      if (rows.length === 0) {
        const current = await tx.ticketInventory.findUnique({ where: { ticketCategoryId: line.ticketCategoryId } });
        const available = current ? current.total - current.sold - current.reserved : 0;
        throw new AppError('INSUFFICIENT_INVENTORY', available > 0 ? `Only ${available} ticket(s) left` : 'These tickets are no longer available', 409, {
          ticketCategoryId: line.ticketCategoryId, requested: line.quantity, available,
        });
      }
      await tx.inventoryReservation.create({
        data: { ticketCategoryId: line.ticketCategoryId, orderId: ctx.orderId, brandId: ctx.brandId, quantity: line.quantity, expiresAt: ctx.expiresAt },
      });
      await this.move(tx, line.ticketCategoryId, 'RESERVE', line.quantity, { reserved: line.quantity }, ctx);
    }
  }

  /**
   * Converts an order's active reservations into sales (payment verified).
   * @returns false when the order holds no active reservation (it expired or was released).
   */
  async confirm(tx: Tx, orderId: string, brandId: string): Promise<boolean> {
    const claimed = await tx.$queryRaw<{ ticketCategoryId: string; quantity: number }[]>`
      UPDATE "inventory_reservations"
         SET "status" = 'CONFIRMED', "resolvedAt" = now()
       WHERE "orderId" = ${orderId}::uuid AND "status" = 'ACTIVE'
      RETURNING "ticketCategoryId", "quantity"`;
    if (claimed.length === 0) return false;
    for (const r of claimed.sort((a, b) => a.ticketCategoryId.localeCompare(b.ticketCategoryId))) {
      await tx.$executeRaw`
        UPDATE "ticket_inventory"
           SET "reserved" = "reserved" - ${r.quantity}, "sold" = "sold" + ${r.quantity}, "updatedAt" = now()
         WHERE "ticketCategoryId" = ${r.ticketCategoryId}::uuid`;
      await this.move(tx, r.ticketCategoryId, 'CONFIRM', r.quantity, { reserved: -r.quantity, sold: r.quantity }, { orderId, brandId });
    }
    return true;
  }

  /**
   * A verified payment arrived after its reservation lapsed. Tries to take the tickets
   * straight from free stock; all lines or nothing.
   * @returns false if stock is no longer available (the caller must refund, never oversell).
   */
  async allocateLate(tx: Tx, lines: ReserveLine[], ctx: { orderId: string; brandId: string }): Promise<boolean> {
    const sorted = [...lines].sort((a, b) => a.ticketCategoryId.localeCompare(b.ticketCategoryId));
    const taken: ReserveLine[] = [];
    for (const line of sorted) {
      const n = await tx.$executeRaw`
        UPDATE "ticket_inventory"
           SET "sold" = "sold" + ${line.quantity}, "updatedAt" = now()
         WHERE "ticketCategoryId" = ${line.ticketCategoryId}::uuid
           AND "total" - "sold" - "reserved" >= ${line.quantity}`;
      if (n !== 1) {
        for (const t of taken) {
          await tx.$executeRaw`UPDATE "ticket_inventory" SET "sold" = "sold" - ${t.quantity}, "updatedAt" = now() WHERE "ticketCategoryId" = ${t.ticketCategoryId}::uuid`;
        }
        return false;
      }
      taken.push(line);
    }
    for (const t of taken) await this.move(tx, t.ticketCategoryId, 'LATE_PAYMENT_ALLOCATION', t.quantity, { sold: t.quantity }, ctx);
    return true;
  }

  /** Returns an order's held tickets to free stock (cancelled, failed or expired checkout). */
  async release(tx: Tx, orderId: string, brandId: string, reason: 'RELEASE' | 'EXPIRE'): Promise<number> {
    const status = reason === 'EXPIRE' ? 'EXPIRED' : 'RELEASED';
    const claimed = await tx.$queryRaw<{ ticketCategoryId: string; quantity: number }[]>`
      UPDATE "inventory_reservations"
         SET "status" = ${status}::"ReservationStatus", "resolvedAt" = now()
       WHERE "orderId" = ${orderId}::uuid AND "status" = 'ACTIVE'
      RETURNING "ticketCategoryId", "quantity"`;
    let released = 0;
    for (const r of claimed.sort((a, b) => a.ticketCategoryId.localeCompare(b.ticketCategoryId))) {
      await tx.$executeRaw`
        UPDATE "ticket_inventory" SET "reserved" = "reserved" - ${r.quantity}, "updatedAt" = now()
         WHERE "ticketCategoryId" = ${r.ticketCategoryId}::uuid`;
      await this.move(tx, r.ticketCategoryId, reason, r.quantity, { reserved: -r.quantity }, { orderId, brandId });
      released += r.quantity;
    }
    return released;
  }

  /** Puts refunded tickets back on sale. */
  async returnSold(tx: Tx, ticketCategoryId: string, quantity: number, ctx: { orderId: string; brandId: string; actorId?: string | null }) {
    await tx.$executeRaw`
      UPDATE "ticket_inventory" SET "sold" = "sold" - ${quantity}, "updatedAt" = now()
       WHERE "ticketCategoryId" = ${ticketCategoryId}::uuid`;
    await this.move(tx, ticketCategoryId, 'REFUND_RETURN', quantity, { sold: -quantity }, ctx);
  }

  /** Changes total capacity. Refused if it would drop below what is already sold or held. */
  async setTotal(tx: Tx, ticketCategoryId: string, newTotal: number, actorId: string, note?: string) {
    const rows = await tx.$queryRaw<{ old: number }[]>`
      UPDATE "ticket_inventory" t
         SET "total" = ${newTotal}, "updatedAt" = now()
        FROM (SELECT "total" AS old FROM "ticket_inventory" WHERE "ticketCategoryId" = ${ticketCategoryId}::uuid FOR UPDATE) o
       WHERE t."ticketCategoryId" = ${ticketCategoryId}::uuid AND t."sold" + t."reserved" <= ${newTotal}
      RETURNING o.old`;
    if (rows.length === 0) {
      throw new AppError('INVENTORY_BELOW_COMMITTED', 'Total cannot be lower than tickets already sold or reserved', 409);
    }
    const delta = newTotal - rows[0].old;
    if (delta !== 0) await this.move(tx, ticketCategoryId, 'ADJUSTMENT', Math.abs(delta), { total: delta }, { actorId, note });
    return { total: newTotal, delta };
  }

  /** Live availability straight from the database. */
  async availability(ticketCategoryIds: string[], db: Tx | PrismaService = this.prisma) {
    const rows = await db.ticketInventory.findMany({ where: { ticketCategoryId: { in: ticketCategoryIds } } });
    return new Map(rows.map((r) => [r.ticketCategoryId, { total: r.total, sold: r.sold, reserved: r.reserved, available: r.total - r.sold - r.reserved }]));
  }

  /**
   * Cross-checks the counters against the movement ledger, active reservations and issued
   * tickets. Any difference raises a CRITICAL alert; counters are never silently "fixed".
   */
  async reconcile(eventId?: string) {
    const filter = eventId ? Prisma.sql`WHERE c."eventId" = ${eventId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { ticketCategoryId: string; eventId: string; name: string; total: number; sold: number; reserved: number; mTotal: number; mSold: number; mReserved: number; activeReserved: number; liveTickets: number }[]
    >`
      SELECT i."ticketCategoryId", c."eventId", c."name", i."total", i."sold", i."reserved",
             COALESCE(m."mTotal", 0)::int AS "mTotal", COALESCE(m."mSold", 0)::int AS "mSold", COALESCE(m."mReserved", 0)::int AS "mReserved",
             COALESCE(r."activeReserved", 0)::int AS "activeReserved", COALESCE(t."liveTickets", 0)::int AS "liveTickets"
        FROM "ticket_inventory" i
        JOIN "ticket_categories" c ON c."id" = i."ticketCategoryId"
        LEFT JOIN (SELECT "ticketCategoryId", SUM("deltaTotal") AS "mTotal", SUM("deltaSold") AS "mSold", SUM("deltaReserved") AS "mReserved"
                     FROM "inventory_movements" GROUP BY 1) m ON m."ticketCategoryId" = i."ticketCategoryId"
        LEFT JOIN (SELECT "ticketCategoryId", SUM("quantity") AS "activeReserved"
                     FROM "inventory_reservations" WHERE "status" = 'ACTIVE' GROUP BY 1) r ON r."ticketCategoryId" = i."ticketCategoryId"
        LEFT JOIN (SELECT "ticketCategoryId", COUNT(*) AS "liveTickets"
                     FROM "tickets" WHERE "status" IN ('VALID', 'USED') GROUP BY 1) t ON t."ticketCategoryId" = i."ticketCategoryId"
        ${filter}`;

    const issues: { ticketCategoryId: string; eventId: string; name: string; problem: string }[] = [];
    for (const r of rows) {
      const add = (problem: string) => issues.push({ ticketCategoryId: r.ticketCategoryId, eventId: r.eventId, name: r.name, problem });
      if (r.total !== r.mTotal) add(`total ${r.total} differs from movement ledger ${r.mTotal}`);
      if (r.sold !== r.mSold) add(`sold ${r.sold} differs from movement ledger ${r.mSold}`);
      if (r.reserved !== r.mReserved) add(`reserved ${r.reserved} differs from movement ledger ${r.mReserved}`);
      if (r.reserved !== r.activeReserved) add(`reserved ${r.reserved} differs from active reservations ${r.activeReserved}`);
      if (r.liveTickets > r.sold) add(`${r.liveTickets} live tickets exceed sold counter ${r.sold}`);
      if (r.liveTickets > r.total) add(`${r.liveTickets} live tickets exceed capacity ${r.total}`);
    }
    for (const i of issues) {
      await this.alerts.raise({
        type: 'INVENTORY_INCONSISTENCY', severity: 'CRITICAL', entityType: 'ticket_category', entityId: i.ticketCategoryId,
        message: `Inventory inconsistency on "${i.name}": ${i.problem}`, dedupeKey: `inv:${i.ticketCategoryId}:${i.problem.split(' ')[0]}`,
      });
    }
    return { checked: rows.length, issues };
  }
}
