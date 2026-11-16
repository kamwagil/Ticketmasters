import { INestApplication } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { decrypt, encrypt, generateTotpSecret, hashPassword, totpCode, verifyPassword, verifyTotp } from '../src/common/crypto';
import { clearRateLimitBuckets } from '../src/common/auth';
import { PrismaService, QueueService } from '../src/common/infra';
import { formatMoney, percentOf } from '../src/common/util';
import { LedgerService } from '../src/modules/payments/ledger.service';
import { majorToMinor, minorToMajor } from '../src/modules/payments/providers';
import { MaintenanceService } from '../src/modules/ops/maintenance.service';
import { admin, buildFixture, checkout, createApp, Fixture, http, login, PASSWORD, purchase, resetDb, storefront } from './helpers';

describe('Unit: money, ledger allocation and crypto', () => {
  it('percentages use basis points with half-up rounding in integer arithmetic', () => {
    expect(percentOf(100000n, 500)).toBe(5000n);
    expect(percentOf(999n, 250)).toBe(25n); // 24.975 → 25
    expect(percentOf(1n, 4999)).toBe(0n);
    expect(percentOf(1n, 5000)).toBe(1n);
    expect(percentOf(123456789012345n, 1)).toBe(12345678901n);
  });

  it('converts gateway decimal amounts without floating point', () => {
    expect(majorToMinor('1250.50')).toBe(125050n);
    expect(majorToMinor(0.1 + 0.2)).toBe(30n); // 0.30000000000000004 as a number
    expect(majorToMinor('19.99')).toBe(1999n);
    expect(majorToMinor('1000')).toBe(100000n);
    expect(minorToMajor(125050n)).toBe('1250.50');
    expect(minorToMajor(5n)).toBe('0.05');
    expect(() => majorToMinor('12.345')).toThrow();
    expect(() => majorToMinor('abc')).toThrow();
    expect(formatMoney(123456789n, 'KES')).toBe('KES 1,234,567.89');
    expect(formatMoney(-50n, 'USD')).toBe('-USD 0.50');
  });

  it('refund allocation never drifts: any sequence of partial refunds reverses every account exactly', () => {
    const ledger = new LedgerService(null as never);
    for (let trial = 0; trial < 300; trial++) {
      const rnd = (max: number) => BigInt(Math.floor(Math.random() * max));
      const fees = rnd(5000);
      const tax = rnd(3000);
      const platform = rnd(4000);
      const brand = rnd(2000);
      const promoter = rnd(200000) + 1n;
      const order = { totalMinor: fees + tax + platform + brand + promoter, feesMinor: fees, taxMinor: tax, platformCommissionMinor: platform, brandCommissionMinor: brand, promoterMinor: promoter };
      let refunded = 0n;
      const sum = { feesMinor: 0n, taxMinor: 0n, platformCommissionMinor: 0n, brandCommissionMinor: 0n, promoterMinor: 0n };
      while (refunded < order.totalMinor) {
        const remaining = order.totalMinor - refunded;
        const part = Math.random() < 0.3 ? remaining : (rnd(Number(remaining)) || 1n);
        const a = ledger.refundAllocation(order, sum, part);
        expect(a.feesMinor + a.taxMinor + a.platformCommissionMinor + a.brandCommissionMinor + a.promoterMinor).toBe(part);
        for (const k of Object.keys(sum) as (keyof typeof sum)[]) {
          expect(a[k] >= 0n).toBe(true);
          sum[k] += a[k];
          expect(sum[k] <= order[k]).toBe(true); // never reverses more than the account holds
        }
        refunded += part;
      }
      expect(sum).toEqual({ feesMinor: fees, taxMinor: tax, platformCommissionMinor: platform, brandCommissionMinor: brand, promoterMinor: promoter });
    }
  });

  it('field encryption round-trips and detects tampering; passwords and TOTP verify correctly', async () => {
    const enc = encrypt('sk_live_secret_value');
    expect(enc).not.toContain('sk_live');
    expect(decrypt(enc)).toBe('sk_live_secret_value');
    expect(encrypt('same')).not.toBe(encrypt('same')); // random IV
    const parts = enc.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
    expect(() => decrypt(parts.join('.'))).toThrow();

    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);

    // RFC 6238 test vector (SHA-1, secret "12345678901234567890", T = 59s → 287082).
    expect(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(secret))).toBe(true);
    expect(verifyTotp(secret, '000000') && totpCode(secret) !== '000000').toBe(false);
  });
});

