import { Injectable } from '@nestjs/common';
import { Prisma, TicketCategory } from '@prisma/client';
import { assertEventAccess, canAccessBrand, Staff } from '../../common/auth';
import { AppError, forbidden, notFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/infra';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SELLABLE_EVENT_STATUSES = ['PUBLISHED', 'POSTPONED'] as const;

const storefrontInclude = {
  venue: true,
  category: true,
  organizer: { select: { id: true, name: true } },
  performers: { include: { performer: true }, orderBy: { billing: 'asc' } },
  images: { orderBy: { sortOrder: 'asc' } },
  ticketCategories: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.EventInclude;

export type StorefrontEvent = Prisma.EventGetPayload<{ include: typeof storefrontInclude }> & {
  publication: Prisma.EventBrandPublicationGetPayload<{ include: { priceOverrides: true } }>;
};

@Injectable()
export class CatalogService {
  constructor(private prisma: PrismaService) {}

  // ── Staff access rules for the shared master catalogue ──

  /** Events a staff member may see: all (platform), or those owned by / published to their brands. */
  eventVisibility(staff: Staff, brandId?: string | null): Prisma.EventWhereInput {
    const and: Prisma.EventWhereInput[] = [];
    if (staff.eventScoped) and.push({ id: { in: staff.eventIds } });
    if (brandId) {
      if (!canAccessBrand(staff, brandId)) throw forbidden('You do not have access to this brand');
      and.push({ OR: [{ ownerBrandId: brandId }, { publications: { some: { brandId } } }] });
    } else if (!staff.allBrands) {
      and.push({ OR: [{ ownerBrandId: { in: staff.brandIds } }, { publications: { some: { brandId: { in: staff.brandIds } } } }] });
    }
    return and.length ? { AND: and } : {};
  }

  async assertCanView(staff: Staff, eventId: string) {
    const event = await this.prisma.event.findFirst({ where: { id: eventId, ...this.eventVisibility(staff) } });
    if (!event) throw notFound('Event');
    return event;
  }

  /** Only platform staff or staff of the owning brand may change the master record, its categories and inventory. */
  async assertCanEditMaster(staff: Staff, eventId: string) {
    const event = await this.assertCanView(staff, eventId);
    assertEventAccess(staff, eventId);
    if (!staff.allBrands && !(event.ownerBrandId && staff.brandIds.includes(event.ownerBrandId))) {
      throw forbidden('This is a shared master event. Only the platform team or the owning brand can change it.');
    }
    return event;
  }

  // ── Pricing and sales windows ──

  effectivePrice(category: Pick<TicketCategory, 'id' | 'priceMinor'>, publication: { priceOverrides: { ticketCategoryId: string; priceMinor: bigint }[] }): bigint {
    return publication.priceOverrides.find((o) => o.ticketCategoryId === category.id)?.priceMinor ?? category.priceMinor;
  }

  /** Why a category cannot be bought right now on this storefront, or null if it is on sale. */
  saleBlocker(
    event: { status: string; startsAt: Date; endsAt: Date | null },
    publication: { visible: boolean; salesStartAt: Date | null; salesEndAt: Date | null },
    category: Pick<TicketCategory, 'status' | 'salesStartAt' | 'salesEndAt'>,
    now = new Date(),
  ): string | null {
    if (!(SELLABLE_EVENT_STATUSES as readonly string[]).includes(event.status)) return 'EVENT_NOT_ON_SALE';
    if ((event.endsAt ?? event.startsAt) < now) return 'EVENT_ENDED';
    if (!publication.visible) return 'NOT_AVAILABLE';
    if (category.status === 'SOLD_OUT') return 'SOLD_OUT';
    if (category.status !== 'ACTIVE') return 'CATEGORY_CLOSED';
    const start = [publication.salesStartAt, category.salesStartAt].filter(Boolean).map((d) => d!.getTime());
    const end = [publication.salesEndAt, category.salesEndAt].filter(Boolean).map((d) => d!.getTime());
    if (start.length && now.getTime() < Math.max(...start)) return 'SALES_NOT_STARTED';
    if (end.length && now.getTime() > Math.min(...end)) return 'SALES_ENDED';
    return null;
  }

  /** Loads an event exactly as one storefront is allowed to see it. Unpublished events do not exist for that brand. */
  async storefrontEvent(brandId: string, idOrSlug: string, db: Tx | PrismaService = this.prisma): Promise<StorefrontEvent> {
    const event = await db.event.findFirst({
      where: {
        ...(UUID.test(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug }),
        status: { in: ['PUBLISHED', 'POSTPONED', 'CANCELLED', 'COMPLETED'] },
        publications: { some: { brandId, visible: true } },
      },
      include: storefrontInclude,
    });
    if (!event) throw new AppError('EVENT_NOT_FOUND', 'Event not found', 404);
    const publication = await db.eventBrandPublication.findUniqueOrThrow({
      where: { eventId_brandId: { eventId: event.id, brandId } },
      include: { priceOverrides: true },
    });
    return { ...event, publication };
  }

  /** Storefront representation: brand-specific title, description, imagery and prices over the shared master record. */
  present(event: StorefrontEvent, availability?: Map<string, { total: number; available: number }>) {
    const p = event.publication;
    const brandImages = event.images.filter((i) => i.brandId === p.brandId);
    return {
      id: event.id,
      slug: event.slug,
      name: p.customTitle ?? event.name,
      description: p.customDescription ?? event.description,
      status: event.status,
      featured: p.featured,
      category: event.category ? { slug: event.category.slug, name: event.category.name } : null,
      posterUrl: p.promoImageUrl ?? event.posterUrl,
      gallery: (brandImages.length ? brandImages : event.images.filter((i) => !i.brandId)).map((i) => i.url),
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      doorsAt: event.doorsAt,
      timezone: event.timezone,
      venue: event.venue ? { name: event.venue.name, address: event.venue.address, city: event.venue.city, country: event.venue.country } : null,
      performers: event.performers.map((ep) => ({ id: ep.performer.id, name: ep.performer.name, type: ep.performer.type, imageUrl: ep.performer.imageUrl })),
      organizer: event.organizer?.name ?? null,
      policies: event.policies,
      ticketCategories: event.ticketCategories
        .filter((c) => c.status !== 'CLOSED')
        .map((c) => {
          const blocker = this.saleBlocker(event, p, c);
          const a = availability?.get(c.id);
          return {
            id: c.id,
            name: c.name,
            description: c.description,
            priceMinor: this.effectivePrice(c, p),
            currency: c.currency,
            minPerOrder: c.minPerOrder,
            maxPerOrder: c.maxPerOrder,
            deliveryMethod: c.deliveryMethod,
            onSale: !blocker && (a ? a.available > 0 : true),
            unavailableReason: blocker ?? (a && a.available <= 0 ? 'SOLD_OUT' : null),
            // Exact stock is only disclosed when it is running low.
            available: a ? (a.available <= 20 ? a.available : null) : undefined,
            lowStock: a ? a.available > 0 && a.available <= 20 : undefined,
          };
        }),
    };
  }
}
