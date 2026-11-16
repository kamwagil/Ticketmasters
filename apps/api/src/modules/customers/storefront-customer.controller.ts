import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import {
  IsBoolean, IsDefined, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength,
} from 'class-validator';
import type { Response } from 'express';
import {
  AllowSuspendedBrand, CurrentCustomer, CustomerCtx, CustomerGuard, OptionalCustomerGuard, RateLimit, RateLimitGuard, signCustomerToken, Storefront,
  StorefrontCtx, StorefrontGuard,
} from '../../common/auth';
import { hashPassword, reference, verifyPassword } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { PrismaService } from '../../common/infra';
import { normEmail, normPhone } from '../../common/util';
import { NotificationService } from '../notifications/notification.service';
import { TicketDocumentService } from '../tickets/ticket-document.service';
import { TicketService } from '../tickets/ticket.service';
import { CustomerService } from './customer.service';

class RegisterDto {
  @IsEmail() email: string;
  @IsString() @MinLength(10) @MaxLength(200) password: string;
  @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
  /** Explicit opt-in to marketing from THIS brand only. */
  @IsOptional() @IsBoolean() marketingOptIn?: boolean;
}
class LoginDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
}
class TokenDto {
  @IsString() @MinLength(20) @MaxLength(200) token: string;
}
class ResetRequestDto {
  @IsEmail() email: string;
}
class ResetConfirmDto extends TokenDto {
  @IsString() @MinLength(10) @MaxLength(200) password: string;
}
class UpdateMeDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) preferredCurrency?: string;
}
class ConsentDto {
  @IsIn(['EMAIL', 'SMS', 'WHATSAPP']) channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  @IsBoolean() granted: boolean;
}
class PreferenceDto {
  @IsDefined() value: unknown;
}
class DataRequestDto {
  @IsIn(['ACCESS', 'CORRECTION', 'DELETION']) type: 'ACCESS' | 'CORRECTION' | 'DELETION';
  @IsOptional() @IsString() @MaxLength(2000) details?: string;
}
class TicketAccessQuery {
  /** Guest access: the order reference plus the email the order was placed with. */
  @IsOptional() @IsString() @MaxLength(40) orderReference?: string;
  /** Guest access for a transferred ticket: the ticket reference plus the holder's email. */
  @IsOptional() @IsString() @MaxLength(40) ticketReference?: string;
  @IsOptional() @IsEmail() email?: string;
}
class TransferDto {
  @IsEmail() toEmail: string;
  @IsOptional() @IsString() @MaxLength(120) toName?: string;
}
class SupportCreateDto {
  @IsString() @MinLength(3) @MaxLength(200) subject: string;
  @IsString() @MinLength(5) @MaxLength(5000) message: string;
  @IsOptional() @IsIn(['GENERAL_ENQUIRY', 'TICKET_DELIVERY', 'PAYMENT', 'REFUND_REQUEST', 'EVENT_CANCELLATION', 'ORDER_ENQUIRY']) issueType?:
    'GENERAL_ENQUIRY' | 'TICKET_DELIVERY' | 'PAYMENT' | 'REFUND_REQUEST' | 'EVENT_CANCELLATION' | 'ORDER_ENQUIRY';
  @IsOptional() @IsString() @MaxLength(40) orderReference?: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
}
class SupportReplyDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}

const DUMMY_HASH = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';
const PREF_KEY = /^[a-z][a-z0-9_.-]{1,60}$/;

@ApiTags('Storefront · Customers')
@ApiSecurity('storefront-key')
@Controller('v1/storefront')
@UseGuards(StorefrontGuard, RateLimitGuard)
export class StorefrontCustomerController {
  constructor(
    private prisma: PrismaService,
    private customers: CustomerService,
    private notifications: NotificationService,
    private tickets: TicketService,
    private docs: TicketDocumentService,
  ) {}

  private siteUrl(sf: StorefrontCtx) {
    return this.customers.brandSiteUrl(sf.brand, sf.domain);
  }

  private async relationship(c: CustomerCtx) {
    return this.prisma.customerBrandRelationship.findUniqueOrThrow({ where: { id: c.relationshipId }, include: { customer: true } });
  }