describe('Security, validation and operations', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;
  let root: string;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    fx = await buildFixture(prisma);
    root = await login(app, fx.users.superadmin.email);
  });
  afterAll(() => app.close());

  it('returns a consistent error shape, security headers and a correlation id', async () => {
    const res = await http(app).get('/v1/admin/orders').set('X-Request-Id', 'trace-abc-12345');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED', correlationId: 'trace-abc-12345' });
    expect(res.headers['x-request-id']).toBe('trace-abc-12345');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect((await http(app).get('/health/live')).body.status).toBe('ok');
    expect((await http(app).get('/health/ready')).body.database).toBe(true);
  });

  it('validates input strictly: unknown fields, wrong types and injection strings are rejected or harmless', async () => {
    const sf = storefront(app, fx.brands[0]);
    const base = { eventId: fx.eventId, items: [{ ticketCategoryId: fx.categoryId, quantity: 1 }], customer: { email: 'a@example.com', fullName: 'Valid Name' }, acceptPolicies: true };
    const post = (body: object, key = `v-${Math.random()}`) => sf.post('/checkout/orders', body).set('Idempotency-Key', key);

    expect((await post({ ...base, totalMinor: 1 })).body.error.code).toBe('VALIDATION_FAILED'); // cannot dictate the price
    expect((await post({ ...base, brandId: fx.brands[1].id })).status).toBe(400); // cannot dictate the brand
    expect((await post({ ...base, items: [{ ticketCategoryId: fx.categoryId, quantity: -5 }] })).status).toBe(400);
    expect((await post({ ...base, items: [{ ticketCategoryId: fx.categoryId, quantity: 1.5 }] })).status).toBe(400);
    expect((await post({ ...base, items: [{ ticketCategoryId: fx.categoryId, quantity: 11 }] })).body.error.code).toBe('QUANTITY_OUT_OF_RANGE');
    expect((await post({ ...base, items: [] })).status).toBe(400);
    expect((await post({ ...base, customer: { email: 'not-an-email', fullName: 'X Y' } })).status).toBe(400);
    expect((await post({ ...base, acceptPolicies: false })).status).toBe(400);
    expect((await sf.post('/checkout/orders', base)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await post({ ...base, items: [{ ticketCategoryId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] })).body.error.code).toBe('CATEGORY_NOT_FOUND');
    expect((await post({ ...base, returnUrl: 'https://evil.example/phish' })).status).toBe(201); // accepted, but the redirect target is replaced

    // SQL metacharacters in search parameters are just text.
    const inj = encodeURIComponent(`'; DROP TABLE orders; --`);
    for (const path of [`/orders?q=${inj}`, `/customers?q=${inj}`, `/tickets?q=${inj}`, `/payments?q=${inj}`, `/events?q=${inj}`]) {
      expect((await admin(app, root).get(path)).status).toBe(200);
    }
    expect((await storefront(app, fx.brands[0]).get(`/events?q=${inj}`)).status).toBe(200);
    expect(await prisma.order.count()).toBeGreaterThan(0);
    expect((await admin(app, root).get('/orders?pageSize=100000')).status).toBe(400);
    expect((await admin(app, root).get('/orders/not-a-uuid')).status).toBe(400);
  });

  it('open-redirect protection: the gateway return URL must be on the storefront’s own domain', async () => {
    const sf = storefront(app, fx.brands[0]);
    const body = { eventId: fx.eventId, items: [{ ticketCategoryId: fx.categoryId, quantity: 1 }], customer: { email: 'r@example.com', fullName: 'Return Url' }, acceptPolicies: true };
    const evil = await sf.post('/checkout/orders', { ...body, returnUrl: 'https://evil.example/phish' }).set('Idempotency-Key', 'ret-1');
    const good = await sf.post('/checkout/orders', { ...body, returnUrl: `https://${fx.brands[0].domain}/thanks?x=1` }).set('Idempotency-Key', 'ret-2');
    const t1 = await prisma.sandboxGatewayTransaction.findUniqueOrThrow({ where: { reference: evil.body.payment.reference } });
    const t2 = await prisma.sandboxGatewayTransaction.findUniqueOrThrow({ where: { reference: good.body.payment.reference } });
    expect(t1.callbackUrl).toBe(`https://${fx.brands[0].domain}/orders/${evil.body.orderReference}`);
    expect(t2.callbackUrl).toBe(`https://${fx.brands[0].domain}/thanks?x=1`);
  });

  it('prices come from the server: commission precedence, promo codes and free orders', async () => {
    const w1 = fx.brands[0];
    const sf = storefront(app, w1);
    const items = [{ ticketCategoryId: fx.categoryId, quantity: 2 }];
    const q0 = await sf.post('/checkout/quote', { eventId: fx.eventId, items });
    expect(q0.body).toMatchObject({ subtotalMinor: 200000, feesMinor: 8000, totalMinor: 208000, currency: 'KES' });

    // An event-specific service fee overrides the platform default; a brand rule for another brand is ignored.
    await prisma.commissionRule.createMany({
      data: [
        { name: 'Event fee 10% + KES 50/ticket', type: 'SERVICE_FEE', eventId: fx.eventId, percentBps: 1000, fixedMinor: 5000n, currency: 'KES' },
        { name: 'Other brand fee', type: 'SERVICE_FEE', brandId: fx.brands[1].id, percentBps: 9000 },
        { name: 'VAT 16%', type: 'TAX', percentBps: 1600 },
      ],
    });
    const q1 = await sf.post('/checkout/quote', { eventId: fx.eventId, items });
    expect(q1.body.feesMinor).toBe(30000); // 10% of 200,000 + 2 × 5,000
    expect(q1.body.taxMinor).toBe(36800); // 16% of (200,000 + 30,000)
    expect(q1.body.totalMinor).toBe(266800);
    await prisma.commissionRule.deleteMany({ where: { name: { in: ['Event fee 10% + KES 50/ticket', 'Other brand fee', 'VAT 16%'] } } });

    // Promo codes: brand-bound, limited, and validated server-side.
    await prisma.promoCode.createMany({
      data: [
        { brandId: w1.id, code: 'TEN', discountType: 'PERCENT', percentBps: 1000, maxRedemptions: 1 },
        { brandId: w1.id, code: 'FREE', discountType: 'PERCENT', percentBps: 10000 },
        { brandId: w1.id, code: 'OLD', discountType: 'PERCENT', percentBps: 5000, endsAt: new Date(Date.now() - 1000) },
      ],
    });
    const q2 = await sf.post('/checkout/quote', { eventId: fx.eventId, items, promoCode: 'ten' });
    expect(q2.body).toMatchObject({ discountMinor: 20000, feesMinor: 7200, totalMinor: 187200 });
    expect((await sf.post('/checkout/quote', { eventId: fx.eventId, items, promoCode: 'OLD' })).body.error.code).toBe('PROMO_EXPIRED');
    expect((await sf.post('/checkout/quote', { eventId: fx.eventId, items, promoCode: 'NOPE' })).body.error.code).toBe('PROMO_INVALID');
    expect((await storefront(app, fx.brands[1]).post('/checkout/quote', { eventId: fx.eventId, items, promoCode: 'TEN' })).body.error.code).toBe('PROMO_INVALID'); // another brand's code

    const first = await checkout(app, w1, fx, { email: 'promo1@example.com', quantity: 2, promoCode: 'TEN' });
    expect(first.status).toBe(201);
    expect(first.body.totalMinor).toBe(187200);
    const second = await checkout(app, w1, fx, { email: 'promo2@example.com', quantity: 2, promoCode: 'TEN' });
    expect(second.body.error.code).toBe('PROMO_EXHAUSTED');
    // Cancelling the first order gives the redemption back.
    await storefront(app, w1).post(`/orders/${first.body.orderReference}/cancel?email=promo1@example.com`);
    expect((await checkout(app, w1, fx, { email: 'promo2@example.com', quantity: 2, promoCode: 'TEN' })).status).toBe(201);

    // A 100% discount completes without a gateway and still issues tickets and emails.
    const free = await checkout(app, w1, fx, { email: 'free@example.com', quantity: 1, promoCode: 'FREE' });
    expect(free.status).toBe(201);
    expect(free.body).toMatchObject({ status: 'TICKETS_ISSUED', totalMinor: 0, payment: null });
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: free.body.orderReference }, include: { tickets: true, payments: true } });
    expect(order.tickets).toHaveLength(1);
    expect(order.payments).toHaveLength(0);
    expect(await prisma.financialLedgerEntry.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('respects sales windows, category status and capacity rules', async () => {
    const sf = storefront(app, fx.brands[0]);
    const quote = () => sf.post('/checkout/quote', { eventId: fx.eventId, items: [{ ticketCategoryId: fx.vipCategoryId, quantity: 1 }] });
    await prisma.ticketCategory.update({ where: { id: fx.vipCategoryId }, data: { salesStartAt: new Date(Date.now() + 3600_000) } });
    expect((await quote()).body.error.code).toBe('SALES_NOT_STARTED');
    await prisma.ticketCategory.update({ where: { id: fx.vipCategoryId }, data: { salesStartAt: null, salesEndAt: new Date(Date.now() - 1000) } });
    expect((await quote()).body.error.code).toBe('SALES_ENDED');
    await prisma.ticketCategory.update({ where: { id: fx.vipCategoryId }, data: { salesEndAt: null, status: 'PAUSED' } });
    expect((await quote()).body.error.code).toBe('CATEGORY_CLOSED');
    await prisma.ticketCategory.update({ where: { id: fx.vipCategoryId }, data: { status: 'ACTIVE' } });
    // A brand-specific sales window applies to that storefront only.
    await prisma.eventBrandPublication.update({ where: { eventId_brandId: { eventId: fx.eventId, brandId: fx.brands[0].id } }, data: { salesStartAt: new Date(Date.now() + 3600_000) } });
    expect((await quote()).body.error.code).toBe('SALES_NOT_STARTED');
    expect((await storefront(app, fx.brands[1]).post('/checkout/quote', { eventId: fx.eventId, items: [{ ticketCategoryId: fx.vipCategoryId, quantity: 1 }] })).status).toBe(200);
    await prisma.eventBrandPublication.update({ where: { eventId_brandId: { eventId: fx.eventId, brandId: fx.brands[0].id } }, data: { salesStartAt: null } });

    // Brand-specific price: Website 2 sells VIP at a different price from the same inventory.
    const pub = await admin(app, root).put(`/events/${fx.eventId}/publications/${fx.brands[1].id}`, { priceOverrides: [{ ticketCategoryId: fx.vipCategoryId, priceMinor: 450000 }] });
    expect(pub.status).toBe(200);
    expect((await storefront(app, fx.brands[1]).post('/checkout/quote', { eventId: fx.eventId, items: [{ ticketCategoryId: fx.vipCategoryId, quantity: 1 }] })).body.subtotalMinor).toBe(450000);
    expect((await quote()).body.subtotalMinor).toBe(500000);

    // Capacity cannot be reduced below what is already sold or held.
    await purchase(app, fx.brands[0], fx, { email: 'vip@example.com', quantity: 3, categoryId: fx.vipCategoryId });
    const tooLow = await admin(app, root).post(`/ticket-categories/${fx.vipCategoryId}/inventory`, { total: 2, note: 'Reduce below sold' });
    expect(tooLow.body.error.code).toBe('INVENTORY_BELOW_COMMITTED');
    const ok = await admin(app, root).post(`/ticket-categories/${fx.vipCategoryId}/inventory`, { total: 30, note: 'Venue released more seats' });
    expect(ok.body).toMatchObject({ total: 30, delta: 10 });
  });

  it('staff sign-in: lockout, refresh rotation, MFA and tamper-proof tokens', async () => {
    const email = fx.users.brand2admin.email;
    // Tokens signed with another key, or of the wrong type, are refused.
    const forged = jwt.sign({ sub: fx.users.superadmin.id, sid: 'x', typ: 'staff' }, 'attacker-secret');
    expect((await admin(app, forged).get('/orders')).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: fx.users.superadmin.id, typ: 'staff' })).toString('base64url')}.`;
    expect((await admin(app, none).get('/orders')).status).toBe(401);

    // Refresh tokens rotate: a used refresh token cannot be replayed.
    const loginRes = await http(app).post('/v1/admin/auth/login').send({ email, password: PASSWORD });
    const cookie = loginRes.headers['set-cookie'][0].split(';')[0];
    expect(loginRes.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(loginRes.headers['set-cookie'][0]).toMatch(/SameSite=Strict/i);
    expect(loginRes.body.refreshToken).toBeUndefined();
    const r1 = await http(app).post('/v1/admin/auth/refresh').set('Cookie', cookie);
    expect(r1.status).toBe(200);
    expect((await http(app).post('/v1/admin/auth/refresh').set('Cookie', cookie)).status).toBe(401);

    // MFA: enrol, then sign-in demands the code.
    const token = r1.body.accessToken;
    const setup = await admin(app, token).post('/auth/mfa/setup');
    expect(setup.body.otpauthUri).toContain('otpauth://totp/');
    expect((await admin(app, token).post('/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await admin(app, token).post('/auth/mfa/enable', { code: totpCode(setup.body.secret) })).body.mfaEnabled).toBe(true);
    const noCode = await http(app).post('/v1/admin/auth/login').send({ email, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe('MFA_REQUIRED');
    expect((await http(app).post('/v1/admin/auth/login').send({ email, password: PASSWORD, totp: '123456' })).status).toBe(401);
    expect((await http(app).post('/v1/admin/auth/login').send({ email, password: PASSWORD, totp: totpCode(setup.body.secret) })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).mfaSecretEnc).toMatch(/^v1\./);

    // Lockout after repeated failures, with an alert for the security team.
    clearRateLimitBuckets(); // the per-IP limiter is covered by its own test below
    const target = fx.users.support1.email;
    for (let i = 0; i < 5; i++) expect((await http(app).post('/v1/admin/auth/login').send({ email: target, password: 'wrong-password' })).status).toBe(401);
    const locked = await http(app).post('/v1/admin/auth/login').send({ email: target, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(await prisma.alert.count({ where: { type: 'SUSPICIOUS_LOGIN' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_failed' } })).toBeGreaterThanOrEqual(5);
  });

  it('uploads accept only real images, judged by content', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = (buf: Buffer, name: string, type: string) => http(app).post('/v1/admin/uploads/image').set('Authorization', `Bearer ${root}`).attach('file', buf, { filename: name, contentType: type });
    const ok = await up(png, 'poster.png', 'image/png');
    expect(ok.status).toBe(201);
    expect(ok.body.url).toMatch(/\/media\/events\/[0-9a-f-]{36}\.png$/); // server-chosen name
    // A script renamed to .png with an image content type is rejected.
    const fake = await up(Buffer.from('<?php system($_GET["c"]); ?>'), 'shell.png', 'image/png');
    expect(fake.status).toBe(415);
    expect((await up(Buffer.from('<svg onload="alert(1)"></svg>'), 'x.svg', 'image/svg+xml')).status).toBe(415);
    expect((await up(Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]), 'big.png', 'image/png')).status).toBe(413);
    expect((await http(app).post('/v1/admin/uploads/image').attach('file', png, 'poster.png')).status).toBe(401);
  });

  it('exports neutralise spreadsheet formulas in customer-supplied text', async () => {
    await purchase(app, fx.brands[2], fx, { email: 'formula@example.com', name: '=HYPERLINK("http://evil.example","Click")' });
    const csv = await admin(app, root).get('/orders?format=csv&q=formula@example.com');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(`"'=HYPERLINK`);
    const xlsx = await admin(app, root).get('/orders?format=xlsx').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK'); // a real .xlsx (zip) file
  });

  it('event lifecycle: scheduled publication, cancellation notices and maintenance jobs', async () => {
    const maintenance = app.get(MaintenanceService);
    const queue = app.get(QueueService);
    const ev = await admin(app, root).post('/events', { name: 'Scheduled Show', startsAt: new Date(Date.now() + 20 * 86400_000).toISOString(), organizerId: fx.organizerId });
    expect(ev.status).toBe(201);
    expect((await admin(app, root).post(`/events/${ev.body.id}/status`, { action: 'publish' })).body.error.code).toBe('NO_TICKET_CATEGORIES');
    await admin(app, root).post(`/events/${ev.body.id}/ticket-categories`, { name: 'General', priceMinor: 50000, currency: 'KES', totalQuantity: 50 });
    await admin(app, root).put(`/events/${ev.body.id}/publications/${fx.brands[0].id}`, {});
    const sched = await admin(app, root).post(`/events/${ev.body.id}/status`, { action: 'schedule', publishAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(sched.body.status).toBe('SCHEDULED');
    expect((await storefront(app, fx.brands[0]).get(`/events/${ev.body.id}`)).status).toBe(404); // not visible before its time

    await prisma.event.update({ where: { id: ev.body.id }, data: { publishAt: new Date(Date.now() - 1000) } });
    await queue.add('maint-lifecycle', {});
    expect((await prisma.event.findUniqueOrThrow({ where: { id: ev.body.id } })).status).toBe('PUBLISHED');
    expect((await storefront(app, fx.brands[0]).get(`/events/${ev.body.id}`)).status).toBe(200);

    // Cancelling the main event emails every ticket holder as the brand they bought from.
    const cancel = await admin(app, root).post(`/events/${fx.eventId}/status`, { action: 'cancel', reason: 'The venue is unavailable due to flooding.' });
    expect(cancel.status).toBe(201);
    expect(cancel.body.notifiedOrders).toBeGreaterThan(0);
    const notices = await prisma.emailJob.findMany({ where: { type: 'EVENT_CANCELLATION' } });
    expect(notices).toHaveLength(cancel.body.notifiedOrders);
    for (const n of notices) expect((await prisma.order.findUniqueOrThrow({ where: { id: n.orderId! } })).brandId).toBe(n.brandId);
    expect((await storefront(app, fx.brands[0]).post('/checkout/quote', { eventId: fx.eventId, items: [{ ticketCategoryId: fx.categoryId, quantity: 1 }] })).body.error.code).toBe('EVENT_NOT_ON_SALE');

    // The scheduled jobs all run cleanly and leave no inconsistency alerts behind.
    for (const job of ['maint-expire-orders', 'maint-payments', 'maint-lifecycle', 'maint-health']) await queue.add(job, {});
    expect(maintenance).toBeDefined();
    expect(await prisma.alert.count({ where: { type: { in: ['INVENTORY_INCONSISTENCY', 'TICKET_ISSUANCE_FAILED', 'RECONCILIATION_ISSUES'] } } })).toBe(0);
    const health = await admin(app, root).get('/system/health');
    expect(health.status).toBe(200);
    expect(JSON.stringify(health.body)).toContain('database');
  });

  it('rate limits sign-in attempts', async () => {
    clearRateLimitBuckets();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await http(app).post('/v1/admin/auth/login').send({ email: 'nobody@test.local', password: 'x' })).status);
    expect(statuses).toContain(429);
    const limited = await http(app).post('/v1/admin/auth/login').send({ email: 'nobody@test.local', password: 'x' });
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
