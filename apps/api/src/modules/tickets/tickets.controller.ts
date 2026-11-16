import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { assertEventAccess, brandWhere, CurrentStaff, Permissions, RateLimit, RateLimitGuard, Staff, StaffGuard } from '../../common/auth';
import { AppError, notFound } from '../../common/errors';
import { AuditService, PrismaService } from '../../common/infra';
import { dateRange, paged, PageQuery, paging } from '../../common/util';
import { CatalogService } from '../catalog/catalog.service';
import { TicketDocumentService } from './ticket-document.service';
import { TicketService } from './ticket.service';

class TicketQuery extends PageQuery {
  @IsOptional() @IsIn(['VALID', 'USED', 'CANCELLED', 'REFUNDED', 'REVOKED', 'TRANSFERRED']) status?: string;
  @IsOptional() @IsUUID() eventId?: string;
}
class ScanQuery extends PageQuery {
  @IsOptional() @IsUUID() eventId?: string;
  @IsOptional() @IsIn(['ADMITTED', 'ALREADY_USED', 'INVALID_TOKEN', 'WRONG_EVENT', 'NOT_VALID', 'OFFLINE_CONFLICT']) result?: string;
}
class RevokeDto {
  @IsString() @MinLength(5) @MaxLength(300) reason: string;
}
class ScanDto {
  @IsUUID() eventId: string;
  /** The exact text encoded in the ticket QR code. */
  @IsString() @MinLength(8) @MaxLength(200) token: string;
  @IsOptional() @IsString() @MaxLength(80) deviceId?: string;
  @IsOptional() @IsString() @MaxLength(60) gate?: string;
}
class OfflineScanDto {
  /** Unique id generated on the device, so a re-sent batch never counts a scan twice. */
  @IsString() @MinLength(8) @MaxLength(80) clientScanId: string;
  @IsString() @MinLength(8) @MaxLength(200) token: string;
  @IsISO8601() scannedAt: string;
  @IsOptional() @IsString() @MaxLength(60) gate?: string;
}
class SyncDto {
  @IsUUID() eventId: string;
  @IsOptional() @IsString() @MaxLength(80) deviceId?: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => OfflineScanDto) scans: OfflineScanDto[];
}

