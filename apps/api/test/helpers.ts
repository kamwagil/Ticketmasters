import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { seedBase } from '../prisma/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { encryptJson, hashPassword, sha256 } from '../src/common/crypto';
import { PrismaService } from '../src/common/infra';
import { SandboxGatewayController } from '../src/modules/payments/webhook.controller';

export const PASSWORD = 'Test-Password-12345';

export async function createApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  await app.listen(0); // one real listener, so concurrent supertest calls share it instead of opening a server each
  return { app, prisma: app.get(PrismaService) };
}

const REFERENCE_TABLES = ['_prisma_migrations', 'permissions', 'roles', 'role_permissions', 'currencies', 'payment_providers', 'email_templates', 'system_settings'];
let baseSeeded = false;

/**
 * Empties all business tables and makes sure reference data exists. Rows are deleted with
 * triggers disabled for this one transaction (the append-only tables refuse DELETE otherwise);
 * this is much faster than TRUNCATE on the Docker-backed test database.
 */
export async function resetDb(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    ...tables.filter((t) => !REFERENCE_TABLES.includes(t.tablename)).map((t) => prisma.$executeRawUnsafe(`DELETE FROM "${t.tablename}"`)),
  ]);
  if (!baseSeeded) {
    await seedBase(prisma);
    baseSeeded = true;
  }
}

export interface TestBrand {
  id: string;
  slug: string;
  name: string;
  key: string;
  domain: string;
}
export interface Fixture {
  brands: TestBrand[];
  legalEntityId: string;
  accountId: string;
  organizerId: string;
  eventId: string;
  categoryId: string;
  vipCategoryId: string;
  users: Record<'superadmin' | 'finance' | 'finance2' | 'brand1admin' | 'brand2admin' | 'support1' | 'marketing1' | 'scanner', { id: string; email: string }>;
}

