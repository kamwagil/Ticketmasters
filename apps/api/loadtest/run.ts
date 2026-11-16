/**
 * Load test against a RUNNING API (never run this against production data).
 *
 *   npm run loadtest -w @ctp/api -- --scenario browse   --connections 100 --duration 20
 *   npm run loadtest -w @ctp/api -- --scenario checkout --connections 50  --duration 20
 *   npm run loadtest -w @ctp/api -- --scenario mixed    --connections 100 --duration 30
 *
 * Options: --url (default http://localhost:4000), --brands tamasha,gigpoa,... (demo storefront keys),
 * --pay (also settle each checkout through the sandbox gateway so webhooks and ticket issuance are exercised).
 *
 * Besides latency and throughput, the script finishes with integrity checks read from the
 * database: no category oversold, sold counter equals live tickets, ledger balanced.
 * Results depend on the machine and on API/worker replica counts: quote them with that context.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import autocannon from 'autocannon';
import { randomUUID } from 'crypto';
import { DEMO_BRANDS, demoStorefrontKey } from '../prisma/seed';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const URL_BASE = arg('url', 'http://localhost:4000');
const scenario = arg('scenario', 'mixed');
const connections = Number(arg('connections', '50'));
const duration = Number(arg('duration', '20'));
const slugs = arg('brands', DEMO_BRANDS.filter((b) => b.currency === 'KES').map((b) => b.slug).join(',')).split(',');
const prisma = new PrismaClient();

interface Target {
  key: string;
  domain: string;
  eventId: string;
  categoryId: string;
}

async function discover(): Promise<Target[]> {
  const targets: Target[] = [];
  for (const slug of slugs) {
    const b = DEMO_BRANDS.find((x) => x.slug === slug);
    if (!b) throw new Error(`Unknown demo brand ${slug}`);
    const key = demoStorefrontKey(slug);
    const domain = `${slug}.localhost:${b.port}`;
    const headers = { 'X-Storefront-Key': key, 'X-Storefront-Domain': domain };
    const list: any = await (await fetch(`${URL_BASE}/v1/storefront/events?pageSize=20`, { headers })).json();
    for (const e of list.items ?? []) {
      const detail: any = await (await fetch(`${URL_BASE}/v1/storefront/events/${e.id}`, { headers })).json();
      const cat = (detail.ticketCategories ?? []).filter((c: any) => c.onSale).sort((a: any, z: any) => a.priceMinor - z.priceMinor)[0];
      if (cat) targets.push({ key, domain, eventId: e.id, categoryId: cat.id });
    }
  }
  if (!targets.length) throw new Error('No sellable events found. Load the demo seed first.');
  return targets;
}

async function main() {
  const targets = await discover();
  const pick = () => targets[Math.floor(Math.random() * targets.length)];
  const paid: string[] = [];
  let seq = 0;

  const browse = () => {
    const t = pick();
    const r = Math.random();
    const path = r < 0.45 ? '/v1/storefront/events' : r < 0.8 ? `/v1/storefront/events/${t.eventId}` : `/v1/storefront/events/${t.eventId}/inventory`;
    return { method: 'GET' as const, path, headers: { 'X-Storefront-Key': t.key, 'X-Storefront-Domain': t.domain } };
  };
  const buy = () => {
    const t = pick();
    const n = ++seq;
    return {
      method: 'POST' as const,
      path: '/v1/storefront/checkout/orders',
      headers: { 'X-Storefront-Key': t.key, 'X-Storefront-Domain': t.domain, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({
        eventId: t.eventId, items: [{ ticketCategoryId: t.categoryId, quantity: 1 + (n % 3) }], acceptPolicies: true,
        customer: { email: `load${n % 5000}@loadtest.example`, fullName: `Load Tester ${n % 5000}`, country: 'Kenya' },
      }),
    };
  };

  const started = new Date();
  const result = await autocannon({
    url: URL_BASE,
    connections,
    duration,
    timeout: 30,
    requests: [
      {
        setupRequest: (req: any) => {
          const next = scenario === 'browse' ? browse() : scenario === 'checkout' ? buy() : Math.random() < 0.85 ? browse() : buy();
          return { ...req, ...next };
        },
        onResponse: (status: number, body: string) => {
          if (status === 201 && flag('pay')) {
            try {
              const ref = JSON.parse(body)?.payment?.reference;
              if (ref) paid.push(ref);
            } catch {
              /* not a checkout response */
            }
          }
        },
      },
    ],
  } as any);

  if (flag('pay') && paid.length) {
    console.log(`Settling ${paid.length} checkouts through the sandbox gateway...`);
    for (let i = 0; i < paid.length; i += 25) {
      await Promise.all(paid.slice(i, i + 25).map((ref) =>
        fetch(`${URL_BASE}/sandbox-gateway/pay/${ref}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'outcome=success', redirect: 'manual' }).catch(() => undefined)));
    }
    await new Promise((r) => setTimeout(r, 8000)); // let workers drain
  }

  const codes = Object.entries((result as any).statusCodeStats ?? {}).map(([c, v]: [string, any]) => `${c}: ${v.count}`).join(', ');
  console.log(`\nScenario "${scenario}" · ${connections} connections · ${duration}s · ${URL_BASE}`);
  console.log(`  requests: ${result.requests.total} total, ${result.requests.average.toFixed(0)} req/s average`);
  console.log(`  latency ms: p50 ${result.latency.p50}, p97.5 ${result.latency.p97_5}, p99 ${result.latency.p99}, max ${result.latency.max}`);
  console.log(`  responses: ${codes || 'n/a'} · errors ${result.errors} · timeouts ${result.timeouts}`);
  console.log('  (409 = sold out or purchase limit, expected under contention; 429 = rate limited; any 5xx is a failure)');

  const oversold = await prisma.ticketInventory.count({ where: { OR: [{ sold: { lt: 0 } }, { reserved: { lt: 0 } }] } });
  const [{ bad }] = await prisma.$queryRaw<{ bad: bigint }[]>`SELECT COUNT(*)::bigint AS bad FROM "ticket_inventory" WHERE "sold" + "reserved" > "total"`;
  const [{ mismatch }] = await prisma.$queryRaw<{ mismatch: bigint }[]>`
    SELECT COUNT(*)::bigint AS mismatch FROM "ticket_inventory" i
     WHERE i."sold" <> (SELECT COUNT(*) FROM "tickets" t WHERE t."ticketCategoryId" = i."ticketCategoryId" AND t."status" IN ('VALID','USED'))`;
  const [{ diff }] = await prisma.$queryRaw<{ diff: bigint }[]>`
    SELECT COALESCE(SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountMinor" ELSE -"amountMinor" END), 0)::bigint AS diff FROM "financial_ledger_entries"`;
  const orders = await prisma.order.groupBy({ by: ['status'], where: { createdAt: { gte: started } }, _count: true });
  console.log('\nIntegrity after the run:');
  console.log(`  oversold categories: ${Number(bad) + oversold} (must be 0)`);
  console.log(`  categories where sold != live tickets: ${mismatch} (must be 0 once payments have settled)`);
  console.log(`  ledger imbalance: ${diff} (must be 0)`);
  console.log(`  orders created: ${orders.map((o) => `${o.status} ${o._count}`).join(', ') || 'none'}`);
  const failed = Number(bad) + oversold > 0 || diff !== 0n || Object.keys((result as any).statusCodeStats ?? {}).some((c) => c.startsWith('5'));
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