  /**
   * Anything that exposes or changes data tied to the email address needs the address to be
   * verified first. Otherwise registering with someone else's email (which attaches to their
   * guest-checkout record) would hand over their orders and tickets.
   */
  private async requireVerified(c: CustomerCtx) {
    const rel = await this.relationship(c);
    if (!rel.emailVerifiedAt) throw new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email address to continue', 403);
    return rel;
  }

  private profile(rel: Prisma.CustomerBrandRelationshipGetPayload<{ include: { customer: true } }>) {
    return {
      id: rel.customerId, email: rel.email, fullName: rel.customer.fullName, phone: rel.customer.phone, country: rel.customer.country,
      preferredCurrency: rel.customer.preferredCurrency, emailVerified: !!rel.emailVerifiedAt, memberSince: rel.createdAt,
    };
  }

  private token(rel: { id: string; customerId: string; brandId: string; tokenVersion: number }) {
    return signCustomerToken({ relationshipId: rel.id, customerId: rel.customerId, brandId: rel.brandId, tokenVersion: rel.tokenVersion });
  }

  // ───────────────────────── Registration and sign-in ─────────────────────────

  /** Creates a customer account with this brand. The email stays unverified until the emailed link is used. */
  @Post('customers/register')
  @RateLimit({ limit: 10, windowSec: 60 })
  async register(@Storefront() sf: StorefrontCtx, @Body() dto: RegisterDto) {
    const brandId = sf.brand.id;
    const email = normEmail(dto.email);
    const passwordHash = await hashPassword(dto.password);
    const rel = await this.prisma.tx(async (tx) => {
      const existing = await tx.customerBrandRelationship.findUnique({ where: { brandId_email: { brandId, email } } });
      if (existing?.passwordHash) throw new AppError('EMAIL_IN_USE', 'An account with this email already exists. Sign in or reset your password.', 409);
      let relId: string;
      if (existing) {
        if (existing.status !== 'ACTIVE') throw new AppError('ACCOUNT_DISABLED', 'This account cannot be used', 403);
        // A guest-checkout record exists for this email: attach a password, but expose nothing until the email is verified.
        await tx.customerBrandRelationship.update({ where: { id: existing.id }, data: { passwordHash } });
        relId = existing.id;
      } else {
        const customer = await tx.customer.create({
          data: { fullName: dto.fullName.trim(), email, phone: normPhone(dto.phone), country: dto.country ?? null, identities: { create: { type: 'EMAIL', value: email } } },
        });
        relId = (await tx.customerBrandRelationship.create({ data: { customerId: customer.id, brandId, email, passwordHash } })).id;
      }
      const created = await tx.customerBrandRelationship.findUniqueOrThrow({ where: { id: relId }, include: { customer: true } });
      if (dto.marketingOptIn) {
        await this.customers.recordConsent(tx, created.customerId, brandId, 'EMAIL', 'GRANTED', 'account', `I would like to receive news and offers from ${sf.brand.name}.`);
      }
      const token = await this.customers.issueToken(tx, created.id, 'EMAIL_VERIFY', 24 * 60);
      const base = { brandId, to: email, toName: dto.fullName.trim(), customerId: created.customerId };
      await this.notifications.enqueue({ ...base, type: 'EMAIL_VERIFICATION', payload: { name: dto.fullName.trim(), verifyUrl: `${this.siteUrl(sf)}/verify-email?token=${token}` } }, tx);
      await this.notifications.enqueue({ ...base, type: 'REGISTRATION_CONFIRMATION', payload: { name: dto.fullName.trim() }, dedupeKey: `registration:${created.id}` }, tx);
      return created;
    });
    await this.notifications.kick();
    return { token: this.token(rel), customer: this.profile(rel) };
  }

