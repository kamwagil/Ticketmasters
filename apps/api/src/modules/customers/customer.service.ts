import { Injectable } from '@nestjs/common';
import { Brand, Channel } from '@prisma/client';
import { randomToken, sha256 } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { requestIp } from '../../common/context';
import { PrismaService, Tx } from '../../common/infra';
import { normEmail, normPhone } from '../../common/util';

export interface CheckoutCustomer {
  email: string;
  fullName: string;
  phone?: string | null;
  country?: string | null;
}

/**
 * Central customer identity with per-brand relationships.
 *
 *  - `customers`                     one row per person (central identity)
 *  - `customer_brand_relationships`  that person's account with one brand (login, stats)
 *  - `customer_identities`           contact points; only VERIFIED ones link people across brands
 *
 * A checkout on a new brand with a known email creates a separate, unlinked customer.
 * The records are joined only when the buyer proves control of the email address
 * (verification link). Marketing consent and preferences stay per brand through a merge.
 */
@Injectable()
export class CustomerService {
  constructor(private prisma: PrismaService) {}

  /** Finds or creates the buyer's relationship with the selling brand. */
  async resolveForCheckout(tx: Tx, brandId: string, input: CheckoutCustomer, authed?: { relationshipId: string } | null) {
    const email = normEmail(input.email);
    const phone = normPhone(input.phone);
    let rel = authed
      ? await tx.customerBrandRelationship.findUnique({ where: { id: authed.relationshipId }, include: { customer: true } })
      : await tx.customerBrandRelationship.findUnique({ where: { brandId_email: { brandId, email } }, include: { customer: true } });

    if (rel) {
      if (rel.brandId !== brandId) throw new AppError('FORBIDDEN', 'Account does not belong to this storefront', 403);
      if (rel.status !== 'ACTIVE' || rel.customer.status === 'BLOCKED') throw new AppError('CUSTOMER_BLOCKED', 'This account cannot place orders', 403);
      // Fill gaps only; a guest checkout must not overwrite an existing customer's details.
      const patch: Record<string, string> = {};
      if (!rel.customer.phone && phone) patch.phone = phone;
      if (!rel.customer.country && input.country) patch.country = input.country;
      if (Object.keys(patch).length) await tx.customer.update({ where: { id: rel.customerId }, data: patch });
      return { customerId: rel.customerId, relationshipId: rel.id };
    }

    const customer = await tx.customer.create({
      data: { fullName: input.fullName.trim(), email, phone, country: input.country ?? null, identities: { create: { type: 'EMAIL', value: email } } },
    });
    rel = await tx.customerBrandRelationship.create({ data: { customerId: customer.id, brandId, email }, include: { customer: true } });
    return { customerId: customer.id, relationshipId: rel.id };
  }

  async recordConsent(
    tx: Tx | PrismaService, customerId: string, brandId: string, channel: Channel, status: 'GRANTED' | 'WITHDRAWN',
    source: string, wording?: string,
  ) {
    const latest = await tx.marketingConsent.findFirst({ where: { customerId, brandId, channel }, orderBy: { createdAt: 'desc' } });
    if (latest?.status === status) return; // no state change, no new row
    await tx.marketingConsent.create({ data: { customerId, brandId, channel, status, source, wording, ip: requestIp() } });
  }