@ApiTags('Admin · Tickets')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class TicketsController {
  constructor(private prisma: PrismaService, private tickets: TicketService, private docs: TicketDocumentService, private audit: AuditService) {}

  private scope(staff: Staff, brandId?: string): Prisma.TicketWhereInput {
    return { ...brandWhere(staff, brandId), ...(staff.eventScoped ? { eventId: { in: staff.eventIds } } : {}) };
  }

  @Get('tickets')
  @Permissions('tickets.read')
  async list(@CurrentStaff() staff: Staff, @Query() q: TicketQuery) {
    const term = q.q?.trim();
    const where: Prisma.TicketWhereInput = {
      ...this.scope(staff, q.brandId),
      ...(q.status ? { status: q.status as any } : {}),
      ...(q.eventId ? { eventId: q.eventId } : {}),
      ...(dateRange(q) ? { issuedAt: dateRange(q) } : {}),
      ...(term ? { OR: [{ reference: { contains: term.toUpperCase() } }, { holderEmail: { contains: term.toLowerCase() } }, { holderName: { contains: term, mode: 'insensitive' } }, { order: { reference: { contains: term.toUpperCase() } } }] } : {}),
    };
    const { skip, take } = paging(q);
    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where, orderBy: { issuedAt: 'desc' }, skip, take,
        include: { event: { select: { id: true, name: true, startsAt: true } }, ticketCategory: { select: { name: true } }, order: { select: { id: true, reference: true, brand: { select: { id: true, name: true, primaryColor: true } } } } },
      }),
      this.prisma.ticket.count({ where }),
    ]);
    return paged(items, total, q);
  }

  /** Ticket with its full status history, scans and transfers. The QR token itself is never returned to the admin API. */
  @Get('tickets/:id')
  @Permissions('tickets.read')
  async get(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, ...this.scope(staff) },
      include: {
        event: { select: { id: true, name: true, startsAt: true, timezone: true, venue: { select: { name: true, city: true } } } },
        ticketCategory: { select: { name: true } },
        order: { select: { id: true, reference: true, customerName: true, customerEmail: true, brand: { select: { id: true, name: true, primaryColor: true } } } },
        history: { orderBy: { createdAt: 'asc' } },
        scans: { orderBy: { receivedAt: 'desc' }, take: 50 },
        transfers: { orderBy: { createdAt: 'desc' }, select: { id: true, toEmail: true, toName: true, status: true, createdAt: true, completedAt: true, expiresAt: true } },
      },
    });
    if (!ticket) throw notFound('Ticket');
    return ticket;
  }

  /** Download the ticket PDF (for support staff assisting a customer). Audited. */
  @Get('tickets/:id/pdf')
  @Permissions('tickets.manage')
  async pdf(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, ...this.scope(staff) } });
    if (!ticket) throw notFound('Ticket');
    const doc = await this.docs.render(id);
    if (!doc) throw notFound('Ticket');
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: ticket.brandId, action: 'ticket.download', entityType: 'ticket', entityId: id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.send(doc.content);
  }

  /** Revokes a ticket without a refund (fraud, chargeback, policy breach). Its QR code stops working immediately. */
  @Post('tickets/:id/revoke')
  @HttpCode(200)
  @Permissions('tickets.manage')
  async revoke(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RevokeDto) {
    const ticket = await this.prisma.ticket.findFirst({ where: { id, ...this.scope(staff) } });
    if (!ticket) throw notFound('Ticket');
    const changed = await this.prisma.tx((tx) => this.tickets.invalidate(tx, [id], 'REVOKED', dto.reason, { type: 'USER', id: staff.userId }));
    if (!changed.length) throw new AppError('TICKET_STATE', `A ${ticket.status.toLowerCase()} ticket cannot be revoked`, 409);
    await this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId: ticket.brandId, action: 'ticket.revoke', entityType: 'ticket', entityId: id, before: { status: ticket.status }, after: { status: 'REVOKED', reason: dto.reason } });
    return { id, status: 'REVOKED' };
  }

  /** Scan log across events in scope. */
  @Get('ticket-scans')
  @Permissions('tickets.read')
  async scans(@CurrentStaff() staff: Staff, @Query() q: ScanQuery) {
    const scope = this.scope(staff, q.brandId);
    const where: Prisma.TicketScanWhereInput = {
      ...(q.eventId ? { eventId: q.eventId } : {}),
      ...(staff.eventScoped ? { eventId: q.eventId ? (staff.eventIds.includes(q.eventId) ? q.eventId : '00000000-0000-0000-0000-000000000000') : { in: staff.eventIds } } : {}),
      ...(q.result ? { result: q.result as any } : {}),
      ...(dateRange(q) ? { receivedAt: dateRange(q) } : {}),
      // Unresolved tokens have no ticket, hence no brand: only platform staff see those.
      ...(staff.allBrands && !q.brandId ? {} : { ticket: { is: scope } }),
    };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.ticketScan.findMany({ where, orderBy: { receivedAt: 'desc' }, skip, take, include: { ticket: { select: { id: true, reference: true, holderName: true, brandId: true, ticketCategory: { select: { name: true } } } } } }),
      this.prisma.ticketScan.count({ where }),
    ]);
    const [users, events] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.scannedById))] } }, select: { id: true, fullName: true } }),
      this.prisma.event.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.eventId))] } }, select: { id: true, name: true } }),
    ]);
    return paged(rows.map((r) => ({ ...r, scannedBy: users.find((u) => u.id === r.scannedById)?.fullName ?? null, event: events.find((e) => e.id === r.eventId)?.name ?? null })), total, q);
  }
}

/**
 * Central scanning service used by the mobile scanner at every venue. A ticket bought on
 * any storefront is validated here against the one ticket database.
 */
@ApiTags('Scanner')
@ApiBearerAuth()
@Controller('v1/scanner')
@UseGuards(StaffGuard, RateLimitGuard)
@Permissions('tickets.scan')
export class ScannerController {
  constructor(private prisma: PrismaService, private tickets: TicketService, private catalog: CatalogService) {}

  /** A scanner may work an event if it is within their brand scope and, for event-scoped roles, assigned to them. */
  private async authorise(staff: Staff, eventId: string) {
    assertEventAccess(staff, eventId);
    const event = await this.prisma.event.findFirst({ where: { id: eventId, ...this.catalog.eventVisibility(staff) }, include: { venue: { select: { name: true, city: true } } } });
    if (!event) throw notFound('Event');
    return event;
  }

  /** Events this user is authorised to scan (recent and upcoming). */
  @Get('events')
  async events(@CurrentStaff() staff: Staff) {
    const events = await this.prisma.event.findMany({
      where: {
        ...this.catalog.eventVisibility(staff),
        status: { in: ['PUBLISHED', 'POSTPONED', 'COMPLETED'] },
        startsAt: { gte: new Date(Date.now() - 2 * 86400_000), lte: new Date(Date.now() + 60 * 86400_000) },
      },
      select: { id: true, name: true, startsAt: true, timezone: true, status: true, venue: { select: { name: true, city: true } } },
      orderBy: { startsAt: 'asc' }, take: 100,
    });
    return events;
  }

  /** Validates one QR code and admits the holder if the ticket is valid and unused. */
  @Post('scan')
  @HttpCode(200)
  @RateLimit({ limit: 600, windowSec: 60 })
  async scan(@CurrentStaff() staff: Staff, @Body() dto: ScanDto) {
    await this.authorise(staff, dto.eventId);
    return this.tickets.scan({ token: dto.token, eventId: dto.eventId, scannedById: staff.userId, deviceId: dto.deviceId, gate: dto.gate });
  }