  @Post('customers/login')
  @HttpCode(200)
  @AllowSuspendedBrand()
  @RateLimit({ limit: 10, windowSec: 60 })
  async login(@Storefront() sf: StorefrontCtx, @Body() dto: LoginDto) {
    const rel = await this.prisma.customerBrandRelationship.findUnique({
      where: { brandId_email: { brandId: sf.brand.id, email: normEmail(dto.email) } }, include: { customer: true },
    });
    const ok = await verifyPassword(dto.password, rel?.passwordHash ?? DUMMY_HASH); // same work whether or not the account exists
    if (!rel || !rel.passwordHash || !ok || rel.status !== 'ACTIVE' || rel.customer.status !== 'ACTIVE') {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }
    await this.prisma.customerBrandRelationship.update({ where: { id: rel.id }, data: { lastLoginAt: new Date() } });
    return { token: this.token(rel), customer: this.profile(rel) };
  }

  /**
   * Confirms control of the email address. Together with a completed password reset, this is
   * the only operation that can link this brand account to a central customer identity already
   * verified on another brand.
   *
   * The caller must be signed in to the account being verified. Otherwise someone could
   * register with another person's email and have that person "confirm" the attacker's
   * account simply by clicking the link in the email (account pre-hijacking).
   */
  @Post('customers/verify-email')
  @HttpCode(200)
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  @RateLimit({ limit: 20, windowSec: 60 })
  async verifyEmail(@Storefront() sf: StorefrontCtx, @CurrentCustomer() c: CustomerCtx, @Body() dto: TokenDto) {
    const result = await this.prisma.tx(async (tx) => {
      const relationshipId = await this.customers.consumeToken(tx, dto.token, 'EMAIL_VERIFY');
      const rel = await tx.customerBrandRelationship.findUnique({ where: { id: relationshipId } });
      if (!rel || rel.brandId !== sf.brand.id || rel.id !== c.relationshipId) throw new AppError('TOKEN_INVALID', 'This link is invalid or has expired', 400);
      const linked = await this.customers.markEmailVerified(tx, relationshipId);
      return { rel, ...linked };
    });
    // The central customer id may have changed through linking, so a fresh token is issued.
    return { verified: true, linked: result.linked, token: this.token({ id: result.rel.id, customerId: result.customerId, brandId: result.rel.brandId, tokenVersion: result.rel.tokenVersion }) };
  }

  @Post('customers/resend-verification')
  @HttpCode(200)
  @UseGuards(CustomerGuard)
  @RateLimit({ limit: 3, windowSec: 60 })
  async resendVerification(@Storefront() sf: StorefrontCtx, @CurrentCustomer() c: CustomerCtx) {
    const rel = await this.relationship(c);
    if (rel.emailVerifiedAt) return { sent: false, alreadyVerified: true };
    const token = await this.customers.issueToken(this.prisma, rel.id, 'EMAIL_VERIFY', 24 * 60);
    await this.notifications.enqueue({
      brandId: rel.brandId, type: 'EMAIL_VERIFICATION', to: rel.email, toName: rel.customer.fullName, customerId: rel.customerId,
      payload: { name: rel.customer.fullName, verifyUrl: `${this.siteUrl(sf)}/verify-email?token=${token}` },
    });
    await this.notifications.kick();
    return { sent: true };
  }

  /** Always answers 200 so the response never reveals whether an account exists. */
  @Post('customers/password-reset/request')
  @HttpCode(200)
  @AllowSuspendedBrand()
  @RateLimit({ limit: 5, windowSec: 60 })
  async requestReset(@Storefront() sf: StorefrontCtx, @Body() dto: ResetRequestDto) {
    const rel = await this.prisma.customerBrandRelationship.findUnique({
      where: { brandId_email: { brandId: sf.brand.id, email: normEmail(dto.email) } }, include: { customer: true },
    });
    if (rel && rel.passwordHash && rel.status === 'ACTIVE') {
      const token = await this.customers.issueToken(this.prisma, rel.id, 'PASSWORD_RESET', 60);
      await this.notifications.enqueue({
        brandId: rel.brandId, type: 'PASSWORD_RESET', to: rel.email, toName: rel.customer.fullName, customerId: rel.customerId,
        payload: { name: rel.customer.fullName, resetUrl: `${this.siteUrl(sf)}/reset-password?token=${token}` },
      });
      await this.notifications.kick();
    }
    return { ok: true };
  }