/** Five storefront brands selling the same event from one shared inventory pool. */
export async function buildFixture(prisma: PrismaService, opts: { total?: number; vipTotal?: number; brandCount?: number; maxPerOrder?: number } = {}): Promise<Fixture> {
  const le = await prisma.legalEntity.create({ data: { name: 'Test Holdings Ltd', country: 'KE' } });
  const account = await prisma.paymentProviderAccount.create({
    data: { providerCode: 'sandbox', legalEntityId: le.id, label: 'Sandbox test', livemode: false, currencies: ['KES'], credentialsEnc: encryptJson({ webhookSecret: 'whsec_test' }) },
  });
  const brands: TestBrand[] = [];
  for (let i = 1; i <= (opts.brandCount ?? 5); i++) {
    const key = `sfk_test_brand_${i}_${randomUUID()}`;
    const domain = `website${i}.test`;
    const b = await prisma.brand.create({
      data: {
        slug: `website-${i}`, name: `Website ${i}`, contactEmail: `help@website${i}.test`, emailSenderName: `Website ${i} Tickets`, emailSenderAddr: `tickets@website${i}.test`,
        primaryColor: `#${i}${i}22${i}${i}`, secondaryColor: '#ffaa00', supportPhone: `+25470000000${i}`, defaultCurrency: 'KES', currencies: ['KES'],
        domains: { create: { domain, isPrimary: true, verifiedAt: new Date() } },
        apiKeys: { create: { label: 'test', keyPrefix: key.slice(0, 12), keyHash: sha256(key) } },
        legalEntities: { create: { legalEntityId: le.id, isDefault: true } },
        paymentConfigs: { create: { providerAccountId: account.id, currencies: ['KES'], providerApproved: true } },
        policies: { create: [{ type: 'TERMS', version: 1, content: 'Terms v1 text' }, { type: 'REFUND', version: 2, content: 'Refund policy v2 text' }, { type: 'PRIVACY', version: 1, content: 'Privacy v1 text' }] },
      },
    });
    brands.push({ id: b.id, slug: b.slug, name: b.name, key, domain });
  }

  const organizer = await prisma.organizer.create({ data: { name: 'Test Promoter', contactEmail: 'promoter@test.local', verificationStatus: 'VERIFIED' } });
  const venue = await prisma.venue.create({ data: { name: 'Test Arena', city: 'Nairobi', country: 'Kenya' } });
  const category = await prisma.eventCategory.upsert({ where: { slug: 'concerts' }, create: { slug: 'concerts', name: 'Concerts' }, update: {} });
  const event = await prisma.event.create({
    data: {
      slug: `test-event-${randomUUID().slice(0, 8)}`, name: 'Shared Inventory Concert', description: 'Test event', categoryId: category.id, venueId: venue.id,
      organizerId: organizer.id, startsAt: new Date(Date.now() + 30 * 86400_000), endsAt: new Date(Date.now() + 30 * 86400_000 + 4 * 3600_000), status: 'PUBLISHED',
      publications: { create: brands.map((b) => ({ brandId: b.id })) },
    },
  });
  const mkCategory = async (name: string, price: bigint, total: number) => {
    const c = await prisma.ticketCategory.create({ data: { eventId: event.id, name, priceMinor: price, currency: 'KES', maxPerOrder: opts.maxPerOrder ?? 10 } });
    await prisma.ticketInventory.create({ data: { ticketCategoryId: c.id, total } });
    await prisma.inventoryMovement.create({ data: { ticketCategoryId: c.id, type: 'INITIAL', quantity: total, deltaTotal: total } });
    return c.id;
  };
  const categoryId = await mkCategory('General Admission', 100000n, opts.total ?? 100);
  const vipCategoryId = await mkCategory('VIP', 500000n, opts.vipTotal ?? 20);

  await prisma.commissionRule.createMany({
    data: [
      { name: 'Platform 5%', type: 'PLATFORM_COMMISSION', percentBps: 500 },
      { name: 'Service fee 4%', type: 'SERVICE_FEE', percentBps: 400 },
    ],
  });

  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));
  const pw = await hashPassword(PASSWORD);
  const mkUser = async (email: string, role: string, brandIds: string[] | 'all', eventIds: string[] = []) => {
    const u = await prisma.user.create({
      data: {
        email, fullName: email.split('@')[0], passwordHash: pw, allBrands: brandIds === 'all', roles: { create: { roleId: roles[role] } },
        brandAssignments: brandIds === 'all' ? undefined : { create: brandIds.map((brandId) => ({ brandId })) },
        eventAssignments: { create: eventIds.map((eventId) => ({ eventId })) },
      },
    });
    return { id: u.id, email };
  };
  const users = {
    superadmin: await mkUser('super@test.local', 'super_admin', 'all'),
    finance: await mkUser('finance@test.local', 'finance_officer', 'all'),
    finance2: await mkUser('finance2@test.local', 'finance_officer', 'all'),
    brand1admin: await mkUser('admin1@test.local', 'brand_admin', [brands[0].id]),
    brand2admin: await mkUser('admin2@test.local', 'brand_admin', [brands[1]?.id ?? brands[0].id]),
    support1: await mkUser('support1@test.local', 'customer_support', [brands[0].id]),
    marketing1: await mkUser('marketing1@test.local', 'marketing_manager', [brands[0].id]),
    scanner: await mkUser('scanner@test.local', 'ticket_scanner', brands.map((b) => b.id), [event.id]),
  };
  return { brands, legalEntityId: le.id, accountId: account.id, organizerId: organizer.id, eventId: event.id, categoryId, vipCategoryId, users };
}

// ── HTTP helpers ──

export const http = (app: INestApplication) => request(app.getHttpServer());