  /** Live admission counters for an event. */
  @Get('events/:eventId/stats')
  async stats(@CurrentStaff() staff: Staff, @Param('eventId', ParseUUIDPipe) eventId: string) {
    const event = await this.authorise(staff, eventId);
    const [byStatus, byCategory, results] = await Promise.all([
      this.prisma.ticket.groupBy({ by: ['status'], where: { eventId }, _count: true }),
      this.prisma.ticket.groupBy({ by: ['ticketCategoryId', 'status'], where: { eventId, status: { in: ['VALID', 'USED'] } }, _count: true }),
      this.prisma.ticketScan.groupBy({ by: ['result'], where: { eventId }, _count: true }),
    ]);
    const cats = await this.prisma.ticketCategory.findMany({ where: { eventId }, select: { id: true, name: true } });
    const n = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;
    return {
      event: { id: event.id, name: event.name, startsAt: event.startsAt, venue: event.venue },
      admitted: n('USED'), remaining: n('VALID'), expected: n('USED') + n('VALID'),
      byCategory: cats.map((c) => ({
        name: c.name,
        admitted: byCategory.find((b) => b.ticketCategoryId === c.id && b.status === 'USED')?._count ?? 0,
        remaining: byCategory.find((b) => b.ticketCategoryId === c.id && b.status === 'VALID')?._count ?? 0,
      })),
      scanResults: Object.fromEntries(results.map((r) => [r.result, r._count])),
    };
  }

  /** This user's recent scans for the event (the scanning session history). */
  @Get('events/:eventId/history')
  async history(@CurrentStaff() staff: Staff, @Param('eventId', ParseUUIDPipe) eventId: string) {
    await this.authorise(staff, eventId);
    const rows = await this.prisma.ticketScan.findMany({
      where: { eventId, scannedById: staff.userId }, orderBy: { receivedAt: 'desc' }, take: 100,
      include: { ticket: { select: { reference: true, holderName: true, ticketCategory: { select: { name: true } } } } },
    });
    return rows.map((r) => ({ id: r.id, result: r.result, scannedAt: r.scannedAt, gate: r.gate, offline: r.offline, reference: r.ticket?.reference ?? null, holderName: r.ticket?.holderName ?? null, category: r.ticket?.ticketCategory.name ?? null }));
  }

  /**
   * Offline manifest: SHA-256 hashes of the event's live QR tokens with their status.
   * A device can check a scanned code offline by hashing it; the hashes cannot be turned back
   * into working QR codes. Limitations (shown to staff in the scanner): a device working
   * offline cannot see scans made at other gates, nor refunds made after the download.
   */
  @Get('events/:eventId/manifest')
  @RateLimit({ limit: 12, windowSec: 60 })
  async manifest(@CurrentStaff() staff: Staff, @Param('eventId', ParseUUIDPipe) eventId: string) {
    const event = await this.authorise(staff, eventId);
    const rows = await this.prisma.$queryRaw<{ h: string; r: string; c: string; s: string; n: string | null }[]>`
      SELECT q."tokenHash" AS h, t."reference" AS r, c."name" AS c, t."status"::text AS s, t."holderName" AS n
        FROM "tickets" t
        JOIN "ticket_qr_tokens" q ON q."ticketId" = t."id" AND q."active"
        JOIN "ticket_categories" c ON c."id" = t."ticketCategoryId"
       WHERE t."eventId" = ${eventId}::uuid AND t."status" IN ('VALID', 'USED')`;
    return { eventId, eventName: event.name, generatedAt: new Date(), hashAlgorithm: 'SHA-256 (hex) of the QR text', tickets: rows };
  }

  /**
   * Uploads scans made while offline. Each is applied in the order it happened; if a ticket
   * turns out to have been used already (another gate, or another offline device), the scan is
   * recorded as OFFLINE_CONFLICT and an alert is raised so the duplicate entry can be reviewed.
   */
  @Post('sync')
  @HttpCode(200)
  async sync(@CurrentStaff() staff: Staff, @Body() dto: SyncDto) {
    await this.authorise(staff, dto.eventId);
    const ordered = [...dto.scans].sort((a, b) => a.scannedAt.localeCompare(b.scannedAt));
    const results = [];
    for (const s of ordered) {
      const scannedAt = new Date(s.scannedAt);
      // Device clocks can be wrong; never accept a scan time in the future.
      const safeTime = scannedAt.getTime() > Date.now() ? new Date() : scannedAt;
      const outcome = await this.tickets.scan({
        token: s.token, eventId: dto.eventId, scannedById: staff.userId, deviceId: dto.deviceId, gate: s.gate, offline: true, scannedAt: safeTime, clientScanId: s.clientScanId,
      });
      results.push({ clientScanId: s.clientScanId, result: outcome.result, reference: outcome.ticket?.reference ?? null });
    }
    return { synced: results.length, conflicts: results.filter((r) => r.result === 'OFFLINE_CONFLICT').length, results };
  }
}
