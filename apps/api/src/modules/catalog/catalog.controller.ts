import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { assertBrandAccess, assertPlatformWide, CurrentStaff, Permissions, Staff, StaffGuard } from '../../common/auth';
import { AppError, forbidden, notFound } from '../../common/errors';
import { AuditService, PrismaService, RedisService } from '../../common/infra';
import { StorageService } from '../../common/storage';
import { formatWhen, paged, PageQuery, paging } from '../../common/util';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationService } from '../notifications/notification.service';
import { CatalogService } from './catalog.service';

const CUR = /^[A-Z]{3}$/;
const d = (v?: string | null) => (v === undefined ? undefined : v === null ? null : new Date(v));

class VenueDto {
  @IsString() @MinLength(2) name: string;
  @IsString() @MinLength(2) city: string;
  @IsString() @MinLength(2) country: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsInt() @Min(0) capacity?: number;
  @IsOptional() @IsString() timezone?: string;
}
class PerformerDto {
  @IsString() @MinLength(1) name: string;
  @IsOptional() @IsIn(['ARTIST', 'TEAM', 'SPEAKER']) type?: string;
  @IsOptional() @IsString() bio?: string;
  @IsOptional() @IsString() imageUrl?: string;
}
class CategoryDto {
  @IsString() @Matches(/^[a-z0-9-]{2,40}$/) slug: string;
  @IsString() @MinLength(2) name: string;
}
class EventDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9][a-z0-9-]{2,80}$/) slug?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() venueId?: string;
  @IsOptional() @IsUUID() organizerId?: string;
  /** Owning brand. Omit for a platform-managed master event. */
  @IsOptional() @IsUUID() ownerBrandId?: string;
  @IsOptional() @IsString() posterUrl?: string;
  @IsISO8601() startsAt: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsOptional() @IsISO8601() doorsAt?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() policies?: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) performerIds?: string[];
}
class UpdateEventDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() venueId?: string;
  @IsOptional() @IsUUID() organizerId?: string;
  @IsOptional() @IsString() posterUrl?: string;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsOptional() @IsISO8601() doorsAt?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() policies?: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsUUID('all', { each: true }) performerIds?: string[];
}
class EventStatusDto {
  @IsIn(['publish', 'unpublish', 'schedule', 'cancel', 'postpone', 'archive', 'complete']) action: string;
  /** Required for schedule. */
  @IsOptional() @IsISO8601() publishAt?: string;
  /** Required for postpone. */
  @IsOptional() @IsISO8601() newStartsAt?: string;
  @IsOptional() @IsISO8601() newEndsAt?: string;
  @IsOptional() @IsString() reason?: string;
  /** Email ticket holders about a cancellation or postponement. Defaults to true. */
  @IsOptional() @IsBoolean() notifyCustomers?: boolean;
}
class PriceOverrideDto {
  @IsUUID() ticketCategoryId: string;
  @IsInt() @Min(0) priceMinor: number;
}
class PublicationDto {
  @IsOptional() @IsBoolean() visible?: boolean;
  @IsOptional() @IsBoolean() featured?: boolean;
  @IsOptional() @IsString() customTitle?: string | null;
  @IsOptional() @IsString() customDescription?: string | null;
  @IsOptional() @IsString() promoImageUrl?: string | null;
  @IsOptional() @IsISO8601() salesStartAt?: string | null;
  @IsOptional() @IsISO8601() salesEndAt?: string | null;
  /** Brand-specific selling prices. Only where contractually permitted: platform or owning-brand staff only. */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PriceOverrideDto) priceOverrides?: PriceOverrideDto[];
}
class ImageDto {
  @IsString() url: string;
  @IsOptional() @IsIn(['POSTER', 'GALLERY', 'PROMO']) kind?: string;
  @IsOptional() @IsUUID() brandId?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}
class TicketCategoryDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsString() description?: string;
  @IsInt() @Min(0) priceMinor: number;
  @Matches(CUR) currency: string;
  @IsInt() @Min(0) totalQuantity: number;
  @IsOptional() @IsISO8601() salesStartAt?: string;
  @IsOptional() @IsISO8601() salesEndAt?: string;
  @IsOptional() @IsInt() @Min(1) minPerOrder?: number;
  @IsOptional() @IsInt() @Min(1) maxPerOrder?: number;
  @IsOptional() @IsIn(['E_TICKET', 'WILL_CALL']) deliveryMethod?: 'E_TICKET' | 'WILL_CALL';
  @IsOptional() @IsInt() sortOrder?: number;
}
class UpdateTicketCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() @Min(0) priceMinor?: number;
  @IsOptional() @IsISO8601() salesStartAt?: string | null;
  @IsOptional() @IsISO8601() salesEndAt?: string | null;
  @IsOptional() @IsInt() @Min(1) minPerOrder?: number;
  @IsOptional() @IsInt() @Min(1) maxPerOrder?: number;
  @IsOptional() @IsIn(['ACTIVE', 'PAUSED', 'SOLD_OUT', 'CLOSED']) status?: 'ACTIVE' | 'PAUSED' | 'SOLD_OUT' | 'CLOSED';
  @IsOptional() @IsInt() sortOrder?: number;
}
class AdjustInventoryDto {
  @IsInt() @Min(0) total: number;
  @IsString() @MinLength(3) note: string;
}
class EventQuery extends PageQuery {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() organizerId?: string;
}

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

