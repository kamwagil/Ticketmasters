import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { promises as dns } from 'dns';
import {
  AllowSuspendedBrand, assertBrandAccess, assertPlatformWide, CurrentStaff, Permissions, Staff, StaffGuard, Storefront, StorefrontCtx, StorefrontGuard,
} from '../../common/auth';
import { config } from '../../common/config';
import { encryptJson, randomToken, sha256 } from '../../common/crypto';
import { AppError, notFound } from '../../common/errors';
import { AuditService, PrismaService, RedisService } from '../../common/infra';

const HEX = /^#[0-9a-fA-F]{6}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(:\d{2,5})?$/;
const CUR = /^[A-Z]{3}$/;

class CreateBrandDto {
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{1,40}$/) slug: string;
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsEmail() contactEmail: string;
  @IsString() @MinLength(2) emailSenderName: string;
  @IsEmail() emailSenderAddr: string;
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @Matches(HEX) primaryColor?: string;
  @IsOptional() @Matches(HEX) secondaryColor?: string;
  @IsOptional() @IsString() supportPhone?: string;
  @IsOptional() @IsString() supportUrl?: string;
  @IsOptional() @IsString() businessAddress?: string;
  @IsOptional() @Matches(CUR) defaultCurrency?: string;
  @IsOptional() @IsArray() @Matches(CUR, { each: true }) currencies?: string[];
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) enabledPaymentMethods?: string[];
  @IsOptional() @IsInt() @Min(120) @Max(3600) reservationTtlSeconds?: number;
}
class UpdateBrandDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() @MinLength(2) emailSenderName?: string;
  @IsOptional() @IsEmail() emailSenderAddr?: string;
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @Matches(HEX) primaryColor?: string;
  @IsOptional() @Matches(HEX) secondaryColor?: string;
  @IsOptional() @IsString() supportPhone?: string;
  @IsOptional() @IsString() supportUrl?: string;
  @IsOptional() @IsString() businessAddress?: string;
  @IsOptional() @Matches(CUR) defaultCurrency?: string;
  @IsOptional() @IsArray() @Matches(CUR, { each: true }) currencies?: string[];
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) enabledPaymentMethods?: string[];
  @IsOptional() @IsInt() @Min(120) @Max(3600) reservationTtlSeconds?: number;
}
class StatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED', 'INACTIVE']) status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';
  @IsString() @MinLength(3) reason: string;
}
class DomainDto {
  @Matches(DOMAIN) domain: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}
