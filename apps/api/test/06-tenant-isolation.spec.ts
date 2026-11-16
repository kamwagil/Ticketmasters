import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/infra';
import { admin, buildFixture, createApp, Fixture, http, login, purchase, resetDb, storefront } from './helpers';

/**
 * Acceptance scenario 7. Website 1 and Website 2 each have their own administrator.
 * Every check goes through the HTTP API: isolation is enforced by the backend, not by what
 * the admin interface chooses to display.
 */
describe('Tenant isolation and role-based access (acceptance scenario 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;
  let a1: string; // Website 1 brand administrator
  let a2: string; // Website 2 brand administrator
  let root: string;
  let o1: { id: string; reference: string; customerId: string };
  let o2: { id: string; reference: string; customerId: string };

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    fx = await buildFixture(prisma);
    [a1, a2, root] = await Promise.all([login(app, fx.users.brand1admin.email), login(app, fx.users.brand2admin.email), login(app, fx.users.superadmin.email)]);
    const p1 = await purchase(app, fx.brands[0], fx, { email: 'w1.customer@example.com', name: 'Website One Customer', marketingOptIn: true });
    const p2 = await purchase(app, fx.brands[1], fx, { email: 'w2.customer@example.com', name: 'Website Two Customer', marketingOptIn: true });
    o1 = await prisma.order.findUniqueOrThrow({ where: { reference: p1.orderReference }, select: { id: true, reference: true, customerId: true } });
    o2 = await prisma.order.findUniqueOrThrow({ where: { reference: p2.orderReference }, select: { id: true, reference: true, customerId: true } });
  });
  afterAll(() => app.close());

  it('Scenario 7: a Website 1 administrator is denied Website 2 customer records by the backend', async () => {
    // Direct access to the record.
    const direct = await admin(app, a1).get(`/customers/${o2.customerId}`);
    expect(direct.status).toBe(404);
    expect(JSON.stringify(direct.body)).not.toContain('w2.customer@example.com');

    // Asking for Website 2 explicitly.
    const asked = await admin(app, a1).get(`/customers?brandId=${fx.brands[1].id}`);
    expect(asked.status).toBe(403);

    // Listing and searching never leak the other brand's customer.
    const list = await admin(app, a1).get('/customers');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('w1.customer@example.com');
    expect(JSON.stringify(list.body)).not.toContain('w2.customer@example.com');
    const search = await admin(app, a1).get('/customers?q=w2.customer');
    expect(search.body.items ?? search.body).toHaveLength(0);

    // Writes and privacy operations are refused as well.
    expect((await admin(app, a1).patch(`/customers/${o2.customerId}`, { fullName: 'Hacked' })).status).toBe(404);
    expect((await admin(app, a1).post(`/customers/${o2.customerId}/notes`, { brandId: fx.brands[1].id, body: 'note' })).status).toBeGreaterThanOrEqual(403);
    expect((await admin(app, a1).get(`/customers/${o2.customerId}/export?brandId=${fx.brands[1].id}`)).status).toBeGreaterThanOrEqual(403);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: o2.customerId } })).fullName).toBe('Website Two Customer');

    // The owner of the data and the super administrator can both see it.
    expect((await admin(app, a2).get(`/customers/${o2.customerId}`)).status).toBe(200);
    expect((await admin(app, root).get(`/customers/${o2.customerId}`)).status).toBe(200);
  });

  it('isolates orders, payments, tickets, refunds and exports between brands', async () => {
    const t2 = await prisma.ticket.findFirstOrThrow({ where: { orderId: o2.id } });
    const cases: [string, string][] = [
      ['get', `/orders/${o2.id}`], ['get', `/tickets/${t2.id}`], ['get', `/tickets/${t2.id}/pdf`],
    ];
    for (const [, url] of cases) expect((await admin(app, a1).get(url)).status).toBe(404);
    expect((await admin(app, a1).post(`/orders/${o2.id}/resend-tickets`)).status).toBe(404);
    expect((await admin(app, a1).post(`/orders/${o2.id}/refunds`, { reason: 'Cross-brand refund attempt' })).status).toBe(404);
    expect((await admin(app, a1).post(`/orders/${o2.id}/cancel`, { reason: 'Cross-brand cancel' })).status).toBe(404);
    expect((await admin(app, a1).post(`/tickets/${t2.id}/revoke`, { reason: 'Cross-brand revoke' })).status).toBe(404);

    for (const path of ['/orders', '/payments', '/tickets', '/refunds']) {
      const mine = await admin(app, a1).get(path);
      expect(mine.status).toBe(200);
      const text = JSON.stringify(mine.body);
      expect(text).not.toContain(o2.reference);
      expect(text).not.toContain('w2.customer@example.com');
      expect((await admin(app, a1).get(`${path}?brandId=${fx.brands[1].id}`)).status).toBe(403);
    }
    expect(JSON.stringify((await admin(app, a1).get('/orders')).body)).toContain(o1.reference);

    // Search by the other brand's exact order reference or email finds nothing.
    expect((await admin(app, a1).get(`/orders?q=${o2.reference}`)).body.total).toBe(0);
    expect((await admin(app, a1).get('/orders?q=w2.customer@example.com')).body.total).toBe(0);

    // Exports are scoped the same way.
    const csv = await admin(app, a1).get('/orders?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(o1.reference);
    expect(csv.text).not.toContain(o2.reference);

    // The super administrator sees every brand and can drill into one.
    const all = await admin(app, root).get('/orders');
    expect(all.body.total).toBe(2);
    const drill = await admin(app, root).get(`/orders?brandId=${fx.brands[1].id}`);
    expect(drill.body.items.map((o: any) => o.reference)).toEqual([o2.reference]);
  });

  it('isolates reports, the ledger, audit logs, marketing and support', async () => {
    const mine = await admin(app, a1).get('/reports/overview');
    expect(mine.status).toBe(200);
    expect(mine.body.orders).toBe(1);
    expect((await admin(app, root).get('/reports/overview')).body.orders).toBe(2);
    expect((await admin(app, a1).get(`/reports/overview?brandId=${fx.brands[1].id}`)).status).toBe(403);
    expect((await admin(app, a1).get(`/reports/financial?brandId=${fx.brands[1].id}`)).status).toBe(403);
    const brandsReport = await admin(app, a1).get('/reports/brands');
    expect(JSON.stringify(brandsReport.body)).not.toContain('Website 2');

    // Segments, tags and campaigns belong to one brand.
    const seg2 = await admin(app, a2).post('/segments', { brandId: fx.brands[1].id, name: 'W2 buyers', rules: { minOrders: 1 } });
    expect(seg2.status).toBe(201);
    expect((await admin(app, a1).get(`/segments?brandId=${fx.brands[1].id}`)).status).toBe(403);
    expect((await admin(app, a1).get(`/segments/${seg2.body.id}/members`)).status).toBeGreaterThanOrEqual(403);
    expect((await admin(app, a1).post('/segments', { brandId: fx.brands[1].id, name: 'Sneaky', rules: {} })).status).toBe(403);

    // A support ticket raised on Website 2 is invisible to Website 1 staff.
    const sup = await storefront(app, fx.brands[1]).post('/support/tickets', { email: 'w2.customer@example.com', name: 'W2', subject: 'Where are my tickets?', message: 'Please help me find my tickets.' });
    expect(sup.status).toBe(201);
    const t = await prisma.supportTicket.findFirstOrThrow({ where: { brandId: fx.brands[1].id } });
    expect((await admin(app, a1).get(`/support/tickets/${t.id}`)).status).toBe(404);
    expect((await admin(app, a1).get('/support/tickets')).body.total).toBe(0);
    expect((await admin(app, a2).get('/support/tickets')).body.total).toBe(1);

    // Audit entries about Website 2 are not shown to Website 1.
    const audit = await admin(app, a1).get('/audit-logs?pageSize=200');
    expect(audit.status).toBe(200);
    expect((audit.body.items as any[]).every((r) => r.brandId === fx.brands[0].id)).toBe(true);
  });

  it('a campaign can never be sent to another brand’s audience', async () => {
    const m1 = await login(app, fx.users.marketing1.email);
    const seg2 = await prisma.customerSegment.findFirstOrThrow({ where: { brandId: fx.brands[1].id } });
    const seg1 = await admin(app, m1).post('/segments', { brandId: fx.brands[0].id, name: 'W1 buyers', rules: { minOrders: 1 } });
    expect(seg1.status).toBe(201);

    const cross = await admin(app, m1).post('/marketing/campaigns', { brandId: fx.brands[0].id, name: 'Cross', channel: 'EMAIL', subject: 'Hi', bodyHtml: '<p>Hi {{name}}</p>', segmentIds: [seg2.id] });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    const foreign = await admin(app, m1).post('/marketing/campaigns', { brandId: fx.brands[1].id, name: 'Foreign', channel: 'EMAIL', subject: 'Hi', bodyHtml: '<p>Hi</p>', segmentIds: [seg2.id] });
    expect(foreign.status).toBe(403);

    const ok = await admin(app, m1).post('/marketing/campaigns', { brandId: fx.brands[0].id, name: 'W1 news', channel: 'EMAIL', subject: 'News from Website 1', bodyHtml: '<p>Hi {{name}}, <a href="https://website1.test/events">see events</a></p>', segmentIds: [seg1.body.id] });
    expect(ok.status).toBe(201);
    expect(await prisma.campaign.count({ where: { brandId: fx.brands[1].id } })).toBe(0);
  });

  it('brand administrators cannot change platform configuration or escalate their own access', async () => {
    const b1 = fx.brands[0].id;
    const b2 = fx.brands[1].id;
    expect((await admin(app, a1).get(`/brands/${b2}`)).status).toBe(403);
    expect((await admin(app, a1).patch(`/brands/${b2}`, { name: 'Taken over' })).status).toBe(403);
    expect((await admin(app, a1).get('/brands')).body.map((b: any) => b.id)).toEqual([b1]);
    // Platform-only operations on their own brand.
    expect((await admin(app, a1).post(`/brands/${b1}/status`, { status: 'SUSPENDED', reason: 'self-suspend' })).status).toBe(403);
    expect((await admin(app, a1).post(`/brands/${b1}/api-keys`, { label: 'rogue key' })).status).toBe(403);
    expect((await admin(app, a1).get('/payment-accounts')).status).toBe(403);
    expect((await admin(app, a1).post('/brands', { slug: 'new-brand', name: 'New', contactEmail: 'a@b.co', emailSenderName: 'New', emailSenderAddr: 'a@b.co' })).status).toBe(403);
    expect((await admin(app, a1).get('/settlements/payables')).status).toBe(403);
    expect((await admin(app, a1).get('/webhook-events')).status).toBe(403);

    // Staff management: cannot see or assign outside their brand, cannot grant platform-wide access or stronger roles.
    const staff = await admin(app, a1).get('/staff');
    expect((staff.body.items as any[]).map((u) => u.email)).not.toContain(fx.users.brand2admin.email);
    expect((staff.body.items as any[]).map((u) => u.email)).not.toContain(fx.users.superadmin.email);
    const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));
    const base = { fullName: 'New Hire', password: 'A-Long-Password-123', roleIds: [roles.customer_support] };
    expect((await admin(app, a1).post('/staff', { ...base, email: 'x1@test.local', brandIds: [b2] })).status).toBe(403);
    expect((await admin(app, a1).post('/staff', { ...base, email: 'x2@test.local', allBrands: true })).status).toBe(403);
    expect((await admin(app, a1).post('/staff', { ...base, email: 'x3@test.local', brandIds: [b1], roleIds: [roles.super_admin] })).status).toBe(403);
    expect((await admin(app, a1).patch(`/staff/${fx.users.brand2admin.id}`, { status: 'SUSPENDED' })).status).toBe(404);
    expect((await admin(app, a1).post('/staff', { ...base, email: 'ok@test.local', brandIds: [b1] })).status).toBe(201);
    expect((await admin(app, a1).post('/roles', { key: 'my_role', name: 'Mine', permissions: ['orders.read'] })).status).toBe(403);
  });

  it('permissions are enforced per role and are configurable at runtime', async () => {
    const support = await login(app, fx.users.support1.email);
    expect((await admin(app, support).get('/orders')).status).toBe(200);
    expect((await admin(app, support).get('/reports/financial')).status).toBe(403);
    expect((await admin(app, support).get('/audit-logs')).status).toBe(403);
    expect((await admin(app, support).post('/marketing/campaigns', {})).status).toBe(403);
    expect((await admin(app, support).get('/orders?format=csv')).status).toBe(403); // no export permission

    // An administrator grants the role a new permission; it applies on the very next request.
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'customer_support' }, include: { permissions: { include: { permission: true } } } });
    const current = role.permissions.map((p) => p.permission.key);
    const grant = await admin(app, root).patch(`/roles/${role.id}`, { permissions: [...current, 'orders.export'] });
    expect(grant.status).toBe(200);
    expect((await admin(app, support).get('/orders?format=csv')).status).toBe(200);
    await admin(app, root).patch(`/roles/${role.id}`, { permissions: current });
    expect((await admin(app, support).get('/orders?format=csv')).status).toBe(403);

    // Sensitive actions leave an audit trail.
    const audit = await prisma.auditLog.findMany({ where: { action: 'role.update', entityId: role.id } });
    expect(audit).toHaveLength(2);
    expect(audit[0].actorId).toBe(fx.users.superadmin.id);
  });

  it('suspending a staff account or signing out ends access immediately', async () => {
    const token = await login(app, fx.users.finance2.email);
    expect((await admin(app, token).get('/orders')).status).toBe(200);
    expect((await admin(app, root).patch(`/staff/${fx.users.finance2.id}`, { status: 'SUSPENDED' })).status).toBe(200);
    expect((await admin(app, token).get('/orders')).status).toBe(401);
    expect((await http(app).post('/v1/admin/auth/login').send({ email: fx.users.finance2.email, password: 'Test-Password-12345' })).status).toBe(403);
  });

  it('a storefront key only ever acts as its own brand', async () => {
    const w1 = fx.brands[0];
    const w2 = fx.brands[1];
    // Website 1's key cannot read Website 2's order, even with the right email.
    expect((await storefront(app, w1).get(`/orders/${o2.reference}?email=w2.customer@example.com`)).status).toBe(404);
    expect((await storefront(app, w2).get(`/orders/${o2.reference}?email=w2.customer@example.com`)).status).toBe(200);
    // A brand id supplied by the caller is ignored / rejected; the brand always comes from the key.
    const spoof = await http(app).get(`/v1/storefront/brand?brandId=${w2.id}`).set('X-Storefront-Key', w1.key).set('X-Storefront-Domain', w1.domain);
    expect(spoof.body.id).toBe(w1.id);
    // Claiming another brand's domain with your key is refused.
    const wrongDomain = await http(app).get('/v1/storefront/events').set('X-Storefront-Key', w1.key).set('X-Storefront-Domain', w2.domain);
    expect(wrongDomain.status).toBe(403);
    const wrongOrigin = await http(app).get('/v1/storefront/events').set('X-Storefront-Key', w1.key).set('Origin', 'https://evil.example');
    expect(wrongOrigin.status).toBe(403);
    expect((await http(app).get('/v1/storefront/events')).status).toBe(401);
    expect((await http(app).get('/v1/storefront/events').set('X-Storefront-Key', 'sfk_not_a_real_key')).status).toBe(401);

    // An event not published to a storefront does not exist for it.
    await prisma.eventBrandPublication.delete({ where: { eventId_brandId: { eventId: fx.eventId, brandId: w2.id } } });
    expect((await storefront(app, w2).get(`/events/${fx.eventId}`)).status).toBe(404);
    expect((await storefront(app, w1).get(`/events/${fx.eventId}`)).status).toBe(200);
    const blocked = await storefront(app, w2).post('/checkout/orders', {
      eventId: fx.eventId, items: [{ ticketCategoryId: fx.categoryId, quantity: 1 }], customer: { email: 'x@example.com', fullName: 'X Y' }, acceptPolicies: true,
    }).set('Idempotency-Key', 'unpublished-1');
    expect(blocked.status).toBe(404);
  });
});