  @Post('customers/password-reset/confirm')
  @HttpCode(200)
  @AllowSuspendedBrand()
  @RateLimit({ limit: 10, windowSec: 60 })
  async confirmReset(@Storefront() sf: StorefrontCtx, @Body() dto: ResetConfirmDto) {
    const passwordHash = await hashPassword(dto.password);
    await this.prisma.tx(async (tx) => {
      const relationshipId = await this.customers.consumeToken(tx, dto.token, 'PASSWORD_RESET');
      const rel = await tx.customerBrandRelationship.findUnique({ where: { id: relationshipId } });
      if (!rel || rel.brandId !== sf.brand.id) throw new AppError('TOKEN_INVALID', 'This link is invalid or has expired', 400);
      // Completing a reset proves control of the mailbox: every existing session is revoked (so nobody
      // who set an earlier password keeps access) and the email counts as verified.
      await tx.customerBrandRelationship.update({ where: { id: rel.id }, data: { passwordHash, tokenVersion: { increment: 1 } } });
      await this.customers.markEmailVerified(tx, rel.id);
      // Any other outstanding reset links stop working.
      await tx.customerToken.updateMany({ where: { relationshipId: rel.id, purpose: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: new Date() } });
    });
    return { ok: true };
  }

  // ───────────────────────── Account ─────────────────────────

  @Get('customers/me')
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  async me(@CurrentCustomer() c: CustomerCtx) {
    const rel = await this.relationship(c);
    const [consents, preferences] = await Promise.all([
      this.customers.consentState(c.customerId, [c.brandId]),
      this.prisma.customerPreference.findMany({ where: { customerId: c.customerId, brandId: c.brandId } }),
    ]);
    return {
      ...this.profile(rel),
      // Consent shown here is for this brand only; other brands' consent is never exposed or implied.
      consents: Object.fromEntries((['EMAIL', 'SMS', 'WHATSAPP'] as const).map((ch) => [ch, consents.find((x) => x.channel === ch)?.status === 'GRANTED'])),
      preferences: Object.fromEntries(preferences.map((p) => [p.key, p.value])),
    };
  }

  @Patch('customers/me')
  @UseGuards(CustomerGuard)
  async updateMe(@CurrentCustomer() c: CustomerCtx, @Body() dto: UpdateMeDto) {
    await this.requireVerified(c);
    await this.prisma.customer.update({
      where: { id: c.customerId },
      data: { fullName: dto.fullName?.trim(), phone: dto.phone === undefined ? undefined : normPhone(dto.phone), country: dto.country, preferredCurrency: dto.preferredCurrency },
    });
    return this.profile(await this.relationship(c));
  }

  /** The customer's orders with this brand. Empty until the email address is verified. */
  @Get('customers/me/orders')
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  async myOrders(@CurrentCustomer() c: CustomerCtx) {
    const rel = await this.relationship(c);
    if (!rel.emailVerifiedAt) return { items: [], emailVerificationRequired: true };
    const orders = await this.prisma.order.findMany({
      where: { brandId: c.brandId, customerId: c.customerId },
      orderBy: { createdAt: 'desc' }, take: 200,
      include: { event: { select: { id: true, slug: true, name: true, startsAt: true, timezone: true, status: true } }, items: true, _count: { select: { tickets: true } } },
    });
    return {
      emailVerificationRequired: false,
      items: orders.map((o) => ({
        reference: o.reference, status: o.status, paymentStatus: o.paymentStatus, currency: o.currency, totalMinor: o.totalMinor, refundedMinor: o.refundedMinor,
        createdAt: o.createdAt, paidAt: o.paidAt, event: o.event, ticketCount: o._count.tickets,
        items: o.items.map((i) => ({ name: i.categoryName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor, lineTotalMinor: i.lineTotalMinor })),
      })),
    };
  }