@ApiTags('Admin · Events & Inventory')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class CatalogController {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private catalog: CatalogService,
    private inventory: InventoryService,
    private notifications: NotificationService,
    private storage: StorageService,
    private redis: RedisService,
  ) {}

  private log(staff: Staff, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown, brandId?: string | null) {
    return this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId, action, entityType, entityId, before, after });
  }
  private bust() {
    return this.redis.invalidate('sf:events:');
  }

  // ── Reference data (shared across brands; managed by platform staff) ──

  @Get('venues') @Permissions('events.read')
  venues() { return this.prisma.venue.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } }); }

  @Post('venues') @Permissions('events.manage')
  async createVenue(@CurrentStaff() staff: Staff, @Body() dto: VenueDto) {
    const v = await this.prisma.venue.create({ data: dto });
    await this.log(staff, 'venue.create', 'venue', v.id, undefined, v);
    return v;
  }

  @Patch('venues/:id') @Permissions('events.manage')
  async updateVenue(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VenueDto) {
    assertPlatformWide(staff);
    const v = await this.prisma.venue.update({ where: { id }, data: dto });
    await this.log(staff, 'venue.update', 'venue', id, undefined, dto);
    return v;
  }

  @Delete('venues/:id') @Permissions('events.manage')
  async deleteVenue(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    assertPlatformWide(staff);
    await this.prisma.venue.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.log(staff, 'venue.delete', 'venue', id);
    return { ok: true };
  }

  @Get('performers') @Permissions('events.read')
  performers() { return this.prisma.performer.findMany({ orderBy: { name: 'asc' } }); }

  @Post('performers') @Permissions('events.manage')
  async createPerformer(@CurrentStaff() staff: Staff, @Body() dto: PerformerDto) {
    const p = await this.prisma.performer.create({ data: dto });
    await this.log(staff, 'performer.create', 'performer', p.id, undefined, p);
    return p;
  }

  @Patch('performers/:id') @Permissions('events.manage')
  async updatePerformer(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PerformerDto) {
    assertPlatformWide(staff);
    return this.prisma.performer.update({ where: { id }, data: dto });
  }

  @Get('event-categories') @Permissions('events.read')
  categories() { return this.prisma.eventCategory.findMany({ orderBy: { name: 'asc' } }); }

  @Post('event-categories') @Permissions('events.manage')
  async createCategory(@CurrentStaff() staff: Staff, @Body() dto: CategoryDto) {
    assertPlatformWide(staff);
    const c = await this.prisma.eventCategory.create({ data: dto });
    await this.log(staff, 'event_category.create', 'event_category', c.id, undefined, c);
    return c;
  }

  /** Stores an image and returns its URL. Type is verified from the file contents. */
  @Post('uploads/image')
  @Permissions('events.manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer) throw new AppError('FILE_REQUIRED', 'Attach an image in the "file" field', 400);
    return this.storage.saveImage(file.buffer, 'events');
  }

  // ── Events ──

  @Get('events')
  @Permissions('events.read')
  async events(@CurrentStaff() staff: Staff, @Query() q: EventQuery) {
    const where = {
      ...this.catalog.eventVisibility(staff, q.brandId),
      ...(q.status ? { status: q.status as any } : { status: { not: 'ARCHIVED' as const } }),
      ...(q.organizerId ? { organizerId: q.organizerId } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.event.findMany({
        where, skip, take, orderBy: { startsAt: 'desc' },
        include: {
          venue: { select: { name: true, city: true } },
          category: true,
          organizer: { select: { id: true, name: true } },
          publications: { select: { brandId: true, visible: true, brand: { select: { name: true, primaryColor: true } } } },
          ticketCategories: { select: { inventory: true } },
        },
      }),
      this.prisma.event.count({ where }),
    ]);
    const items = rows.map(({ ticketCategories, ...e }) => ({
      ...e,
      capacity: ticketCategories.reduce((s, c) => s + (c.inventory?.total ?? 0), 0),
      sold: ticketCategories.reduce((s, c) => s + (c.inventory?.sold ?? 0), 0),
      reserved: ticketCategories.reduce((s, c) => s + (c.inventory?.reserved ?? 0), 0),
      // A brand user only learns about publications on brands they can access.
      publications: e.publications.filter((p) => staff.allBrands || staff.brandIds.includes(p.brandId)),
    }));
    return paged(items, total, q);
  }

  @Get('events/:id')
  @Permissions('events.read')
  async event(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    await this.catalog.assertCanView(staff, id);
    const e = await this.prisma.event.findUniqueOrThrow({
      where: { id },
      include: {
        venue: true, category: true, organizer: { select: { id: true, name: true } },
        performers: { include: { performer: true }, orderBy: { billing: 'asc' } },
        images: { orderBy: { sortOrder: 'asc' } },
        publications: { include: { brand: { select: { id: true, name: true, primaryColor: true, status: true } }, priceOverrides: true } },
        ticketCategories: { include: { inventory: true }, orderBy: { sortOrder: 'asc' } },
      },
    });
    const canEditMaster = staff.allBrands || (!!e.ownerBrandId && staff.brandIds.includes(e.ownerBrandId));
    return {
      ...e,
      canEditMaster,
      publications: e.publications.filter((p) => staff.allBrands || staff.brandIds.includes(p.brandId)),
      images: e.images.filter((i) => !i.brandId || staff.allBrands || staff.brandIds.includes(i.brandId)),
      ticketCategories: e.ticketCategories.map((c) => ({
        ...c, available: c.inventory ? c.inventory.total - c.inventory.sold - c.inventory.reserved : 0,
      })),
    };
  }

  @Post('events')
  @Permissions('events.manage')
  async createEvent(@CurrentStaff() staff: Staff, @Body() dto: EventDto) {
    if (staff.eventScoped) throw forbidden('Event-scoped staff cannot create new events');
    if (dto.ownerBrandId) assertBrandAccess(staff, dto.ownerBrandId);
    else if (!staff.allBrands) {
      if (staff.brandIds.length !== 1) throw new AppError('OWNER_BRAND_REQUIRED', 'Choose the brand that owns this event', 400);
      dto.ownerBrandId = staff.brandIds[0];
    }
    const { performerIds, startsAt, endsAt, doorsAt, slug, ...rest } = dto;
    const base = slug ?? slugify(dto.name);
    const taken = await this.prisma.event.count({ where: { slug: base } });
    const event = await this.prisma.event.create({
      data: {
        ...rest,
        slug: taken ? `${base}-${Date.now().toString(36)}` : base,
        startsAt: new Date(startsAt), endsAt: d(endsAt), doorsAt: d(doorsAt), createdBy: staff.userId,
        performers: { create: (performerIds ?? []).map((performerId, billing) => ({ performerId, billing })) },
      },
    });
    await this.log(staff, 'event.create', 'event', event.id, undefined, event, event.ownerBrandId);
    return event;
  }

  @Patch('events/:id')
  @Permissions('events.manage')
  async updateEvent(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEventDto) {
    const before = await this.catalog.assertCanEditMaster(staff, id);
    const { performerIds, startsAt, endsAt, doorsAt, ...rest } = dto;
    const event = await this.prisma.$transaction(async (tx) => {
      if (performerIds) {
        await tx.eventPerformer.deleteMany({ where: { eventId: id } });
        await tx.eventPerformer.createMany({ data: performerIds.map((performerId, billing) => ({ eventId: id, performerId, billing })) });
      }
      return tx.event.update({ where: { id }, data: { ...rest, startsAt: d(startsAt) ?? undefined, endsAt: d(endsAt), doorsAt: d(doorsAt) } });
    });
    await this.bust();
    await this.log(staff, 'event.update', 'event', id, before, dto, event.ownerBrandId);
    return event;
  }

  /** Copies an event with its ticket categories (fresh, unsold inventory) as a new draft. */
  @Post('events/:id/duplicate')
  @Permissions('events.manage')
  async duplicate(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    await this.catalog.assertCanEditMaster(staff, id);
    const src = await this.prisma.event.findUniqueOrThrow({
      where: { id }, include: { performers: true, images: true, ticketCategories: { include: { inventory: true } } },
    });
    const copy = await this.prisma.$transaction(async (tx) => {
      const e = await tx.event.create({
        data: {
          slug: `${src.slug.slice(0, 50)}-copy-${Date.now().toString(36)}`, name: `${src.name} (copy)`, description: src.description,
          categoryId: src.categoryId, venueId: src.venueId, organizerId: src.organizerId, ownerBrandId: src.ownerBrandId, posterUrl: src.posterUrl,
          startsAt: src.startsAt, endsAt: src.endsAt, doorsAt: src.doorsAt, timezone: src.timezone, policies: src.policies, status: 'DRAFT',
          createdBy: staff.userId,
          performers: { create: src.performers.map((p) => ({ performerId: p.performerId, billing: p.billing })) },
          images: { create: src.images.map((i) => ({ url: i.url, kind: i.kind, sortOrder: i.sortOrder, brandId: i.brandId })) },
        },
      });
      for (const c of src.ticketCategories) {
        const nc = await tx.ticketCategory.create({
          data: {
            eventId: e.id, name: c.name, description: c.description, priceMinor: c.priceMinor, currency: c.currency, minPerOrder: c.minPerOrder,
            maxPerOrder: c.maxPerOrder, deliveryMethod: c.deliveryMethod, sortOrder: c.sortOrder, salesStartAt: c.salesStartAt, salesEndAt: c.salesEndAt,
          },
        });
        await this.inventory.initialise(tx, nc.id, c.inventory?.total ?? 0, staff.userId);
      }
      return e;
    });
    await this.log(staff, 'event.duplicate', 'event', copy.id, undefined, { sourceEventId: id }, copy.ownerBrandId);
    return copy;
  }

  /** Lifecycle transitions: publish, unpublish, schedule, cancel, postpone, archive, complete. */
  @Post('events/:id/status')
  @Permissions('events.publish')
  async setStatus(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EventStatusDto) {
    const before = await this.catalog.assertCanEditMaster(staff, id);
    const data: Record<string, unknown> = {};
    switch (dto.action) {
      case 'publish': {
        if (['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(before.status)) throw new AppError('INVALID_TRANSITION', `A ${before.status} event cannot be published`, 409);
        const cats = await this.prisma.ticketCategory.count({ where: { eventId: id } });
        if (!cats) throw new AppError('NO_TICKET_CATEGORIES', 'Add at least one ticket category before publishing', 409);
        // Ticket revenue is owed to someone: without an organizer the promoter share could not be settled.
        if (!before.organizerId) throw new AppError('ORGANIZER_REQUIRED', 'Assign an organizer before publishing so ticket revenue can be settled', 409);
        Object.assign(data, { status: 'PUBLISHED', publishAt: null });
        break;
      }
      case 'schedule':
        if (!dto.publishAt || new Date(dto.publishAt) <= new Date()) throw new AppError('PUBLISH_AT_REQUIRED', 'publishAt must be a future date', 400);
        Object.assign(data, { status: 'SCHEDULED', publishAt: new Date(dto.publishAt) });
        break;
      case 'unpublish':
        Object.assign(data, { status: 'DRAFT', publishAt: null });
        break;
      case 'postpone':
        if (!dto.newStartsAt) throw new AppError('NEW_DATE_REQUIRED', 'newStartsAt is required to postpone an event', 400);
        Object.assign(data, { status: 'POSTPONED', startsAt: new Date(dto.newStartsAt), endsAt: dto.newEndsAt ? new Date(dto.newEndsAt) : null });
        break;
      case 'cancel':
        if (!dto.reason) throw new AppError('REASON_REQUIRED', 'A cancellation reason is required', 400);
        Object.assign(data, { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.reason });
        break;
      case 'complete':
        Object.assign(data, { status: 'COMPLETED' });
        break;
      case 'archive':
        Object.assign(data, { status: 'ARCHIVED' });
        break;
    }

    let notified = 0;
    const event = await this.prisma.$transaction(async (tx) => {
      const e = await tx.event.update({ where: { id }, data, include: { venue: true } });
      if ((dto.action === 'cancel' || dto.action === 'postpone') && dto.notifyCustomers !== false) {
        const orders = await tx.order.findMany({
          where: { eventId: id, status: { in: ['TICKETS_ISSUED', 'PARTIALLY_REFUNDED', 'PAID'] } },
          select: { id: true, reference: true, brandId: true, customerId: true, customerEmail: true, customerName: true },
        });
        for (const o of orders) {
          await this.notifications.enqueue({
            brandId: o.brandId, // each customer hears from the brand they bought from
            type: dto.action === 'cancel' ? 'EVENT_CANCELLATION' : 'EVENT_POSTPONEMENT',
            to: o.customerEmail, toName: o.customerName, customerId: o.customerId, orderId: o.id,
            payload: {
              name: o.customerName, orderReference: o.reference, reason: dto.reason,
              event: { name: e.name, when: formatWhen(e.startsAt, e.timezone), venue: e.venue ? `${e.venue.name}, ${e.venue.city}` : '' },
            },
            dedupeKey: `event-${dto.action}:${id}:${o.id}:${e.startsAt.getTime()}`,
          }, tx);
        }
        notified = orders.length;
      }
      return e;
    });
    await this.notifications.kick();
    await this.bust();
    await this.log(staff, `event.${dto.action}`, 'event', id, { status: before.status, startsAt: before.startsAt }, { ...dto, notified }, event.ownerBrandId);
    return { ...event, notifiedOrders: notified };
  }

  // ── Images ──

  @Post('events/:id/images')
  @Permissions('events.manage')
  async addImage(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ImageDto) {
    if (dto.brandId) {
      await this.catalog.assertCanView(staff, id);
      assertBrandAccess(staff, dto.brandId);
    } else {
      await this.catalog.assertCanEditMaster(staff, id);
    }
    const img = await this.prisma.eventImage.create({ data: { eventId: id, ...dto } });
    await this.bust();
    return img;
  }

  @Delete('event-images/:imageId')
  @Permissions('events.manage')
  async removeImage(@CurrentStaff() staff: Staff, @Param('imageId', ParseUUIDPipe) imageId: string) {
    const img = await this.prisma.eventImage.findUnique({ where: { id: imageId } });
    if (!img) throw notFound('Image');
    if (img.brandId) assertBrandAccess(staff, img.brandId);
    else await this.catalog.assertCanEditMaster(staff, img.eventId);
    await this.prisma.eventImage.delete({ where: { id: imageId } });
    await this.bust();
    return { ok: true };
  }

  // ── Multi-brand publishing ──

  /** Publishes the event on a storefront, or updates that storefront's presentation of it. */
  @Put('events/:id/publications/:brandId')
  @Permissions('events.publish')
  async upsertPublication(
    @CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Param('brandId', ParseUUIDPipe) brandId: string, @Body() dto: PublicationDto,
  ) {
    assertBrandAccess(staff, brandId);
    const existing = await this.prisma.eventBrandPublication.findUnique({ where: { eventId_brandId: { eventId: id, brandId } } });
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event) throw notFound('Event');
    const ownsMaster = staff.allBrands || (!!event.ownerBrandId && staff.brandIds.includes(event.ownerBrandId));
    // Listing a shared event on a new storefront, or re-pricing it, needs authority over the master event.
    if (!existing && !ownsMaster) throw forbidden('Only the platform team or the owning brand can publish this event to a storefront');
    if (dto.priceOverrides && !ownsMaster) throw forbidden('Brand-specific pricing must be set by the platform team or the owning brand');
    if (existing) await this.catalog.assertCanView(staff, id);

    const { priceOverrides, salesStartAt, salesEndAt, ...rest } = dto;
    const pub = await this.prisma.$transaction(async (tx) => {
      const p = await tx.eventBrandPublication.upsert({
        where: { eventId_brandId: { eventId: id, brandId } },
        create: { eventId: id, brandId, ...rest, salesStartAt: d(salesStartAt), salesEndAt: d(salesEndAt) },
        update: { ...rest, salesStartAt: d(salesStartAt), salesEndAt: d(salesEndAt) },
      });
      if (priceOverrides) {
        const cats = await tx.ticketCategory.findMany({ where: { eventId: id }, select: { id: true } });
        const valid = new Set(cats.map((c) => c.id));
        if (priceOverrides.some((o) => !valid.has(o.ticketCategoryId))) throw new AppError('CATEGORY_MISMATCH', 'A price override refers to a ticket category of another event', 400);
        await tx.publicationPriceOverride.deleteMany({ where: { publicationId: p.id } });
        await tx.publicationPriceOverride.createMany({ data: priceOverrides.map((o) => ({ publicationId: p.id, ticketCategoryId: o.ticketCategoryId, priceMinor: BigInt(o.priceMinor) })) });
      }
      return tx.eventBrandPublication.findUniqueOrThrow({ where: { id: p.id }, include: { priceOverrides: true } });
    });
    await this.bust();
    await this.log(staff, existing ? 'event.publication_update' : 'event.publication_create', 'event', id, existing ?? undefined, dto, brandId);
    return pub;
  }

  @Delete('events/:id/publications/:brandId')
  @Permissions('events.publish')
  async removePublication(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Param('brandId', ParseUUIDPipe) brandId: string) {
    assertBrandAccess(staff, brandId);
    await this.prisma.eventBrandPublication.delete({ where: { eventId_brandId: { eventId: id, brandId } } });
    await this.bust();
    await this.log(staff, 'event.publication_remove', 'event', id, undefined, undefined, brandId);
    return { ok: true };
  }

  // ── Ticket categories & inventory ──

  @Post('events/:id/ticket-categories')
  @Permissions('events.manage')
  async createTicketCategory(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketCategoryDto) {
    const event = await this.catalog.assertCanEditMaster(staff, id);
    const { totalQuantity, priceMinor, salesStartAt, salesEndAt, ...rest } = dto;
    if ((dto.maxPerOrder ?? 10) < (dto.minPerOrder ?? 1)) throw new AppError('PURCHASE_LIMITS_INVALID', 'Maximum per order must be at least the minimum', 400);
    const cat = await this.prisma.$transaction(async (tx) => {
      const c = await tx.ticketCategory.create({
        data: { eventId: id, ...rest, priceMinor: BigInt(priceMinor), salesStartAt: d(salesStartAt), salesEndAt: d(salesEndAt) },
      });
      await this.inventory.initialise(tx, c.id, totalQuantity, staff.userId);
      return c;
    });
    await this.bust();
    await this.log(staff, 'ticket_category.create', 'ticket_category', cat.id, undefined, dto, event.ownerBrandId);
    return cat;
  }

  @Patch('ticket-categories/:categoryId')
  @Permissions('events.manage')
  async updateTicketCategory(@CurrentStaff() staff: Staff, @Param('categoryId', ParseUUIDPipe) categoryId: string, @Body() dto: UpdateTicketCategoryDto) {
    const before = await this.prisma.ticketCategory.findUnique({ where: { id: categoryId } });
    if (!before) throw notFound('Ticket category');
    const event = await this.catalog.assertCanEditMaster(staff, before.eventId);
    const { priceMinor, salesStartAt, salesEndAt, ...rest } = dto;
    const cat = await this.prisma.ticketCategory.update({
      where: { id: categoryId },
      data: { ...rest, priceMinor: priceMinor === undefined ? undefined : BigInt(priceMinor), salesStartAt: d(salesStartAt), salesEndAt: d(salesEndAt) },
    });
    await this.bust();
    await this.log(staff, 'ticket_category.update', 'ticket_category', categoryId, before, dto, event.ownerBrandId);
    return cat;
  }

  /** Cross-storefront inventory position for every category the caller can see. */
  @Get('inventory')
  @Permissions('inventory.read')
  async inventoryList(@CurrentStaff() staff: Staff, @Query() q: EventQuery) {
    const where = {
      event: { ...this.catalog.eventVisibility(staff, q.brandId), status: { in: ['PUBLISHED', 'POSTPONED', 'SCHEDULED', 'DRAFT'] as any } },
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' as const } }, { event: { name: { contains: q.q, mode: 'insensitive' as const } } }] } : {}),
    };
    const { skip, take } = paging(q);
    const [rows, total] = await Promise.all([
      this.prisma.ticketCategory.findMany({
        where, skip, take, orderBy: [{ event: { startsAt: 'asc' } }, { sortOrder: 'asc' }],
        include: { inventory: true, event: { select: { id: true, name: true, startsAt: true, status: true } } },
      }),
      this.prisma.ticketCategory.count({ where }),
    ]);
    return paged(rows.map((c) => ({ ...c, available: c.inventory ? c.inventory.total - c.inventory.sold - c.inventory.reserved : 0 })), total, q);
  }

  /** Sales per storefront for one event, drawn from the same central inventory. */
  @Get('events/:id/inventory')
  @Permissions('inventory.read')
  async eventInventory(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    await this.catalog.assertCanView(staff, id);
    const [categories, byBrand, movements] = await Promise.all([
      this.prisma.ticketCategory.findMany({ where: { eventId: id }, include: { inventory: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.ticket.groupBy({ by: ['brandId', 'ticketCategoryId'], where: { eventId: id, status: { in: ['VALID', 'USED'] } }, _count: true }),
      this.prisma.inventoryMovement.findMany({ where: { ticketCategory: { eventId: id } }, orderBy: { createdAt: 'desc' }, take: 100, include: { ticketCategory: { select: { name: true } } } }),
    ]);
    const visible = (brandId: string | null) => !brandId || staff.allBrands || staff.brandIds.includes(brandId);
    const brands = await this.prisma.brand.findMany({ where: { id: { in: byBrand.map((b) => b.brandId) } }, select: { id: true, name: true } });
    return {
      categories: categories.map((c) => ({ ...c, available: c.inventory ? c.inventory.total - c.inventory.sold - c.inventory.reserved : 0 })),
      // Platform staff see the split across all storefronts; brand staff see their own share only.
      salesByBrand: byBrand.filter((b) => visible(b.brandId)).map((b) => ({
        brandId: b.brandId, brandName: brands.find((x) => x.id === b.brandId)?.name, ticketCategoryId: b.ticketCategoryId, tickets: b._count,
      })),
      movements: movements.filter((m) => visible(m.brandId)),
    };
  }

  @Post('ticket-categories/:categoryId/inventory')
  @Permissions('inventory.manage')
  async adjustInventory(@CurrentStaff() staff: Staff, @Param('categoryId', ParseUUIDPipe) categoryId: string, @Body() dto: AdjustInventoryDto) {
    const cat = await this.prisma.ticketCategory.findUnique({ where: { id: categoryId } });
    if (!cat) throw notFound('Ticket category');
    const event = await this.catalog.assertCanEditMaster(staff, cat.eventId);
    const result = await this.prisma.tx((tx) => this.inventory.setTotal(tx, categoryId, dto.total, staff.userId, dto.note));
    await this.log(staff, 'inventory.adjust', 'ticket_category', categoryId, undefined, { ...dto, delta: result.delta }, event.ownerBrandId);
    return result;
  }

  /** Verifies counters against the movement ledger, reservations and issued tickets. */
  @Post('inventory/reconcile')
  @Permissions('inventory.manage')
  async reconcile(@CurrentStaff() staff: Staff, @Query('eventId') eventId?: string) {
    if (eventId) await this.catalog.assertCanView(staff, eventId);
    else assertPlatformWide(staff);
    const result = await this.inventory.reconcile(eventId);
    await this.log(staff, 'inventory.reconcile', 'event', eventId ?? 'all', undefined, { checked: result.checked, issues: result.issues.length });
    return result;
  }
}
