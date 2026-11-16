# Central Ticketing Platform

One backend, database and administration portal behind any number of independently branded ticket-selling websites. Events, shared inventory, orders, payments, tickets, QR validation, customers, CRM, notifications, finance and reporting are all central; each storefront keeps its own brand, domain, emails and policies.

| Path | What it is |
|---|---|
| `apps/api` | Central API and background workers (NestJS, Prisma, PostgreSQL, Redis/BullMQ) |
| `apps/admin` | Administration portal and mobile ticket scanner (Next.js) |
| `apps/storefront` | Demonstration storefront serving the five demo brands by hostname (Next.js) |
| `docs` | [Architecture](docs/ARCHITECTURE.md), [Database](docs/DATABASE.md), [Operations](docs/OPERATIONS.md), [Security and privacy](docs/SECURITY-PRIVACY.md) |
| `infra` | Nginx configuration, backup and restore scripts |

## Run it locally

Requires Node.js 22+ and Docker.

```
npm install
docker compose up -d                          # PostgreSQL :5544, Redis :6390, Mailpit :8026, object storage :9010
cp apps/api/.env.example apps/api/.env
npm run db:migrate                            # apply migrations
npm run db:seed                               # reference data and five demo brands
npm run dev:api                               # API on http://localhost:4000 (docs at /docs)
npm run db:demo-orders -w @ctp/api            # optional: demo orders through the live API
npm run dev:admin                             # portal on http://localhost:3000
cp apps/storefront/.env.example apps/storefront/.env.local
npm run dev:storefront                        # storefronts on port 3100
```

| What | Where |
|---|---|
| Admin portal | http://localhost:3000, for example `superadmin@ctp.local` |
| Other demo staff | `finance@ctp.local`, `admin@tamasha.local`, `admin@gigpoa.local`, `support@tamasha.local`, `marketing@tamasha.local`, `events@ctp.local`, `scanner@ctp.local` |
| Demo staff password (development only) | `ChangeMe!Dev2026` |
| Scanner | http://localhost:3000/scan |
| Storefronts | http://tamasha.localhost:3100, http://gigpoa.localhost:3100, http://uwanja.localhost:3100, http://sherehe.localhost:3100, http://pulsepass.localhost:3100 |
| Emails sent in development | http://localhost:8026 |
| API reference | http://localhost:4000/docs |

Payments in development use the built-in sandbox gateway: a hosted page labelled "no real money" where you approve or decline, after which it sends a signed webhook like a real provider. It is refused in production.

## Tests

```
npm test                                      # 56 tests against a real PostgreSQL (database ctp_test) and Redis
npm run loadtest -w @ctp/api -- --scenario mixed --connections 80 --duration 20 --pay
```

The suite covers the ten acceptance scenarios: multi-brand order, cross-brand customer, shared inventory under concurrency, payment failure, duplicate webhooks, refunds, tenant isolation, QR scanning, brand suspension and a traffic burst.

## Adding a storefront

No code changes. In the portal: Brands → New brand, add and verify its domain, create a storefront API key, publish its policies, link an approved merchant account, then publish events to it. The storefront integrates with `/v1/storefront/*` from its own server; `apps/storefront/README.md` lists the integration rules.

## Status

See the status table in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#9-implementation-roadmap-and-status) and the "not done" notes in [docs/OPERATIONS.md](docs/OPERATIONS.md). In short: the platform works end to end against the sandbox gateway; live Paystack and Flutterwave accounts, SMS and WhatsApp credentials, the production Docker build, off-site backups, alert delivery, enforced two-step verification and a waiting room are still to be done or verified before launch.