  /** The customer's tickets with this brand. Empty until the email address is verified. */
  @Get('customers/me/tickets')
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  async myTickets(@CurrentCustomer() c: CustomerCtx) {
    const rel = await this.relationship(c);
    if (!rel.emailVerifiedAt) return { items: [], emailVerificationRequired: true };
    const tickets = await this.prisma.ticket.findMany({
      where: { brandId: c.brandId, customerId: c.customerId },
      orderBy: [{ event: { startsAt: 'asc' } }, { reference: 'asc' }], take: 500,
      include: { event: { include: { venue: true } }, ticketCategory: { select: { name: true } }, order: { select: { reference: true } } },
    });
    return {
      emailVerificationRequired: false,
      items: tickets.map((t) => ({
        id: t.id, reference: t.reference, status: t.status, category: t.ticketCategory.name, holderName: t.holderName, orderReference: t.order.reference,
        issuedAt: t.issuedAt, usedAt: t.usedAt,
        event: { id: t.event.id, slug: t.event.slug, name: t.event.name, startsAt: t.event.startsAt, timezone: t.event.timezone, status: t.event.status, venue: t.event.venue ? `${t.event.venue.name}, ${t.event.venue.city}` : null },
      })),
    };
  }

  /** Grants or withdraws marketing consent for THIS brand and channel only. */
  @Put('customers/me/consents')
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  async setConsent(@Storefront() sf: StorefrontCtx, @CurrentCustomer() c: CustomerCtx, @Body() dto: ConsentDto) {
    // Withdrawing is always allowed; granting needs a verified address so nobody can opt someone else in.
    if (dto.granted) await this.requireVerified(c);
    await this.customers.recordConsent(
      this.prisma, c.customerId, c.brandId, dto.channel, dto.granted ? 'GRANTED' : 'WITHDRAWN', 'account',
      dto.granted ? `I would like to receive ${dto.channel.toLowerCase()} news and offers from ${sf.brand.name}.` : undefined,
    );
    return { channel: dto.channel, granted: dto.granted };
  }

  @Put('customers/me/preferences/:key')
  @UseGuards(CustomerGuard)
  async setPreference(@CurrentCustomer() c: CustomerCtx, @Param('key') key: string, @Body() dto: PreferenceDto) {
    if (!PREF_KEY.test(key)) throw new AppError('PREFERENCE_KEY_INVALID', 'Invalid preference key', 400);
    if (JSON.stringify(dto.value ?? null).length > 2000) throw new AppError('PREFERENCE_TOO_LARGE', 'Preference value is too large', 400);
    await this.requireVerified(c);
    const value = dto.value as Prisma.InputJsonValue;
    await this.prisma.customerPreference.upsert({
      where: { customerId_brandId_key: { customerId: c.customerId, brandId: c.brandId, key } },
      create: { customerId: c.customerId, brandId: c.brandId, key, value }, update: { value },
    });
    return { key, value: dto.value };
  }

  /** Files a data access, correction or deletion request with this brand. */
  @Post('customers/me/data-requests')
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  @RateLimit({ limit: 5, windowSec: 3600 })
  async dataRequest(@CurrentCustomer() c: CustomerCtx, @Body() dto: DataRequestDto) {
    await this.requireVerified(c);
    const sla = await this.prisma.systemSetting.findUnique({ where: { key: 'privacy.dataRequestSlaDays' } });
    const days = Number((sla?.value as { days?: number } | null)?.days) || 30;
    const r = await this.prisma.dataSubjectRequest.create({
      data: { customerId: c.customerId, brandId: c.brandId, type: dto.type, details: dto.details, dueAt: new Date(Date.now() + days * 86400_000) },
    });
    return { id: r.id, type: r.type, status: r.status, dueAt: r.dueAt };
  }

  // ───────────────────────── Tickets ─────────────────────────

  /**
   * A ticket is visible to: its signed-in owner (verified email); a guest who knows the order
   * reference and the order's email (original tickets only); or a guest who knows the ticket
   * reference and the holder's email (covers tickets received by transfer).
   * "Not found" and "not yours" are indistinguishable.
   */
  private async accessTicket(sf: StorefrontCtx, id: string, q: TicketAccessQuery, authed?: CustomerCtx) {
    const t = await this.prisma.ticket.findFirst({
      where: { id, brandId: sf.brand.id },
      include: { order: true, event: { include: { venue: true } }, ticketCategory: { select: { name: true } } },
    });
    if (!t) throw notFound('Ticket');
    let allowed = false;
    if (authed && authed.customerId === t.customerId) {
      allowed = !!(await this.relationship(authed)).emailVerifiedAt;
    }
    const email = q.email ? normEmail(q.email) : null;
    if (!allowed && email && q.orderReference) {
      allowed = q.orderReference.toUpperCase() === t.order.reference && email === t.order.customerEmail && t.customerId === t.order.customerId;
    }
    if (!allowed && email && q.ticketReference) {
      allowed = q.ticketReference.toUpperCase() === t.reference && !!t.holderEmail && email === t.holderEmail;
    }
    if (!allowed) throw notFound('Ticket');
    return t;
  }