  /** Current consent per brand and channel (latest row wins). */
  async consentState(customerId: string, brandIds?: string[]) {
    const rows = await this.prisma.marketingConsent.findMany({
      where: { customerId, ...(brandIds ? { brandId: { in: brandIds } } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = `${r.brandId}:${r.channel}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  async issueToken(tx: Tx | PrismaService, relationshipId: string, purpose: 'EMAIL_VERIFY' | 'PASSWORD_RESET', ttlMinutes: number) {
    const token = randomToken(32);
    await tx.customerToken.create({ data: { relationshipId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMinutes * 60_000) } });
    return token;
  }

  async consumeToken(tx: Tx, token: string, purpose: 'EMAIL_VERIFY' | 'PASSWORD_RESET') {
    const row = await tx.customerToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt < new Date()) {
      throw new AppError('TOKEN_INVALID', 'This link is invalid or has expired', 400);
    }
    const claimed = await tx.customerToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError('TOKEN_INVALID', 'This link has already been used', 400);
    return row.relationshipId;
  }

  /**
   * Marks a brand account's email as verified and, if the same verified email already
   * belongs to a central customer (from another brand), links this account to that person.
   * @returns the central customer id the relationship now points at and whether a link happened.
   */
  async markEmailVerified(tx: Tx, relationshipId: string): Promise<{ customerId: string; linked: boolean }> {
    const rel = await tx.customerBrandRelationship.update({ where: { id: relationshipId }, data: { emailVerifiedAt: new Date() } });
    const owner = await tx.customerIdentity.findFirst({ where: { type: 'EMAIL', value: rel.email, verifiedAt: { not: null } } });

    if (!owner || owner.customerId === rel.customerId) {
      await tx.customerIdentity.upsert({
        where: { customerId_type_value: { customerId: rel.customerId, type: 'EMAIL', value: rel.email } },
        create: { customerId: rel.customerId, type: 'EMAIL', value: rel.email, verifiedAt: new Date(), verifiedViaBrandId: rel.brandId },
        update: { verifiedAt: new Date(), verifiedViaBrandId: rel.brandId },
      });
      return { customerId: rel.customerId, linked: false };
    }

    // The verified owner already has a (different) account with this brand: keep them apart.
    const clash = await tx.customerBrandRelationship.findUnique({ where: { brandId_customerId: { brandId: rel.brandId, customerId: owner.customerId } } });
    if (clash) return { customerId: rel.customerId, linked: false };

    const from = rel.customerId;
    const to = owner.customerId;
    // Re-point this brand account and everything it produced at the verified central customer.
    // Every moved row keeps its own brandId, so brand attribution and consent scope are unchanged.
    await tx.customerBrandRelationship.update({ where: { id: rel.id }, data: { customerId: to } });
    await tx.order.updateMany({ where: { customerId: from }, data: { customerId: to } });
    await tx.ticket.updateMany({ where: { customerId: from }, data: { customerId: to } });
    await tx.marketingConsent.createMany({
      data: (await tx.marketingConsent.findMany({ where: { customerId: from }, orderBy: { createdAt: 'asc' } })).map(({ id: _id, customerId: _c, ...c }) => ({ ...c, customerId: to })),
    });
    await tx.marketingConsent.deleteMany({ where: { customerId: from } });
    await tx.customerNote.updateMany({ where: { customerId: from }, data: { customerId: to } });
    await tx.supportTicket.updateMany({ where: { customerId: from }, data: { customerId: to } });
    await tx.emailJob.updateMany({ where: { customerId: from }, data: { customerId: to } });
    await tx.notificationLog.updateMany({ where: { customerId: from }, data: { customerId: to } });
    await tx.campaignDelivery.deleteMany({ where: { customerId: from, campaignId: { in: (await tx.campaignDelivery.findMany({ where: { customerId: to }, select: { campaignId: true } })).map((x) => x.campaignId) } } });
    await tx.campaignDelivery.updateMany({ where: { customerId: from }, data: { customerId: to } });
    for (const p of await tx.customerPreference.findMany({ where: { customerId: from } })) {
      await tx.customerPreference.upsert({
        where: { customerId_brandId_key: { customerId: to, brandId: p.brandId, key: p.key } },
        create: { customerId: to, brandId: p.brandId, key: p.key, value: p.value as any },
        update: {},
      });
    }
    for (const t of await tx.customerTagAssignment.findMany({ where: { customerId: from } })) {
      await tx.customerTagAssignment.upsert({ where: { customerId_tagId: { customerId: to, tagId: t.tagId } }, create: { customerId: to, tagId: t.tagId }, update: {} });
    }
    await tx.customerPreference.deleteMany({ where: { customerId: from } });
    await tx.customerTagAssignment.deleteMany({ where: { customerId: from } });
    await tx.customerIdentity.deleteMany({ where: { customerId: from } });
    await tx.customer.update({ where: { id: from }, data: { mergedIntoId: to, status: 'ANONYMIZED', email: null, phone: null, fullName: 'Merged record', anonymizedAt: new Date() } });
    return { customerId: to, linked: true };
  }

  /** Updates per-brand purchase stats after a paid order. */
  async recordPurchase(tx: Tx, relationshipId: string | null, at: Date) {
    if (!relationshipId) return;
    const rel = await tx.customerBrandRelationship.findUnique({ where: { id: relationshipId } });
    if (!rel) return;
    await tx.customerBrandRelationship.update({
      where: { id: relationshipId },
      data: { orderCount: { increment: 1 }, lastOrderAt: at, firstOrderAt: rel.firstOrderAt ?? at },
    });
  }

  brandSiteUrl(brand: Pick<Brand, 'id'>, domain: string) {
    return `${/^(localhost|[\w-]+\.localhost)(:\d+)?$/.test(domain) ? 'http' : 'https'}://${domain}`;
  }
}
