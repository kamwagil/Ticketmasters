/**
 * Development demo data. Drives the REAL platform over HTTP: storefront checkout, the sandbox
 * gateway (signed webhooks), refunds with approval, scanning, support and customer accounts.
 * Nothing is inserted behind the application's back, except that finished orders are then
 * spread over the previous 30 days so charts have a history (dev only, clearly marked below).
 *
 * Requires the API to be running (npm run dev:api) with the sandbox provider enabled.
 * Usage: npm run db:demo-orders -w @ctp/api  [-- <orderCount>]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { decrypt } from '../src/common/crypto';
import { DEMO_BRANDS, DEMO_PASSWORD, demoStorefrontKey } from './seed';

const API = process.env.API_PUBLIC_URL ?? 'http://localhost:4000';
const COUNT = Number(process.argv[2] ?? 160);
const prisma = new PrismaClient();

const FIRST = ['Wanjiku', 'Otieno', 'Achieng', 'Kamau', 'Njeri', 'Mutua', 'Akinyi', 'Kiprop', 'Wambui', 'Omondi', 'Chebet', 'Mwangi', 'Nyambura', 'Barasa', 'Atieno', 'Kariuki', 'Zawadi', 'Hassan', 'Amina', 'Juma', 'Fatuma', 'Baraka', 'Imani', 'Daudi'];
const LAST = ['Mwangi', 'Odhiambo', 'Kimani', 'Wafula', 'Njoroge', 'Ochieng', 'Chepkoech', 'Mutiso', 'Kiplagat', 'Wanyama', 'Abdi', 'Gathoni', 'Onyango', 'Muriuki', 'Korir', 'Nduta'];
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const chance = (p: number) => Math.random() < p;

async function call(method: string, path: string, opts: { key?: string; domain?: string; token?: string; customer?: string; body?: unknown; idem?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.key) headers['X-Storefront-Key'] = opts.key;
  if (opts.domain) headers['X-Storefront-Domain'] = opts.domain;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.customer) headers['X-Customer-Token'] = opts.customer;
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  const res = await fetch(API + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
  return { status: res.status, json };
}

async function staff(email: string) {
  const r = await call('POST', '/v1/admin/auth/login', { body: { email, password: DEMO_PASSWORD } });
  if (r.status !== 200) throw new Error(`Cannot sign in as ${email}: is the demo seed loaded?`);
  return r.json.accessToken as string;
}

async function main() {
  const health = await fetch(`${API}/health/ready`).catch(() => null);
  if (!health?.ok) throw new Error(`API is not reachable at ${API}. Start it first (npm run dev:api).`);

  const people = Array.from({ length: 70 }, (_, i) => {
    const first = pick(FIRST);
    const last = pick(LAST);
    return { fullName: `${first} ${last}`, email: `${first}.${last}${i}@example.com`.toLowerCase(), phone: `+2547${String(10000000 + Math.floor(Math.random() * 89999999))}`, country: 'Kenya' };
  });

  const brands = await Promise.all(
    DEMO_BRANDS.map(async (b) => {
      const key = demoStorefrontKey(b.slug);
      const domain = `${b.slug}.localhost:${b.port}`;
      const list = await call('GET', '/v1/storefront/events?pageSize=50', { key, domain });
      const events = await Promise.all((list.json?.items ?? []).map((e: any) => call('GET', `/v1/storefront/events/${e.id}`, { key, domain }).then((r) => r.json)));
      return { ...b, key, domain, events: events.filter((e) => e?.ticketCategories?.some((c: any) => c.onSale)) };
    }),
  );

  const stats = { paid: 0, declined: 0, abandoned: 0, soldOut: 0, refunded: 0 };
  const paidOrders: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const brand = pick(brands.filter((b) => b.events.length));
    const event = pick(brand.events);
    const category = pick(event.ticketCategories.filter((c: any) => c.onSale)) as any;
    const person = pick(people);
    const quantity = Math.min(category.maxPerOrder, pick([1, 1, 2, 2, 2, 3, 4]));
    const promo = brand.slug === 'tamasha' && chance(0.15) ? 'KARIBU10' : undefined;
    const order = await call('POST', '/v1/storefront/checkout/orders', {
      key: brand.key, domain: brand.domain, idem: randomUUID(),
      body: { eventId: event.id, items: [{ ticketCategoryId: category.id, quantity }], customer: person, acceptPolicies: true, marketingOptIn: chance(0.45), promoCode: promo },
    });
    if (order.status !== 201) { stats.soldOut++; continue; }
    const roll = Math.random();
    if (roll < 0.08) { stats.abandoned++; continue; } // never pays: the reservation will expire
    const outcome = roll < 0.2 ? 'failed' : 'success';
    await fetch(`${API}/sandbox-gateway/pay/${order.json.payment.reference}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `outcome=${outcome}`, redirect: 'manual',
    });
    if (outcome === 'success') { stats.paid++; paidOrders.push(order.json.orderReference); } else stats.declined++;
    if ((i + 1) % 40 === 0) console.log(`  ${i + 1}/${COUNT} checkouts...`);
  }

  // ── Refunds through the approval workflow (requested by support, approved by finance) ──
  const admin = await staff('superadmin@ctp.local');
  const finance = await staff('finance@ctp.local');
  for (const ref of paidOrders.filter(() => chance(0.07))) {
    const found = await call('GET', `/v1/admin/orders?q=${ref}`, { token: admin });
    const o = found.json?.items?.[0];
    if (!o) continue;
    const req = await call('POST', `/v1/admin/orders/${o.id}/refunds`, { token: admin, idem: randomUUID(), body: { reason: pick(['Customer can no longer attend', 'Duplicate purchase', 'Bought the wrong ticket type']) } });
    if (req.status === 201 && chance(0.75)) {
      const ok = await call('POST', `/v1/admin/refunds/${req.json.id}/approve`, { token: finance });
      if (ok.status === 200) stats.refunded++;
    }
  }

  // ── Customer accounts, a cross-brand customer, a support request ──
  const tamasha = brands.find((b) => b.slug === 'tamasha')!;
  const account = { email: 'demo.customer@example.com', fullName: 'Demo Customer', phone: '+254712345678', country: 'Kenya' };
  for (const b of brands.filter((x) => ['tamasha', 'uwanja'].includes(x.slug))) {
    const reg = await call('POST', '/v1/storefront/customers/register', { key: b.key, domain: b.domain, body: { ...account, password: 'Demo-Customer-2026', marketingOptIn: b.slug === 'tamasha' } });
    if (reg.status === 201 && b.events.length) {
      const event = b.events[0];
      const cat = event.ticketCategories.find((c: any) => c.onSale);
      const o = await call('POST', '/v1/storefront/checkout/orders', { key: b.key, domain: b.domain, customer: reg.json.token, idem: randomUUID(), body: { eventId: event.id, items: [{ ticketCategoryId: cat.id, quantity: 2 }], customer: account, acceptPolicies: true } });
      if (o.status === 201) await fetch(`${API}/sandbox-gateway/pay/${o.json.payment.reference}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'outcome=success', redirect: 'manual' });
    }
  }
  await call('POST', '/v1/storefront/support/tickets', {
    key: tamasha.key, domain: tamasha.domain,
    body: { email: people[0].email, name: people[0].fullName, subject: 'I have not received my tickets', message: 'I paid yesterday but cannot find the ticket email. Could you resend it please?', issueType: 'TICKET_DELIVERY' },
  });
  await call('POST', '/v1/storefront/support/tickets', {
    key: tamasha.key, domain: tamasha.domain,
    body: { email: people[1].email, name: people[1].fullName, subject: 'Refund request - cannot travel', message: 'I can no longer travel to Nairobi for the festival. Am I eligible for a refund?', issueType: 'REFUND_REQUEST' },
  });

  // ── Gate scans for the soonest event (the scanner reads QR text; here it is decrypted from the dev database) ──
  const scanner = await staff('scanner@ctp.local');
  const soonest = await prisma.event.findFirst({ where: { status: 'PUBLISHED', tickets: { some: { status: 'VALID' } } }, orderBy: { startsAt: 'asc' } });
  let scans = 0;
  if (soonest) {
    const tickets = await prisma.ticket.findMany({ where: { eventId: soonest.id, status: 'VALID' }, take: 25, include: { qrTokens: { where: { active: true } } } });
    for (const t of tickets) {
      const token = decrypt(t.qrTokens[0].tokenEnc);
      const r = await call('POST', '/v1/scanner/scan', { token: scanner, body: { eventId: soonest.id, token, deviceId: 'demo-gate-phone', gate: pick(['Gate A', 'Gate B', 'VIP Entrance']) } });
      if (r.json?.admitted) scans++;
      if (chance(0.15)) await call('POST', '/v1/scanner/scan', { token: scanner, body: { eventId: soonest.id, token, deviceId: 'demo-gate-phone', gate: 'Gate A' } }); // someone tries a screenshot
    }
  }

  // ── DEV ONLY: spread the orders created above across the last 30 days so charts have a history. ──
  // Timestamps of append-only tables are shifted with triggers disabled for this one transaction.
  // Amounts, statuses and relationships are untouched. Never do this outside demo data.
  const since = new Date(Date.now() - 6 * 3600_000);
  const orders = await prisma.order.findMany({ where: { createdAt: { gt: since } }, select: { id: true } });
  for (let i = 0; i < orders.length; i += 50) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      for (const o of orders.slice(i, i + 50)) {
        // Weighted towards recent days, with a daily rhythm.
        const shift = `${Math.floor(Math.pow(Math.random(), 1.7) * 29 * 24 * 60 + Math.random() * 600)} minutes`;
        const q = (sql: string) => tx.$executeRawUnsafe(sql, o.id, shift);
        await q(`UPDATE "orders" SET "createdAt" = "createdAt" - $2::interval, "paidAt" = "paidAt" - $2::interval, "ticketsIssuedAt" = "ticketsIssuedAt" - $2::interval, "updatedAt" = "updatedAt" - $2::interval WHERE "id" = $1::uuid`);
        await q(`UPDATE "order_status_history" SET "createdAt" = "createdAt" - $2::interval WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "payments" SET "createdAt" = "createdAt" - $2::interval, "paidAt" = "paidAt" - $2::interval WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "tickets" SET "issuedAt" = "issuedAt" - $2::interval WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "ledger_transactions" SET "createdAt" = "createdAt" - $2::interval WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "financial_ledger_entries" SET "createdAt" = "createdAt" - $2::interval WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "refunds" SET "requestedAt" = "requestedAt" - $2::interval / 2, "processedAt" = "processedAt" - $2::interval / 2 WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "email_jobs" SET "createdAt" = "createdAt" - $2::interval, "sentAt" = "sentAt" - $2::interval WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "promoter_payables" SET "createdAt" = "createdAt" - $2::interval WHERE "orderId" = $1::uuid`);
        await q(`UPDATE "inventory_reservations" SET "createdAt" = "createdAt" - $2::interval WHERE "orderId" = $1::uuid`);
      }
      await tx.$executeRawUnsafe(`UPDATE "customer_brand_relationships" r SET "createdAt" = LEAST(r."createdAt", o.first), "firstOrderAt" = o.firstpaid, "lastOrderAt" = o.lastpaid
        FROM (SELECT "relationshipId", MIN("createdAt") AS first, MIN("paidAt") AS firstpaid, MAX("paidAt") AS lastpaid FROM "orders" GROUP BY 1) o WHERE o."relationshipId" = r."id"`);
      await tx.$executeRawUnsafe(`UPDATE "customers" c SET "createdAt" = LEAST(c."createdAt", r.first) FROM (SELECT "customerId", MIN("createdAt") AS first FROM "customer_brand_relationships" GROUP BY 1) r WHERE r."customerId" = c."id"`);
    }, { timeout: 120_000 });
  }

  console.log('\nDemo activity created through the live API:');
  console.log(`  ${stats.paid} paid orders, ${stats.declined} declined payments, ${stats.abandoned} abandoned checkouts, ${stats.soldOut} rejected (limits or stock)`);
  console.log(`  ${stats.refunded} refunds approved and processed, ${scans} tickets scanned at the gate, 2 support requests`);
  console.log('  Storefront customer account: demo.customer@example.com / Demo-Customer-2026 (Tamasha Tickets and Uwanja Sports)');
  console.log('  Emails were delivered to Mailpit: http://localhost:8026');
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