  /** Ticket detail with its QR code as SVG (only while the ticket is valid). */
  @ApiTags('Storefront · Tickets')
  @Get('tickets/:id')
  @AllowSuspendedBrand()
  @UseGuards(OptionalCustomerGuard)
  @RateLimit({ limit: 6000, windowSec: 60, by: 'storefront' })
  async ticket(@Storefront() sf: StorefrontCtx, @Param('id', ParseUUIDPipe) id: string, @Query() q: TicketAccessQuery, @CurrentCustomer() authed?: CustomerCtx) {
    const t = await this.accessTicket(sf, id, q, authed);
    return {
      id: t.id, reference: t.reference, status: t.status, category: t.ticketCategory.name, holderName: t.holderName, orderReference: t.order.reference,
      issuedAt: t.issuedAt, usedAt: t.usedAt,
      event: {
        id: t.event.id, slug: t.event.slug, name: t.event.name, startsAt: t.event.startsAt, doorsAt: t.event.doorsAt, timezone: t.event.timezone, status: t.event.status,
        venue: t.event.venue ? { name: t.event.venue.name, address: t.event.venue.address, city: t.event.venue.city } : null,
      },
      qrSvg: t.status === 'VALID' ? await this.docs.qrSvg(t.id) : null,
    };
  }

  /** Downloads the ticket as a PDF. */
  @ApiTags('Storefront · Tickets')
  @Get('tickets/:id/download')
  @AllowSuspendedBrand()
  @UseGuards(OptionalCustomerGuard)
  @RateLimit({ limit: 600, windowSec: 60, by: 'storefront' })
  async download(
    @Storefront() sf: StorefrontCtx, @Param('id', ParseUUIDPipe) id: string, @Query() q: TicketAccessQuery, @Res() res: Response, @CurrentCustomer() authed?: CustomerCtx,
  ) {
    const t = await this.accessTicket(sf, id, q, authed);
    if (t.status !== 'VALID') throw new AppError('TICKET_NOT_VALID', `This ticket is ${t.status.toLowerCase()} and cannot be downloaded`, 409);
    const doc = await this.docs.render(t.id);
    if (!doc) throw notFound('Ticket');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(doc.content);
  }

  /** Starts transferring a ticket to someone else. The recipient gets a claim link by email. */
  @ApiTags('Storefront · Tickets')
  @Post('tickets/:id/transfer')
  @UseGuards(CustomerGuard)
  @RateLimit({ limit: 10, windowSec: 60 })
  async transfer(@Storefront() sf: StorefrontCtx, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferDto, @CurrentCustomer() c: CustomerCtx) {
    const rel = await this.requireVerified(c);
    if (normEmail(dto.toEmail) === rel.email) throw new AppError('TRANSFER_TO_SELF', 'You already hold this ticket', 400);
    return this.tickets.startTransfer(id, { customerId: c.customerId, brandId: c.brandId, name: rel.customer.fullName }, { email: dto.toEmail, name: dto.toName }, this.siteUrl(sf));
  }

  /** Accepts a transferred ticket using the token from the claim email. */
  @ApiTags('Storefront · Tickets')
  @Post('tickets/transfers/claim')
  @HttpCode(200)
  @AllowSuspendedBrand()
  @RateLimit({ limit: 10, windowSec: 60 })
  async claim(@Storefront() sf: StorefrontCtx, @Body() dto: TokenDto) {
    const brandId = sf.brand.id;
    const result = await this.tickets.claimTransfer(dto.token, brandId, (tx, email, name) => this.customers.resolveForCheckout(tx, brandId, { email, fullName: name }));
    // The recipient can open the ticket with ticketReference + their email, or by signing in.
    return { ticketId: result.ticketId, ticketReference: result.reference };
  }

