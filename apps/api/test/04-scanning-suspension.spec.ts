import { INestApplication } from '@nestjs/common';
import { createHash } from 'crypto';
import { decrypt } from '../src/common/crypto';
import { PrismaService } from '../src/common/infra';
import { admin, buildFixture, checkout, createApp, deliverWebhook, Fixture, gatewayWebhook, http, login, purchase, resetDb, storefront } from './helpers';

describe('QR validation and brand suspension (acceptance scenarios 8 and 9)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;
  let scanner: string;
  let superadmin: string;

  const scan = (token: string, eventId = fx.eventId, extra: object = {}) =>
    http(app).post('/v1/scanner/scan').set('Authorization', `Bearer ${scanner}`).send({ eventId, token, deviceId: 'gate-phone-1', gate: 'Gate A', ...extra });
  const qrFor = async (ticketId: string) => decrypt((await prisma.ticketQrToken.findFirstOrThrow({ where: { ticketId, active: true } })).tokenEnc);

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    fx = await buildFixture(prisma);
    scanner = await login(app, fx.users.scanner.email);
    superadmin = await login(app, fx.users.superadmin.email);
  });
  afterAll(() => app.close());

  it('Scenario 8: tickets from all five storefronts validate centrally and a second scan is rejected', async () => {
    for (const [i, brand] of fx.brands.entries()) {
      const p = await purchase(app, brand, fx, { email: `fan${i}@example.com`, name: `Fan ${i}` });
      const ticket = await prisma.ticket.findFirstOrThrow({ where: { order: { reference: p.orderReference } } });
      const token = await qrFor(ticket.id);

      // The QR carries only an opaque random token: no ticket id, reference, name or email.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).not.toContain(ticket.id);
      expect(token).not.toContain(ticket.reference);

      const first = await scan(token);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ result: 'ADMITTED', admitted: true });
      expect(first.body.ticket.brand).toBe(brand.name);

      const second = await scan(token);
      expect(second.body).toMatchObject({ result: 'ALREADY_USED', admitted: false });
      expect(second.body.firstScan.gate).toBe('Gate A');
    }
    const scans = await prisma.ticketScan.findMany({ where: { eventId: fx.eventId } });
    expect(scans.filter((s) => s.result === 'ADMITTED')).toHaveLength(5);
    expect(scans.filter((s) => s.result === 'ALREADY_USED')).toHaveLength(5);
    expect(scans.every((s) => s.scannedById === fx.users.scanner.id && s.deviceId === 'gate-phone-1')).toBe(true);
    expect(await prisma.ticket.count({ where: { eventId: fx.eventId, status: 'USED' } })).toBe(5);
  });

  it('two gates scanning the same ticket at the same instant admit it once', async () => {
    const p = await purchase(app, fx.brands[0], fx, { email: 'twogates@example.com' });
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { order: { reference: p.orderReference } } });
    const token = await qrFor(ticket.id);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => scan(token, fx.eventId, { gate: `Gate ${i}` })));
    expect(results.filter((r) => r.body.admitted)).toHaveLength(1);
    expect(results.filter((r) => r.body.result === 'ALREADY_USED')).toHaveLength(11);
  });

  it('rejects unknown codes, guessed identifiers, other events, and refunded or revoked tickets', async () => {
    const p = await purchase(app, fx.brands[1], fx, { email: 'edge@example.com', quantity: 2 });
    const [t1, t2] = await prisma.ticket.findMany({ where: { order: { reference: p.orderReference } }, orderBy: { reference: 'asc' } });

    expect((await scan('this-is-not-a-real-ticket-code-0000000000000')).body.result).toBe('INVALID_TOKEN');
    // Knowing a ticket's id or printed reference is not enough to get in.
    expect((await scan(t1.id)).body.result).toBe('INVALID_TOKEN');
    expect((await scan(t1.reference)).body.result).toBe('INVALID_TOKEN');

    const other = await prisma.event.create({ data: { slug: 'other-event', name: 'Another Event', startsAt: new Date(Date.now() + 86400_000), status: 'PUBLISHED', publications: { create: { brandId: fx.brands[0].id } } } });
    await prisma.userEventAssignment.create({ data: { userId: fx.users.scanner.id, eventId: other.id } });
    const wrong = await scan(await qrFor(t1.id), other.id);
    expect(wrong.body.result).toBe('WRONG_EVENT');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t1.id } })).status).toBe('VALID'); // not consumed

    const token2 = await qrFor(t2.id);
    const revoke = await admin(app, superadmin).post(`/tickets/${t2.id}/revoke`, { reason: 'Chargeback received' });
    expect(revoke.status).toBe(200);
    const revoked = await scan(token2);
    expect(revoked.body).toMatchObject({ result: 'NOT_VALID', admitted: false });
  });

  it('scanners can only scan events they are assigned to, and non-scanners cannot scan at all', async () => {
    const unassigned = await prisma.event.create({ data: { slug: 'unassigned-event', name: 'Unassigned', startsAt: new Date(Date.now() + 86400_000), status: 'PUBLISHED', publications: { create: { brandId: fx.brands[0].id } } } });
    const res = await scan('whatever-token-value-000000000000000000000', unassigned.id);
    expect(res.status).toBe(403);
    const marketing = await login(app, fx.users.marketing1.email);
    const denied = await http(app).post('/v1/scanner/scan').set('Authorization', `Bearer ${marketing}`).send({ eventId: fx.eventId, token: 'x'.repeat(43) });
    expect(denied.status).toBe(403);
    expect((await http(app).post('/v1/scanner/scan').send({ eventId: fx.eventId, token: 'x'.repeat(43) })).status).toBe(401);
  });

  it('offline scanning: the manifest holds only token hashes, and a duplicate entry is detected when devices sync', async () => {
    const p = await purchase(app, fx.brands[2], fx, { email: 'offline@example.com', quantity: 2 });
    const [a, b] = await prisma.ticket.findMany({ where: { order: { reference: p.orderReference } }, orderBy: { reference: 'asc' } });
    const tokenA = await qrFor(a.id);
    const tokenB = await qrFor(b.id);

    const manifest = await http(app).get(`/v1/scanner/events/${fx.eventId}/manifest`).set('Authorization', `Bearer ${scanner}`);
    expect(manifest.status).toBe(200);
    const hashA = createHash('sha256').update(tokenA).digest('hex');
    expect(manifest.body.tickets.find((t: any) => t.h === hashA)).toMatchObject({ r: a.reference, s: 'VALID' });
    expect(JSON.stringify(manifest.body)).not.toContain(tokenA);

    // Gate A (online) admits ticket A. An offline device at Gate B admitted the same ticket earlier, plus ticket B.
    expect((await scan(tokenA)).body.admitted).toBe(true);
    const sync = await http(app).post('/v1/scanner/sync').set('Authorization', `Bearer ${scanner}`).send({
      eventId: fx.eventId, deviceId: 'offline-phone-2',
      scans: [
        { clientScanId: 'dev2-scan-0001', token: tokenA, scannedAt: new Date(Date.now() - 60_000).toISOString(), gate: 'Gate B' },
        { clientScanId: 'dev2-scan-0002', token: tokenB, scannedAt: new Date(Date.now() - 30_000).toISOString(), gate: 'Gate B' },
      ],
    });
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ synced: 2, conflicts: 1 });
    expect(sync.body.results.find((r: any) => r.clientScanId === 'dev2-scan-0001').result).toBe('OFFLINE_CONFLICT');
    expect(sync.body.results.find((r: any) => r.clientScanId === 'dev2-scan-0002').result).toBe('ADMITTED');
    expect(await prisma.alert.count({ where: { type: 'OFFLINE_SCAN_CONFLICT' } })).toBe(1);

    // Re-sending the same batch (flaky network) changes nothing.
    const resend = await http(app).post('/v1/scanner/sync').set('Authorization', `Bearer ${scanner}`).send({
      eventId: fx.eventId, deviceId: 'offline-phone-2',
      scans: [{ clientScanId: 'dev2-scan-0002', token: tokenB, scannedAt: new Date(Date.now() - 30_000).toISOString(), gate: 'Gate B' }],
    });
    expect(resend.body.results[0].result).toBe('ADMITTED');
    expect(await prisma.ticketScan.count({ where: { clientScanId: 'dev2-scan-0002' } })).toBe(1);
  });

  it('Scenario 9: a suspended brand cannot start purchases, but its tickets still scan and its orders stay manageable', async () => {
    const w4 = fx.brands[3];
    const existing = await purchase(app, w4, fx, { email: 'before-suspension@example.com' });
    const pending = await checkout(app, w4, fx, { email: 'mid-checkout@example.com' });
    expect(pending.status).toBe(201);

    const suspend = await admin(app, superadmin).post(`/brands/${w4.id}/status`, { status: 'SUSPENDED', reason: 'Compliance review' });
    expect(suspend.status).toBe(201);

    // New purchases and browsing are refused for this storefront only.
    const blocked = await checkout(app, w4, fx, { email: 'after-suspension@example.com' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('BRAND_NOT_ACTIVE');
    expect((await storefront(app, w4).get('/events')).status).toBe(403);
    expect((await storefront(app, w4).post(`/orders/${pending.body.orderReference}/pay?email=mid-checkout@example.com`)).status).toBe(403);
    expect((await storefront(app, w4).get('/brand')).body).toMatchObject({ status: 'SUSPENDED', acceptingOrders: false });
    expect((await checkout(app, fx.brands[0], fx, { email: 'other-brand@example.com' })).status).toBe(201); // other brands unaffected

    // A payment already in flight when the brand was suspended is still honoured.
    await deliverWebhook(app, await gatewayWebhook(app, pending.body.payment.reference, 'success'));
    expect((await prisma.order.findUniqueOrThrow({ where: { reference: pending.body.orderReference } })).status).toBe('TICKETS_ISSUED');

    // Existing customers can still see their order; their tickets still scan.
    const view = await storefront(app, w4).get(`/orders/${existing.orderReference}?email=before-suspension@example.com`);
    expect(view.status).toBe(200);
    expect(view.body.tickets).toHaveLength(1);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { order: { reference: existing.orderReference } } });
    expect((await scan(await qrFor(ticket.id))).body.admitted).toBe(true);

    // Administrators keep full access to the brand's orders, refunds and tickets.
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: pending.body.orderReference } });
    const list = await admin(app, superadmin).get(`/orders?brandId=${w4.id}`);
    expect(list.body.total).toBe(3); // one from the scanning test above plus the two placed here
    expect(list.body.items.every((o: any) => o.brand.id === w4.id)).toBe(true);
    expect((await admin(app, superadmin).post(`/orders/${order.id}/resend-tickets`)).status).toBe(200);
    const refund = await admin(app, superadmin).post(`/orders/${order.id}/refunds`, { reason: 'Refund during suspension' });
    expect(refund.status).toBe(201);
    expect((await admin(app, superadmin).post(`/refunds/${refund.body.id}/approve`)).body.status).toBe('SUCCEEDED');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'brand.status_change', entityId: w4.id } });
    expect(audit.after).toMatchObject({ status: 'SUSPENDED', reason: 'Compliance review' });

    await admin(app, superadmin).post(`/brands/${w4.id}/status`, { status: 'ACTIVE', reason: 'Review complete' });
    expect((await checkout(app, w4, fx, { email: 'back-again@example.com' })).status).toBe(201);
  });
});