/** Storefront request helper: authenticates as that brand's storefront server. */
export function storefront(app: INestApplication, brand: TestBrand, customerToken?: string) {
  const headers: Record<string, string> = { 'X-Storefront-Key': brand.key, 'X-Storefront-Domain': brand.domain };
  if (customerToken) headers['X-Customer-Token'] = customerToken;
  return {
    get: (url: string) => http(app).get(`/v1/storefront${url}`).set(headers),
    post: (url: string, body?: object) => http(app).post(`/v1/storefront${url}`).set(headers).send(body ?? {}),
    put: (url: string, body?: object) => http(app).put(`/v1/storefront${url}`).set(headers).send(body ?? {}),
  };
}

export async function login(app: INestApplication, email: string): Promise<string> {
  const res = await http(app).post('/v1/admin/auth/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

export function admin(app: INestApplication, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: (url: string) => http(app).get(`/v1/admin${url}`).set(auth),
    post: (url: string, body?: object) => http(app).post(`/v1/admin${url}`).set(auth).send(body ?? {}),
    patch: (url: string, body?: object) => http(app).patch(`/v1/admin${url}`).set(auth).send(body ?? {}),
    put: (url: string, body?: object) => http(app).put(`/v1/admin${url}`).set(auth).send(body ?? {}),
    delete: (url: string) => http(app).delete(`/v1/admin${url}`).set(auth),
    raw: (method: 'get' | 'post', url: string) => http(app)[method](url).set(auth),
  };
}

export interface CheckoutResult {
  status: number;
  body: any;
}

export async function checkout(
  app: INestApplication, brand: TestBrand, fx: Fixture,
  o: { email: string; name?: string; quantity?: number; categoryId?: string; marketingOptIn?: boolean; promoCode?: string; idempotencyKey?: string; customerToken?: string } ,
): Promise<CheckoutResult> {
  const res = await storefront(app, brand, o.customerToken)
    .post('/checkout/orders', {
      eventId: fx.eventId,
      items: [{ ticketCategoryId: o.categoryId ?? fx.categoryId, quantity: o.quantity ?? 1 }],
      customer: { email: o.email, fullName: o.name ?? 'Test Buyer', phone: '+254711000111', country: 'Kenya' },
      acceptPolicies: true, marketingOptIn: o.marketingOptIn, promoCode: o.promoCode,
    })
    .set('Idempotency-Key', o.idempotencyKey ?? randomUUID());
  return { status: res.status, body: res.body };
}

/** Plays the gateway: settles the sandbox transaction and builds the signed webhook it would send. */
export async function gatewayWebhook(app: INestApplication, paymentReference: string, outcome: 'success' | 'failed') {
  return app.get(SandboxGatewayController).settle(paymentReference, outcome);
}

export function deliverWebhook(app: INestApplication, wh: { accountId: string; rawBody: string; signature: string }) {
  return http(app).post(`/v1/webhooks/sandbox/${wh.accountId}`).set('Content-Type', 'application/json').set('x-sandbox-signature', wh.signature).send(wh.rawBody);
}

/** Checkout + successful gateway payment + webhook. Returns the order reference. */
export async function purchase(app: INestApplication, brand: TestBrand, fx: Fixture, o: Parameters<typeof checkout>[3]) {
  const c = await checkout(app, brand, fx, o);
  if (c.status !== 201) throw new Error(`checkout failed: ${c.status} ${JSON.stringify(c.body)}`);
  const wh = await gatewayWebhook(app, c.body.payment.reference, 'success');
  const res = await deliverWebhook(app, wh);
  if (res.status !== 200) throw new Error(`webhook failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { orderReference: c.body.orderReference as string, paymentReference: c.body.payment.reference as string, webhook: wh, checkout: c.body };
}

/**
 * Runs tasks with a bounded number in flight. The burst tests fire hundreds of requests; without a
 * cap the test client itself overflows the OS accept backlog (ECONNREFUSED) before the API sees them.
 */
export async function concurrently<T>(tasks: (() => Promise<T>)[], limit = 100): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}
