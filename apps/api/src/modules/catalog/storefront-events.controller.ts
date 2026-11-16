import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RateLimit, RateLimitGuard, Storefront, StorefrontCtx, StorefrontGuard } from '../../common/auth';
import { sha256 } from '../../common/crypto';
import { PrismaService, RedisService } from '../../common/infra';
import { InventoryService } from '../inventory/inventory.service';
import { CatalogService } from './catalog.service';

class EventSearchQuery {
  /** Free-text search over event names, performers and venues. */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  /** Event category slug. */
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) pageSize?: number = 24;
}

@ApiTags('Storefront · Events')
@ApiSecurity('storefront-key')
@Controller('v1/storefront/events')
@UseGuards(StorefrontGuard, RateLimitGuard)
export class StorefrontEventsController {
  constructor(private prisma: PrismaService, private catalog: CatalogService, private inventory: InventoryService, private redis: RedisService) {}

  /**
   * Lists and searches events published to the calling storefront.
   * Listings are cached briefly; they carry prices but never stock levels.
   */
  @Get()
  @RateLimit({ limit: 6000, windowSec: 60, by: 'storefront' })
  list(@Storefront() sf: StorefrontCtx, @Query() q: EventSearchQuery) {
    const brandId = sf.brand.id;
    const key = `sf:events:${brandId}:${sha256(JSON.stringify(q)).slice(0, 24)}`;
    return this.redis.cached(key, 20, async () => {
      const page = q.page ?? 1;
      const pageSize = q.pageSize ?? 24;
      const where = {
        status: { in: ['PUBLISHED', 'POSTPONED'] as any },
        publications: { some: { brandId, visible: true } },
        startsAt: { gte: q.from ? new Date(q.from) : new Date(Date.now() - 6 * 3600_000), lte: q.to ? new Date(q.to) : undefined },
        ...(q.category ? { category: { slug: q.category } } : {}),
        ...(q.city ? { venue: { city: { equals: q.city, mode: 'insensitive' as const } } } : {}),
        ...(q.q
          ? {
              OR: [
                { name: { contains: q.q, mode: 'insensitive' as const } },
                { performers: { some: { performer: { name: { contains: q.q, mode: 'insensitive' as const } } } } },
                { venue: { name: { contains: q.q, mode: 'insensitive' as const } } },
                { publications: { some: { brandId, customTitle: { contains: q.q, mode: 'insensitive' as const } } } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        this.prisma.event.findMany({
          where, orderBy: { startsAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize,
          include: {
            venue: true, category: true,
            publications: { where: { brandId }, include: { priceOverrides: true } },
            ticketCategories: { where: { status: { in: ['ACTIVE', 'SOLD_OUT'] } }, select: { id: true, priceMinor: true, currency: true } },
            performers: { include: { performer: { select: { name: true } } }, orderBy: { billing: 'asc' }, take: 3 },
          },
        }),
        this.prisma.event.count({ where }),
      ]);
      const items = rows.map((e) => {
        const p = e.publications[0];
        const prices = e.ticketCategories.map((c) => this.catalog.effectivePrice(c, p));
        const from = prices.length ? prices.reduce((a, b) => (b < a ? b : a)) : null;
        return {
          id: e.id, slug: e.slug, name: p.customTitle ?? e.name, status: e.status, featured: p.featured,
          posterUrl: p.promoImageUrl ?? e.posterUrl, startsAt: e.startsAt, timezone: e.timezone,
          category: e.category ? { slug: e.category.slug, name: e.category.name } : null,
          venue: e.venue ? { name: e.venue.name, city: e.venue.city, country: e.venue.country } : null,
          performers: e.performers.map((x) => x.performer.name),
          fromPriceMinor: from === null ? null : Number(from), currency: e.ticketCategories[0]?.currency ?? null,
        };
      });
      return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
    });
  }

  /** Event categories that currently have events on this storefront. */
  @Get('categories')
  categories(@Storefront() sf: StorefrontCtx) {
    return this.redis.cached(`sf:events:${sf.brand.id}:categories`, 60, () =>
      this.prisma.eventCategory.findMany({
        where: { events: { some: { status: { in: ['PUBLISHED', 'POSTPONED'] }, publications: { some: { brandId: sf.brand.id, visible: true } } } } },
        orderBy: { name: 'asc' },
      }),
    );
  }

  /**
   * Event presentation (texts, images, prices, sales windows) is cached for a few seconds;
   * stock is read from the database on every call and overlaid, so availability is never stale.
   */
  private async detailWithLiveStock(brandId: string, idOrSlug: string) {
    const base = await this.redis.cached(`sf:events:${brandId}:detail:${idOrSlug.toLowerCase()}`, 15, async () =>
      this.catalog.present(await this.catalog.storefrontEvent(brandId, idOrSlug)),
    );
    const stock = await this.inventory.availability(base.ticketCategories.map((c) => c.id));
    return {
      ...base,
      ticketCategories: base.ticketCategories.map((c) => {
        const a = stock.get(c.id);
        const blocker = c.unavailableReason && c.unavailableReason !== 'SOLD_OUT' ? c.unavailableReason : c.onSale ? null : c.unavailableReason;
        const soldOut = !a || a.available <= 0;
        return {
          ...c,
          onSale: !blocker && !soldOut,
          unavailableReason: blocker ?? (soldOut ? 'SOLD_OUT' : null),
          available: a && a.available <= 20 ? Math.max(a.available, 0) : null,
          lowStock: !!a && a.available > 0 && a.available <= 20,
        };
      }),
    };
  }

  /** Event detail with this storefront's presentation and live availability. */
  @Get(':idOrSlug')
  @RateLimit({ limit: 6000, windowSec: 60, by: 'storefront' })
  detail(@Storefront() sf: StorefrontCtx, @Param('idOrSlug') idOrSlug: string) {
    return this.detailWithLiveStock(sf.brand.id, idOrSlug);
  }

  /** Live inventory for an event. Stock always comes from the database, never from a cache. */
  @Get(':idOrSlug/inventory')
  @RateLimit({ limit: 12000, windowSec: 60, by: 'storefront' })
  async liveInventory(@Storefront() sf: StorefrontCtx, @Param('idOrSlug') idOrSlug: string) {
    const event = await this.detailWithLiveStock(sf.brand.id, idOrSlug);
    return {
      eventId: event.id,
      asOf: new Date(),
      categories: event.ticketCategories.map((c) => ({ id: c.id, onSale: c.onSale, unavailableReason: c.unavailableReason, available: c.available, lowStock: c.lowStock })),
    };
  }
}