class VerifyDomainDto {
  /** Platform administrators may confirm ownership manually (e.g. for localhost development domains). */
  @IsOptional() @IsBoolean() manual?: boolean;
}
class ApiKeyDto {
  @IsString() @MinLength(2) @MaxLength(80) label: string;
}
class PolicyDto {
  @IsIn(['TERMS', 'REFUND', 'PRIVACY']) type: 'TERMS' | 'REFUND' | 'PRIVACY';
  @IsString() @MinLength(10) content: string;
}
class SettingDto {
  @IsObject() value: Record<string, unknown>;
}
class LegalEntityDto {
  @IsString() @MinLength(2) name: string;
  @IsString() @MinLength(2) country: string;
  @IsOptional() @IsString() registrationNumber?: string;
  @IsOptional() @IsString() taxNumber?: string;
  @IsOptional() @IsString() address?: string;
}
class AssignEntityDto {
  @IsUUID() legalEntityId: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
class ProviderAccountDto {
  @IsIn(['paystack', 'flutterwave', 'sandbox']) providerCode: string;
  @IsUUID() legalEntityId: string;
  @IsString() @MinLength(2) label: string;
  @IsBoolean() livemode: boolean;
  @IsArray() @ArrayNotEmpty() @Matches(CUR, { each: true }) currencies: string[];
  /**
   * Provider credentials, encrypted at rest and never returned by the API.
   * paystack: { secretKey }. flutterwave: { secretKey, webhookHash }. sandbox: { webhookSecret }.
   */
  @IsObject() credentials: Record<string, string>;
  @IsOptional() @IsString() publicKey?: string;
  @IsOptional() @IsString() merchantRef?: string;
}
class UpdateProviderAccountDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsArray() @Matches(CUR, { each: true }) currencies?: string[];
  @IsOptional() @IsObject() credentials?: Record<string, string>;
  @IsOptional() @IsString() publicKey?: string;
  @IsOptional() @IsString() merchantRef?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class PaymentConfigDto {
  @IsUUID() providerAccountId: string;
  @IsArray() @ArrayNotEmpty() @Matches(CUR, { each: true }) currencies: string[];
  @IsOptional() @IsInt() @Min(1) priority?: number;
  /** Operator attestation that the payment provider approved this brand/domain on the merchant account. */
  @IsBoolean() providerApproved: boolean;
  @IsOptional() @IsString() approvalNote?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

const accountView = {
  id: true, providerCode: true, label: true, livemode: true, currencies: true, publicKey: true, merchantRef: true, active: true, createdAt: true,
  legalEntity: { select: { id: true, name: true, country: true } },
} as const;

export const domainVerificationToken = (domainId: string) => `ctp-verify=${sha256(domainId + config.dataEncryptionKey).slice(0, 32)}`;

@ApiTags('Admin · Brands')
@ApiBearerAuth()
@Controller('v1/admin')
@UseGuards(StaffGuard)
export class BrandsController {
  constructor(private prisma: PrismaService, private audit: AuditService, private redis: RedisService) {}

  private log(staff: Staff, action: string, brandId: string | null, entityType: string, entityId: string, before?: unknown, after?: unknown) {
    return this.audit.record({ actorType: 'USER', actorId: staff.userId, actorLabel: staff.email, brandId, action, entityType, entityId, before, after });
  }

  @Get('brands')
  @Permissions('brands.read')
  list(@CurrentStaff() staff: Staff) {
    return this.prisma.brand.findMany({
      where: staff.allBrands ? {} : { id: { in: staff.brandIds } },
      include: { domains: true, _count: { select: { orders: true, relationships: true, publications: true } } },
      orderBy: { name: 'asc' },
    });
  }

  @Get('brands/:id')
  @Permissions('brands.read')
  async get(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string) {
    assertBrandAccess(staff, id);
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      include: {
        domains: { orderBy: { createdAt: 'asc' } },
        apiKeys: { select: { id: true, label: true, keyPrefix: true, lastUsedAt: true, revokedAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        settings: true,
        policies: { orderBy: [{ type: 'asc' }, { version: 'desc' }] },
        legalEntities: { include: { legalEntity: true } },
        paymentConfigs: { include: { providerAccount: { select: accountView } }, orderBy: { priority: 'asc' } },
        staff: { select: { user: { select: { id: true, fullName: true, email: true, status: true } } } },
      },
    });
    if (!brand) throw notFound('Brand');
    return {
      ...brand,
      domains: brand.domains.map((d) => ({ ...d, verificationRecord: { host: `_ctp-verify.${d.domain.split(':')[0]}`, type: 'TXT', value: domainVerificationToken(d.id) } })),
    };
  }

  /** Registers a new storefront brand. New brands are added purely through configuration. */
  @Post('brands')
  @Permissions('brands.manage')
  async create(@CurrentStaff() staff: Staff, @Body() dto: CreateBrandDto) {
    assertPlatformWide(staff);
    const brand = await this.prisma.brand.create({
      data: { ...dto, defaultCurrency: dto.defaultCurrency ?? 'KES', currencies: dto.currencies ?? [dto.defaultCurrency ?? 'KES'] },
    });
    await this.log(staff, 'brand.create', brand.id, 'brand', brand.id, undefined, brand);
    return brand;
  }

  @Patch('brands/:id')
  @Permissions('brands.manage')
  async update(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBrandDto) {
    assertBrandAccess(staff, id);
    const before = await this.prisma.brand.findUnique({ where: { id } });
    if (!before) throw notFound('Brand');
    const brand = await this.prisma.brand.update({ where: { id }, data: dto });
    await this.redis.invalidate(`sf:${id}:`);
    await this.log(staff, 'brand.update', id, 'brand', id, before, dto);
    return brand;
  }

  /** Suspending a brand blocks new purchases; existing orders, tickets and support keep working. */
  @Post('brands/:id/status')
  @Permissions('brands.manage')
  async setStatus(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    assertPlatformWide(staff);
    const before = await this.prisma.brand.findUnique({ where: { id } });
    if (!before) throw notFound('Brand');
    const brand = await this.prisma.brand.update({ where: { id }, data: { status: dto.status } });
    await this.redis.invalidate(`sf:${id}:`);
    await this.log(staff, 'brand.status_change', id, 'brand', id, { status: before.status }, { status: dto.status, reason: dto.reason });
    return brand;
  }

  // ── Domains ──

  @Post('brands/:id/domains')
  @Permissions('brands.manage')
  async addDomain(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DomainDto) {
    assertPlatformWide(staff);
    const domain = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) await tx.brandDomain.updateMany({ where: { brandId: id }, data: { isPrimary: false } });
      return tx.brandDomain.create({ data: { brandId: id, domain: dto.domain.toLowerCase(), isPrimary: dto.isPrimary ?? false } });
    });
    await this.log(staff, 'brand.domain_add', id, 'brand_domain', domain.id, undefined, domain);
    return { ...domain, verificationRecord: { host: `_ctp-verify.${domain.domain.split(':')[0]}`, type: 'TXT', value: domainVerificationToken(domain.id) } };
  }

  /** Verifies domain ownership through a DNS TXT record (or manual confirmation by a platform administrator). */
  @Post('domains/:domainId/verify')
  @Permissions('brands.manage')
  async verifyDomain(@CurrentStaff() staff: Staff, @Param('domainId', ParseUUIDPipe) domainId: string, @Body() dto: VerifyDomainDto) {
    assertPlatformWide(staff);
    const d = await this.prisma.brandDomain.findUnique({ where: { id: domainId } });
    if (!d) throw notFound('Domain');
    let method = 'manual';
    if (!dto.manual) {
      method = 'dns_txt';
      const expected = domainVerificationToken(d.id);
      let records: string[][] = [];
      try {
        records = await dns.resolveTxt(`_ctp-verify.${d.domain.split(':')[0]}`);
      } catch {
        /* treated as "record not found" below */
      }
      if (!records.some((r) => r.join('') === expected)) {
        throw new AppError('DOMAIN_NOT_VERIFIED', 'The verification TXT record was not found. DNS changes can take time to propagate.', 422, {
          host: `_ctp-verify.${d.domain.split(':')[0]}`, expected,
        });
      }
    }
    const updated = await this.prisma.brandDomain.update({ where: { id: domainId }, data: { verifiedAt: new Date() } });
    await this.log(staff, 'brand.domain_verify', d.brandId, 'brand_domain', d.id, undefined, { method });
    return updated;
  }

  @Delete('domains/:domainId')
  @Permissions('brands.manage')
  async removeDomain(@CurrentStaff() staff: Staff, @Param('domainId', ParseUUIDPipe) domainId: string) {
    assertPlatformWide(staff);
    const d = await this.prisma.brandDomain.delete({ where: { id: domainId } });
    await this.log(staff, 'brand.domain_remove', d.brandId, 'brand_domain', d.id, d);
    return { ok: true };
  }

  // ── Storefront API keys ──

  /** Issues a storefront API key. The full key is shown exactly once. */
  @Post('brands/:id/api-keys')
  @Permissions('brands.manage')
  async createKey(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApiKeyDto) {
    assertPlatformWide(staff);
    const key = `sfk_${randomToken(32)}`;
    const rec = await this.prisma.storefrontApiKey.create({ data: { brandId: id, label: dto.label, keyPrefix: key.slice(0, 12), keyHash: sha256(key) } });
    await this.log(staff, 'brand.api_key_create', id, 'storefront_api_key', rec.id, undefined, { label: dto.label });
    return { id: rec.id, label: rec.label, keyPrefix: rec.keyPrefix, key };
  }

  @Delete('api-keys/:keyId')
  @Permissions('brands.manage')
  async revokeKey(@CurrentStaff() staff: Staff, @Param('keyId', ParseUUIDPipe) keyId: string) {
    assertPlatformWide(staff);
    const rec = await this.prisma.storefrontApiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    await this.log(staff, 'brand.api_key_revoke', rec.brandId, 'storefront_api_key', rec.id);
    return { ok: true };
  }

  // ── Policies (versioned; orders record the version in force at checkout) ──

  @Post('brands/:id/policies')
  @Permissions('brands.manage')
  async publishPolicy(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PolicyDto) {
    assertBrandAccess(staff, id);
    const last = await this.prisma.brandPolicy.findFirst({ where: { brandId: id, type: dto.type }, orderBy: { version: 'desc' } });
    const policy = await this.prisma.brandPolicy.create({
      data: { brandId: id, type: dto.type, content: dto.content, version: (last?.version ?? 0) + 1, createdBy: staff.userId },
    });
    await this.redis.invalidate(`sf:${id}:`);
    await this.log(staff, 'brand.policy_publish', id, 'brand_policy', policy.id, undefined, { type: dto.type, version: policy.version });
    return policy;
  }

  @Put('brands/:id/settings/:key')
  @Permissions('brands.manage')
  async putSetting(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Param('key') key: string, @Body() dto: SettingDto) {
    assertBrandAccess(staff, id);
    const value = dto.value as any;
    const s = await this.prisma.brandSetting.upsert({ where: { brandId_key: { brandId: id, key } }, create: { brandId: id, key, value }, update: { value } });
    await this.redis.invalidate(`sf:${id}:`);
    await this.log(staff, 'brand.setting_update', id, 'brand_setting', key, undefined, dto.value);
    return s;
  }

  // ── Legal entities ──

  @Get('legal-entities')
  @Permissions('brands.read')
  legalEntities(@CurrentStaff() staff: Staff) {
    return this.prisma.legalEntity.findMany({
      where: staff.allBrands ? {} : { brands: { some: { brandId: { in: staff.brandIds } } } },
      include: { brands: { include: { brand: { select: { id: true, name: true } } } } },
      orderBy: { name: 'asc' },
    });
  }

  @Post('legal-entities')
  @Permissions('brands.payment_config')
  async createLegalEntity(@CurrentStaff() staff: Staff, @Body() dto: LegalEntityDto) {
    assertPlatformWide(staff);
    const le = await this.prisma.legalEntity.create({ data: dto });
    await this.log(staff, 'legal_entity.create', null, 'legal_entity', le.id, undefined, le);
    return le;
  }

  @Post('brands/:id/legal-entities')
  @Permissions('brands.payment_config')
  async assignLegalEntity(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignEntityDto) {
    assertPlatformWide(staff);
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.brandLegalEntityAssignment.updateMany({ where: { brandId: id }, data: { isDefault: false } });
      return tx.brandLegalEntityAssignment.upsert({
        where: { brandId_legalEntityId: { brandId: id, legalEntityId: dto.legalEntityId } },
        create: { brandId: id, legalEntityId: dto.legalEntityId, isDefault: dto.isDefault ?? false },
        update: { isDefault: dto.isDefault ?? false },
      });
    });
    await this.log(staff, 'brand.legal_entity_assign', id, 'legal_entity', dto.legalEntityId, undefined, dto);
    return row;
  }

  // ── Payment merchant accounts and brand payment configuration ──

  @Get('payment-providers')
  @Permissions('brands.read')
  providers() {
    return this.prisma.paymentProvider.findMany({ orderBy: { name: 'asc' } });
  }

  @Get('payment-accounts')
  @Permissions('brands.payment_config')
  accounts(@CurrentStaff() staff: Staff) {
    assertPlatformWide(staff);
    return this.prisma.paymentProviderAccount.findMany({
      select: { ...accountView, brandConfigs: { select: { id: true, currencies: true, active: true, providerApproved: true, brand: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Post('payment-accounts')
  @Permissions('brands.payment_config')
  async createAccount(@CurrentStaff() staff: Staff, @Body() dto: ProviderAccountDto) {
    assertPlatformWide(staff);
    const provider = await this.prisma.paymentProvider.findUnique({ where: { code: dto.providerCode } });
    if (!provider?.enabled) throw new AppError('PROVIDER_UNAVAILABLE', 'Payment provider is not enabled', 400);
    if (provider.isTestOnly && dto.livemode) throw new AppError('PROVIDER_TEST_ONLY', 'The sandbox provider cannot be used in live mode', 400);
    const { credentials, ...rest } = dto;
    const account = await this.prisma.paymentProviderAccount.create({ data: { ...rest, credentialsEnc: encryptJson(credentials) }, select: accountView });
    await this.log(staff, 'payment_account.create', null, 'payment_provider_account', account.id, undefined, { ...rest, credentials: '[encrypted]' });
    return account;
  }

  @Patch('payment-accounts/:accountId')
  @Permissions('brands.payment_config')
  async updateAccount(@CurrentStaff() staff: Staff, @Param('accountId', ParseUUIDPipe) accountId: string, @Body() dto: UpdateProviderAccountDto) {
    assertPlatformWide(staff);
    const { credentials, ...rest } = dto;
    const account = await this.prisma.paymentProviderAccount.update({
      where: { id: accountId },
      data: { ...rest, credentialsEnc: credentials ? encryptJson(credentials) : undefined },
      select: accountView,
    });
    await this.log(staff, 'payment_account.update', null, 'payment_provider_account', accountId, undefined, { ...rest, credentialsRotated: !!credentials });
    return account;
  }

  /** Links a brand to a merchant account for specific currencies. Only provider-approved links can take payments. */
  @Post('brands/:id/payment-configs')
  @Permissions('brands.payment_config')
  async upsertPaymentConfig(@CurrentStaff() staff: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentConfigDto) {
    assertPlatformWide(staff);
    const account = await this.prisma.paymentProviderAccount.findUnique({ where: { id: dto.providerAccountId } });
    if (!account) throw notFound('Merchant account');
    const unsupported = dto.currencies.filter((c) => !account.currencies.includes(c));
    if (unsupported.length) throw new AppError('CURRENCY_UNSUPPORTED', `Merchant account does not support: ${unsupported.join(', ')}`, 400);
    // The legal entity that owns the merchant account becomes a legal seller for this brand.
    const cfg = await this.prisma.$transaction(async (tx) => {
      const hasDefault = await tx.brandLegalEntityAssignment.count({ where: { brandId: id, isDefault: true } });
      await tx.brandLegalEntityAssignment.upsert({
        where: { brandId_legalEntityId: { brandId: id, legalEntityId: account.legalEntityId } },
        create: { brandId: id, legalEntityId: account.legalEntityId, isDefault: !hasDefault },
        update: {},
      });
      return tx.brandPaymentConfiguration.upsert({
        where: { brandId_providerAccountId: { brandId: id, providerAccountId: dto.providerAccountId } },
        create: { brandId: id, ...dto },
        update: dto,
      });
    });
    await this.log(staff, 'brand.payment_config_upsert', id, 'brand_payment_configuration', cfg.id, undefined, dto);
    return cfg;
  }

  @Delete('payment-configs/:configId')
  @Permissions('brands.payment_config')
  async removePaymentConfig(@CurrentStaff() staff: Staff, @Param('configId', ParseUUIDPipe) configId: string) {
    assertPlatformWide(staff);
    const cfg = await this.prisma.brandPaymentConfiguration.update({ where: { id: configId }, data: { active: false } });
    await this.log(staff, 'brand.payment_config_disable', cfg.brandId, 'brand_payment_configuration', cfg.id);
    return { ok: true };
  }
}

// ───────────────────────── Storefront: brand APIs ─────────────────────────

@ApiTags('Storefront · Brand')
@ApiSecurity('storefront-key')
@Controller('v1/storefront/brand')
@UseGuards(StorefrontGuard)
export class StorefrontBrandController {
  constructor(private prisma: PrismaService, private redis: RedisService) {}

  /** Resolves the calling storefront: brand identity, theme, currencies and status. */
  @Get()
  @AllowSuspendedBrand()
  resolve(@Storefront() sf: StorefrontCtx) {
    const b = sf.brand;
    return {
      id: b.id, slug: b.slug, name: b.name, status: b.status, domain: sf.domain, logoUrl: b.logoUrl,
      primaryColor: b.primaryColor, secondaryColor: b.secondaryColor, contactEmail: b.contactEmail, supportPhone: b.supportPhone,
      supportUrl: b.supportUrl, businessAddress: b.businessAddress, defaultCurrency: b.defaultCurrency, currencies: b.currencies,
      timezone: b.timezone, enabledPaymentMethods: b.enabledPaymentMethods, acceptingOrders: b.status === 'ACTIVE',
    };
  }

  /** Public settings configured for this storefront (keys prefixed "public."). */
  @Get('settings')
  @AllowSuspendedBrand()
  async settings(@Storefront() sf: StorefrontCtx) {
    const rows = await this.prisma.brandSetting.findMany({ where: { brandId: sf.brand.id, key: { startsWith: 'public.' } } });
    return Object.fromEntries(rows.map((r) => [r.key.slice(7), r.value]));
  }

  /** The current version of each published policy. */
  @Get('policies')
  @AllowSuspendedBrand()
  policies(@Storefront() sf: StorefrontCtx) {
    return this.redis.cached(`sf:${sf.brand.id}:policies`, 60, async () => {
      const rows = await this.prisma.brandPolicy.findMany({ where: { brandId: sf.brand.id }, orderBy: { version: 'desc' } });
      const latest: Record<string, { version: number; content: string; publishedAt: Date }> = {};
      for (const r of rows) if (!latest[r.type]) latest[r.type] = { version: r.version, content: r.content, publishedAt: r.publishedAt };
      return latest;
    });
  }
}