  // ───────────────────────── Support ─────────────────────────

  /** Opens a support request with this brand. Works for guests and signed-in customers. */
  @Post('support/tickets')
  @AllowSuspendedBrand()
  @UseGuards(OptionalCustomerGuard)
  @RateLimit({ limit: 5, windowSec: 60 })
  async createSupportTicket(@Storefront() sf: StorefrontCtx, @Body() dto: SupportCreateDto, @CurrentCustomer() authed?: CustomerCtx) {
    const brandId = sf.brand.id;
    const email = normEmail(dto.email);
    const rel = authed
      ? await this.relationship(authed)
      : await this.prisma.customerBrandRelationship.findUnique({ where: { brandId_email: { brandId, email } }, include: { customer: true } });
    let orderId: string | null = null;
    if (dto.orderReference) {
      const order = await this.prisma.order.findFirst({ where: { reference: dto.orderReference.toUpperCase(), brandId } });
      // An order is linked only when the requester demonstrably relates to it.
      if (order && (order.customerEmail === email || (authed && rel?.emailVerifiedAt && order.customerId === authed.customerId))) orderId = order.id;
    }
    const name = dto.name?.trim() || (authed ? rel?.customer.fullName : null) || null;
    const ticket = await this.prisma.supportTicket.create({
      data: {
        reference: reference('SUP', 8), brandId, customerId: rel?.customerId ?? null, orderId, contactEmail: authed && rel ? rel.email : email, contactName: name,
        issueType: dto.issueType ?? 'GENERAL_ENQUIRY', subject: dto.subject.trim(),
        messages: { create: { authorType: 'CUSTOMER', authorId: authed?.customerId ?? null, authorName: name, body: dto.message } },
      },
    });
    return { reference: ticket.reference, status: ticket.status, createdAt: ticket.createdAt };
  }

  @Get('support/tickets')
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  async mySupportTickets(@CurrentCustomer() c: CustomerCtx) {
    const rel = await this.relationship(c);
    if (!rel.emailVerifiedAt) return { items: [], emailVerificationRequired: true };
    const tickets = await this.prisma.supportTicket.findMany({
      where: { brandId: c.brandId, customerId: c.customerId }, orderBy: { updatedAt: 'desc' }, take: 100,
      include: { messages: { where: { internal: false }, orderBy: { createdAt: 'asc' } } },
    });
    return {
      emailVerificationRequired: false,
      items: tickets.map((t) => ({
        reference: t.reference, subject: t.subject, issueType: t.issueType, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt,
        messages: t.messages.map((m) => ({ from: m.authorType === 'CUSTOMER' ? 'you' : 'support', authorName: m.authorType === 'CUSTOMER' ? m.authorName : sfName(m.authorType), body: m.body, createdAt: m.createdAt })),
      })),
    };
  }

  @Post('support/tickets/:reference/messages')
  @AllowSuspendedBrand()
  @UseGuards(CustomerGuard)
  @RateLimit({ limit: 10, windowSec: 60 })
  async replySupportTicket(@CurrentCustomer() c: CustomerCtx, @Param('reference') ref: string, @Body() dto: SupportReplyDto) {
    const rel = await this.requireVerified(c);
    const ticket = await this.prisma.supportTicket.findFirst({ where: { reference: ref.toUpperCase(), brandId: c.brandId, customerId: c.customerId } });
    if (!ticket) throw notFound('Support request');
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({ data: { ticketId: ticket.id, authorType: 'CUSTOMER', authorId: c.customerId, authorName: rel.customer.fullName, body: dto.body } }),
      // A reply from the customer puts the request back in the team's queue (and reopens it if it was closed).
      this.prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: ['RESOLVED', 'CLOSED'].includes(ticket.status) ? 'OPEN' : 'PENDING_INTERNAL', resolvedAt: null } }),
    ]);
    return { reference: ticket.reference, ok: true };
  }
}

/** Customers see staff and system messages as coming from the support team, never an individual's name. */
function sfName(authorType: string) {
  return authorType === 'SYSTEM' ? 'System' : 'Support team';
}
