import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/infra';
import { CampaignService } from '../src/modules/marketing/campaign.service';
import { NotificationService } from '../src/modules/notifications/notification.service';
import { admin, buildFixture, checkout, createApp, deliverWebhook, Fixture, gatewayWebhook, http, login, purchase, resetDb, storefront } from './helpers';

describe('Central customer identity, consent and CRM (acceptance scenario 2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: Fixture;
  let root: string;
  const EMAIL = 'amina.otieno@example.com';
  const PASSWORD = 'Customer-Pass-2026';

  /** Registers on a storefront and returns the customer token plus the emailed verification token. */
  const register = async (brandIndex: number, email = EMAIL, extra: object = {}) => {
    const res = await storefront(app, fx.brands[brandIndex]).post('/customers/register', { email, password: PASSWORD, fullName: 'Amina Otieno', phone: '+254722000111', country: 'Kenya', ...extra });
    return res;
  };
  /** Reads the verification link the platform emailed (from the notification outbox). */
  const emailedToken = async (brandId: string, type: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET', email = EMAIL) => {
    const job = await prisma.emailJob.findFirstOrThrow({ where: { brandId, type, toAddress: email }, orderBy: { createdAt: 'desc' } });
    const url = (job.payload as Record<string, string>)[type === 'EMAIL_VERIFICATION' ? 'verifyUrl' : 'resetUrl'];
    return new URL(url).searchParams.get('token')!;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    fx = await buildFixture(prisma);
    root = await login(app, fx.users.superadmin.email);
  });
  afterAll(() => app.close());

  it('Scenario 2: the same person buying on Website 1 and Website 3 is linked only after verifying their email', async () => {
    const w1 = fx.brands[0];
    const w3 = fx.brands[2];

    // Website 1: register, verify, buy.
    const r1 = await register(0, EMAIL, { marketingOptIn: true });
    expect(r1.status).toBe(201);
    expect(r1.body.customer.emailVerified).toBe(false);
    const v1 = await storefront(app, w1, r1.body.token).post('/customers/verify-email', { token: await emailedToken(w1.id, 'EMAIL_VERIFICATION') });
    expect(v1.body).toMatchObject({ verified: true, linked: false });
    const buy1 = await purchase(app, w1, fx, { email: EMAIL, name: 'Amina Otieno', customerToken: v1.body.token });
    const order1 = await prisma.order.findUniqueOrThrow({ where: { reference: buy1.orderReference } });
    const central = order1.customerId;

    // Website 3: a purchase with the same email, but nobody has proved they own it on this brand yet.
    const guest3 = await purchase(app, w3, fx, { email: EMAIL, name: 'Amina Otieno' });
    let order3 = await prisma.order.findUniqueOrThrow({ where: { reference: guest3.orderReference } });
    expect(order3.brandId).toBe(w3.id);
    expect(order3.sourceDomain).toBe(w3.domain);
    expect(order3.customerId).not.toBe(central); // NOT merged on an unverified matching email

    // The customer creates their Website 3 account and verifies the email: now the records are linked.
    const r3 = await register(2);
    expect(r3.status).toBe(201);
    const before = await storefront(app, w3, r3.body.token).get('/customers/me/orders');
    expect(before.body).toMatchObject({ items: [], emailVerificationRequired: true }); // nothing exposed before verification
    const v3 = await storefront(app, w3, r3.body.token).post('/customers/verify-email', { token: await emailedToken(w3.id, 'EMAIL_VERIFICATION') });
    expect(v3.body).toMatchObject({ verified: true, linked: true });

    order3 = await prisma.order.findUniqueOrThrow({ where: { reference: guest3.orderReference } });
    expect(order3.customerId).toBe(central); // one central identity
    expect(order3.brandId).toBe(w3.id); // the order still belongs to Website 3
    expect((await prisma.order.findUniqueOrThrow({ where: { reference: buy1.orderReference } })).brandId).toBe(w1.id);
    const rels = await prisma.customerBrandRelationship.findMany({ where: { customerId: central } });
    expect(rels.map((r) => r.brandId).sort()).toEqual([w1.id, w3.id].sort());
    expect(await prisma.customerIdentity.count({ where: { type: 'EMAIL', value: EMAIL, verifiedAt: { not: null } } })).toBe(1);

    // Each storefront shows only its own orders to the customer.
    const mine3 = await storefront(app, w3, v3.body.token).get('/customers/me/orders');
    expect(mine3.body.items.map((o: any) => o.reference)).toEqual([guest3.orderReference]);
    const mine1 = await storefront(app, w1, v1.body.token).get('/customers/me/orders');
    expect(mine1.body.items.map((o: any) => o.reference)).toEqual([buy1.orderReference]);

    // The Website 3 confirmation used Website 3's template identity, not Website 1's.
    const job = await prisma.emailJob.findFirstOrThrow({ where: { orderId: order3.id, type: 'ORDER_CONFIRMATION' } });
    expect(job.brandId).toBe(w3.id);
    const rendered = await app.get(NotificationService).render(job.brandId, job.type, 'EMAIL', job.payload as Record<string, unknown>);
    expect(rendered.from).toBe('"Website 3 Tickets" <tickets@website3.test>');
    expect(rendered.html).toContain('help@website3.test');
    expect(rendered.html).not.toContain('website1.test');

    // The super administrator's 360 view shows both brand relationships and spend per currency.
    const profile = await admin(app, root).get(`/customers/${central}`);
    expect(profile.status).toBe(200);
    const text = JSON.stringify(profile.body);
    expect(text).toContain(buy1.orderReference);
    expect(text).toContain(guest3.orderReference);
    // A Website 1 administrator sees the same person, but only Website 1 activity.
    const a1 = await login(app, fx.users.brand1admin.email);
    const scoped = JSON.stringify((await admin(app, a1).get(`/customers/${central}`)).body);
    expect(scoped).toContain(buy1.orderReference);
    expect(scoped).not.toContain(guest3.orderReference);
  });

  it('marketing consent is per brand and never carried across by linking accounts', async () => {
    const customer = await prisma.customer.findFirstOrThrow({ where: { email: EMAIL, mergedIntoId: null } });
    const notifications = app.get(NotificationService);
    // Opted in on Website 1 at registration; never on Website 3.
    expect(await notifications.hasConsent(customer.id, fx.brands[0].id, 'EMAIL')).toBe(true);
    expect(await notifications.hasConsent(customer.id, fx.brands[2].id, 'EMAIL')).toBe(false);
    expect(await notifications.hasConsent(customer.id, fx.brands[1].id, 'EMAIL')).toBe(false);
    expect(await notifications.hasConsent(customer.id, fx.brands[0].id, 'SMS')).toBe(false);
    // Not ticking the box at checkout records nothing.
    const quiet = await purchase(app, fx.brands[3], fx, { email: 'quiet@example.com' });
    const q = await prisma.order.findUniqueOrThrow({ where: { reference: quiet.orderReference } });
    expect(await prisma.marketingConsent.count({ where: { customerId: q.customerId } })).toBe(0);
  });

  it('a campaign reaches only customers who consented to that brand, and unsubscribe affects that brand only', async () => {
    const w1 = fx.brands[0];
    const m1 = await login(app, fx.users.marketing1.email);
    // Two more Website 1 buyers: one opts in, one does not.
    await purchase(app, w1, fx, { email: 'optin@example.com', name: 'Opt In', marketingOptIn: true });
    await purchase(app, w1, fx, { email: 'optout@example.com', name: 'Opt Out' });

    const seg = await admin(app, m1).post('/segments', { brandId: w1.id, name: 'All W1 buyers', rules: { minOrders: 1 } });
    expect(seg.status).toBe(201);
    const preview = await admin(app, m1).post('/segments/preview', { brandId: w1.id, rules: { minOrders: 1 } });
    expect(preview.body.count).toBe(3);

    const camp = await admin(app, m1).post('/marketing/campaigns', {
      brandId: w1.id, name: 'Festival announcement', channel: 'EMAIL', subject: 'New festival on sale',
      bodyHtml: '<p>Hi {{name}}, tickets are <a href="https://website1.test/events">on sale now</a>.</p>', segmentIds: [seg.body.id],
    });
    expect(camp.status).toBe(201);
    await app.get(CampaignService).dispatch(camp.body.id);
    await app.get(NotificationService).drain();

    const deliveries = await prisma.campaignDelivery.findMany({ where: { campaignId: camp.body.id } });
    const byAddress = Object.fromEntries(deliveries.map((d) => [d.toAddress, d]));
    expect(byAddress['optin@example.com'].status).toBe('SENT');
    expect(byAddress[EMAIL].status).toBe('SENT');
    expect(byAddress['optout@example.com']).toMatchObject({ status: 'SKIPPED', skippedReason: 'NO_CONSENT' });
    const sent = await prisma.emailJob.findMany({ where: { campaignId: camp.body.id } });
    expect(sent.map((j) => j.toAddress).sort()).toEqual([EMAIL, 'optin@example.com'].sort());
    expect(sent.every((j) => j.brandId === w1.id && j.status === 'SENT')).toBe(true);
    const rendered = await app.get(NotificationService).render(w1.id, 'MARKETING', 'EMAIL', sent[0].payload as Record<string, unknown>);
    expect(rendered.html).toContain('/v1/public/unsubscribe/');
    expect(rendered.html).toContain('/v1/public/c/'); // tracked link
    expect(rendered.html).toContain('Website 1');

    // Click tracking redirects only to the original link; open tracking returns a pixel.
    const d = byAddress['optin@example.com'];
    const click = await http(app).get(`/v1/public/c/${d.trackingToken}?u=${encodeURIComponent('https://website1.test/events')}`);
    expect(click.status).toBe(302);
    expect(click.headers.location).toBe('https://website1.test/events');
    expect((await http(app).get(`/v1/public/c/not-a-token?u=${encodeURIComponent('https://evil.example')}`)).status).toBe(400);
    expect((await http(app).get(`/v1/public/c/${d.trackingToken}?u=${encodeURIComponent('javascript:alert(1)')}`)).status).toBe(400);
    expect((await http(app).get(`/v1/public/o/${d.trackingToken}.gif`)).headers['content-type']).toContain('image/gif');

    // Conversion: a purchase carrying the campaign token is attributed to the campaign.
    const c = await storefront(app, w1).post('/checkout/orders', {
      eventId: fx.eventId, items: [{ ticketCategoryId: fx.categoryId, quantity: 1 }], customer: { email: 'optin@example.com', fullName: 'Opt In' }, acceptPolicies: true, campaignToken: d.trackingToken,
    }).set('Idempotency-Key', 'campaign-conversion');
    await deliverWebhook(app, await gatewayWebhook(app, c.body.payment.reference, 'success'));
    const perf = await admin(app, m1).get(`/marketing/campaigns/${camp.body.id}/performance`);
    expect(perf.status).toBe(200);
    expect(JSON.stringify(perf.body)).toContain('104000'); // 1 ticket + 4% fee, in KES minor units

    // One-click unsubscribe withdraws consent for Website 1 email only.
    const customer = await prisma.customer.findFirstOrThrow({ where: { email: EMAIL, mergedIntoId: null } });
    await prisma.marketingConsent.create({ data: { customerId: customer.id, brandId: fx.brands[2].id, channel: 'EMAIL', status: 'GRANTED', source: 'account' } });
    const unsub = await http(app).post(`/v1/public/unsubscribe/${byAddress[EMAIL].trackingToken}`);
    expect(unsub.status).toBeLessThan(300);
    const notifications = app.get(NotificationService);
    expect(await notifications.hasConsent(customer.id, w1.id, 'EMAIL')).toBe(false);
    expect(await notifications.hasConsent(customer.id, fx.brands[2].id, 'EMAIL')).toBe(true);

    // A second campaign now skips the unsubscribed customer.
    const camp2 = await admin(app, m1).post('/marketing/campaigns', { brandId: w1.id, name: 'Follow-up', channel: 'EMAIL', subject: 'Last tickets', bodyHtml: '<p>Hi {{name}}</p>', segmentIds: [seg.body.id] });
    await app.get(CampaignService).dispatch(camp2.body.id);
    const d2 = await prisma.campaignDelivery.findFirstOrThrow({ where: { campaignId: camp2.body.id, toAddress: EMAIL } });
    expect(d2).toMatchObject({ status: 'SKIPPED', skippedReason: 'NO_CONSENT' });
    // Re-running a dispatch never sends twice.
    await app.get(CampaignService).dispatch(camp.body.id);
    expect(await prisma.emailJob.count({ where: { campaignId: camp.body.id } })).toBe(2);
  });

  it('registering with someone else’s email cannot expose their orders or hijack the account', async () => {
    const w5 = fx.brands[4];
    const victim = 'victim@example.com';
    const guest = await purchase(app, w5, fx, { email: victim, name: 'Real Owner' });

    // An attacker registers an account on the victim's email.
    const attacker = await register(4, victim);
    expect(attacker.status).toBe(201);
    const peek = await storefront(app, w5, attacker.body.token).get('/customers/me/orders');
    expect(peek.body.items).toEqual([]);
    expect(JSON.stringify((await storefront(app, w5, attacker.body.token).get('/customers/me/tickets')).body)).not.toContain('TKT-');

    // The verification link went to the victim's mailbox. Opening it without being signed in to that account does nothing.
    const link = await emailedToken(w5.id, 'EMAIL_VERIFICATION', victim);
    expect((await storefront(app, w5).post('/customers/verify-email', { token: link })).status).toBe(401);
    expect((await prisma.customerBrandRelationship.findFirstOrThrow({ where: { brandId: w5.id, email: victim } })).emailVerifiedAt).toBeNull();

    // The real owner resets the password from their mailbox: the attacker's session dies and the account is theirs.
    expect((await storefront(app, w5).post('/customers/password-reset/request', { email: victim })).status).toBe(200);
    expect((await storefront(app, w5).post('/customers/password-reset/request', { email: 'nobody@example.com' })).status).toBe(200); // no account enumeration
    const reset = await storefront(app, w5).post('/customers/password-reset/confirm', { token: await emailedToken(w5.id, 'PASSWORD_RESET', victim), password: 'Owner-New-Password-1' });
    expect(reset.status).toBe(200);
    expect((await storefront(app, w5, attacker.body.token).get('/customers/me')).status).toBe(401);
    expect((await storefront(app, w5).post('/customers/login', { email: victim, password: PASSWORD })).status).toBe(401);
    const owner = await storefront(app, w5).post('/customers/login', { email: victim, password: 'Owner-New-Password-1' });
    expect(owner.status).toBe(200);
    const orders = await storefront(app, w5, owner.body.token).get('/customers/me/orders');
    expect(orders.body.items.map((o: any) => o.reference)).toEqual([guest.orderReference]);

    // A customer token from one brand is useless on another storefront.
    expect((await storefront(app, fx.brands[0], owner.body.token).get('/customers/me')).status).toBe(401);
  });

  it('guests can only open an order or ticket with the matching email; tickets download as PDF and transfer safely', async () => {
    const w2 = fx.brands[1];
    const p = await purchase(app, w2, fx, { email: 'holder@example.com', name: 'Ticket Holder', quantity: 2 });
    expect((await storefront(app, w2).get(`/orders/${p.orderReference}`)).status).toBe(404);
    expect((await storefront(app, w2).get(`/orders/${p.orderReference}?email=wrong@example.com`)).status).toBe(404);
    const view = await storefront(app, w2).get(`/orders/${p.orderReference}?email=holder@example.com`);
    expect(view.status).toBe(200);
    expect(view.body.tickets).toHaveLength(2);
    const ticketId = view.body.tickets[0].id;

    expect((await storefront(app, w2).get(`/tickets/${ticketId}`)).status).toBe(404);
    const t = await storefront(app, w2).get(`/tickets/${ticketId}?orderReference=${p.orderReference}&email=holder@example.com`);
    expect(t.status).toBe(200);
    expect(t.body.qrSvg).toMatch(/^<svg/);
    const pdf = await storefront(app, w2).get(`/tickets/${ticketId}/download?orderReference=${p.orderReference}&email=holder@example.com`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // Transfer: needs a verified account; the old QR dies and the recipient gets a new ticket.
    const reg = await register(1, 'holder@example.com');
    await storefront(app, w2, reg.body.token).post('/customers/verify-email', { token: await emailedToken(w2.id, 'EMAIL_VERIFICATION', 'holder@example.com') });
    const session = await storefront(app, w2).post('/customers/login', { email: 'holder@example.com', password: PASSWORD });
    const oldToken = await prisma.ticketQrToken.findFirstOrThrow({ where: { ticketId, active: true } });
    const start = await storefront(app, w2, session.body.token).post(`/tickets/${ticketId}/transfer`, { toEmail: 'friend@example.com', toName: 'Good Friend' });
    expect(start.status).toBeLessThan(300);
    const mail = await prisma.emailJob.findFirstOrThrow({ where: { type: 'TICKET_TRANSFER', toAddress: 'friend@example.com' } });
    const claimToken = new URL((mail.payload as Record<string, string>).claimUrl).searchParams.get('token')!;
    const claim = await storefront(app, w2).post('/tickets/transfers/claim', { token: claimToken });
    expect(claim.status).toBeLessThan(300);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe('TRANSFERRED');
    expect((await prisma.ticketQrToken.findUniqueOrThrow({ where: { id: oldToken.id } })).active).toBe(false);
    const fresh = await prisma.ticket.findFirstOrThrow({ where: { holderEmail: 'friend@example.com', status: 'VALID' } });
    expect(fresh.orderId).toBe((await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference } })).id);
    expect((await storefront(app, w2).post('/tickets/transfers/claim', { token: claimToken })).status).toBeGreaterThanOrEqual(400); // single use
    // Inventory is unchanged by a transfer.
    const inv = await prisma.ticketInventory.findUniqueOrThrow({ where: { ticketCategoryId: fx.categoryId } });
    expect(await prisma.ticket.count({ where: { ticketCategoryId: fx.categoryId, status: { in: ['VALID', 'USED'] } } })).toBe(inv.sold);
  });

  it('privacy: data export, correction and anonymisation keep financial records intact', async () => {
    const w4 = fx.brands[3];
    const p = await purchase(app, w4, fx, { email: 'forget.me@example.com', name: 'Forget Me', marketingOptIn: true });
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: p.orderReference } });

    const exported = await admin(app, root).get(`/customers/${order.customerId}/export?brandId=${w4.id}`);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).toContain('forget.me@example.com');
    expect(JSON.stringify(exported.body)).toContain(p.orderReference);

    const fix = await admin(app, root).patch(`/customers/${order.customerId}`, { fullName: 'Forget M. Corrected' });
    expect(fix.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { entityType: 'customer', entityId: order.customerId } })).toBeGreaterThan(0);

    const ledgerBefore = await prisma.financialLedgerEntry.count({ where: { orderId: order.id } });
    const anon = await admin(app, root).post(`/customers/${order.customerId}/anonymize`, { brandId: w4.id, reason: 'Verified deletion request from the data subject' });
    expect(anon.status).toBeLessThan(300);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.customerEmail).not.toContain('forget.me');
    expect(after.customerName).not.toContain('Forget');
    expect(after.totalMinor).toBe(order.totalMinor); // the sale itself is retained
    expect(await prisma.financialLedgerEntry.count({ where: { orderId: order.id } })).toBe(ledgerBefore);
    expect(await app.get(NotificationService).hasConsent(order.customerId, w4.id, 'EMAIL')).toBe(false);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    expect(customer.email).toBeNull();
    expect(customer.status).toBe('ANONYMIZED');
  });
});
