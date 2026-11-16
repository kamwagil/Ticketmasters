# Operations: deployment, monitoring, performance and recovery

## Deployment

Images are built from the repository root: `apps/api/Dockerfile` (API and worker), `apps/admin/Dockerfile`, `apps/storefront/Dockerfile`.

```
cp .env.production.example .env.production      # fill in secrets
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build --scale api=3 --scale worker=2
```

`docker-compose.prod.yml` runs PostgreSQL, Redis, a one-shot `migrate` job (migrations plus reference data), API replicas (`RUN_WORKERS=false`), worker replicas (`node dist/worker.js`), the admin portal, Nginx and a scheduled backup job. This file was validated with `docker compose config`; **the production images have not been built or run in this session**, so expect to fix small issues on the first real build.

First administrator: set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (14+ characters) on the `migrate` service for one run, sign in, enable two-step verification, then remove the variables.

For sustained high traffic, run the same images on an orchestrator (Kubernetes, ECS) with managed PostgreSQL and Redis. The API and workers keep no local state. Keep `(API replicas + worker replicas) × DB_POOL_PER_PROCESS` below the database connection limit, or put PgBouncer in transaction mode in front of PostgreSQL. Add a read replica only after measuring that reporting queries compete with checkout.

Terminate TLS at Nginx or a managed load balancer. The API trusts one proxy hop (`trust proxy = 1`) for client IPs.

### Configuration

All settings are environment variables, documented in `apps/api/.env.example` and `.env.production.example`. The API refuses to start in production with default or short secrets. Gateway credentials are not environment variables: they are entered per merchant account in Integrations and stored encrypted with `DATA_ENCRYPTION_KEY`. Losing that key makes them (and MFA secrets and QR tokens) unreadable, so keep it in a secrets manager, separately from database backups.

### Payment provider setup

1. Integrations → Payment accounts: add the merchant account for the legal entity, with its credentials.
2. Copy the account's webhook URL (`{API_PUBLIC_URL}/v1/webhooks/{provider}/{accountId}`) into the provider dashboard.
3. Brands → Payments: link the brand to the account for specific currencies and tick the provider-approval attestation only once the provider has approved that brand and domain on that account.
4. Make a small live payment and refund, and confirm both in Payments, the order's ledger and a reconciliation run.

The Paystack and Flutterwave adapters follow the providers' published APIs but **have not been run against live or test accounts in this session**. Treat step 4 as mandatory.

### Email sending domains (SPF, DKIM, DMARC)

Each brand sends from its own address. For each sending domain publish:

| Record | Host | Value |
|---|---|---|
| SPF | `@` | `v=spf1 include:<your email provider's include> -all` |
| DKIM | `<selector>._domainkey` | The CNAME or TXT your email provider gives you |
| DMARC | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@<domain>; adkim=s; aspf=s`, then tighten to `quarantine` and `reject` once reports are clean |

Integrations → Sender domains shows the exact records per brand and checks whether SPF and DMARC are currently published.

## Background work

| Queue | Work | Schedule |
|---|---|---|
| `payment-webhook` | Verify and apply a stored webhook event | On receipt |
| `notification-deliver`, `notification-sweep` | Deliver the notification outbox with retries | On commit and every 30s |
| `campaign-dispatch` | Fan out a campaign to its audience | On schedule or send-now |
| `maint-expire-orders` | Expire unpaid reservations and release inventory | 30s |
| `maint-payments` | Re-queue unprocessed webhooks; ask gateways about pending payments | 60s |
| `maint-lifecycle` | Scheduled publication, event completion, payable availability, reminders, transfer expiry | 60s |
| `maint-health` | Inventory reconciliation, backlog and failure alerts, retention cleanup | 5 min |

Schedules are BullMQ job schedulers, so each tick runs on exactly one worker however many replicas exist. Durable state lives in PostgreSQL (the webhook event row, the outbox row), so a lost queue job is picked up by the next sweep. This was exercised for real during development: 146 webhooks stranded by a worker start-up bug were all processed by the sweep once the bug was fixed.

## Monitoring

- **Probes**: `GET /health/live` (process up), `GET /health/ready` (database and Redis reachable; 503 if the database is down).
- **Metrics**: `GET /metrics` in Prometheus text format (requires `Authorization: Bearer $METRICS_TOKEN`); blocked at the public edge by the Nginx config.
- **Logs**: one JSON line per request and event on stdout with a correlation id. `X-Request-Id` is accepted from the caller, echoed in the response, stored in audit and integration logs, and carried into background jobs.
- **System health page** (Settings → System health): uptime, latency percentiles, requests per minute, database connections, Redis, queue depths, failed jobs, webhook backlog, email failures, storage and SMTP checks. Request metrics are per API instance; aggregate across replicas in Prometheus.
- **Alerts** (table `alerts`, shown in the portal bell and health page):

| Alert | Raised when |
|---|---|
| `PAYMENT_INIT_FAILED`, `PAYMENT_MISMATCH`, `DUPLICATE_PAYMENT`, `WEBHOOK_ACCOUNT_MISMATCH` | A gateway call fails, or a captured payment does not match the order |
| `PAID_ORDER_UNFULFILLABLE` | A payment arrived after its tickets were released and resold |
| `UNPROCESSED_WEBHOOKS`, `WEBHOOK_SIGNATURE_INVALID` | Webhooks unprocessed for 10 minutes; forged or misconfigured webhooks |
| `INVENTORY_INCONSISTENCY` | Counters disagree with movements, reservations or live tickets |
| `TICKET_ISSUANCE_FAILED` | An order is paid without tickets for more than 5 minutes |
| `QUEUE_BACKLOG`, `EMAIL_DELIVERY_FAILURES`, `NOTIFICATION_FAILED` | Queues or email delivery are falling behind |
| `REFUND_FAILED`, `GATEWAY_REFUND_FAILED`, `UNUSUAL_REFUND_ACTIVITY` | Refund problems or an unusual refund rate |
| `SUSPICIOUS_LOGIN` | An account is locked after repeated failed sign-ins |
| `OFFLINE_SCAN_CONFLICT` | Offline sync found a duplicate entry |
| `RECONCILIATION_ISSUES` | A reconciliation run found critical differences |

Alerts are stored and displayed; **they are not yet pushed to email, Slack or a pager**. Wire the `alerts` table or the log stream into your on-call tool before launch.

## Performance

### What was measured

Tests ran on one development laptop (Intel i7-8665U, 4 cores, Windows 11) that was also running PostgreSQL, Redis, the admin portal, the storefront and the load generator. A bare Node HTTP server on this machine handles about 2,500 requests per second, so these figures are a floor set by the test machine, not a statement of production capacity.

| Scenario (single API process that also runs the workers) | Result |
|---|---|
| Browse: listings, event pages, live inventory, 100 connections, 15s | 127 req/s, p50 723 ms, p99 1.7 s, 0 errors |
| Mixed: 85% browse and 15% checkout, 80 connections, 20s, then payments settled | 128 req/s, p50 144 ms, p99 7.5 s, 307 orders created, 0 errors |
| Checkout only, 40 connections, 15s | 23 orders/s, p50 1.6 s, p99 2.4 s, 0 errors |
| After every run | 0 oversold categories, sold counters equal to live tickets, ledger imbalance 0 |

Automated tests additionally cover 60 simultaneous buyers competing for 100 tickets across five storefronts and a 250-checkout burst with duplicate webhooks, both with exact inventory and ledger assertions.

**No capacity claim is made beyond these numbers.** Before a major on-sale, run `npm run loadtest -w @ctp/api` against a production-shaped environment with your target traffic:

```
npm run loadtest -w @ctp/api -- --url https://staging-api.example.com --scenario mixed --connections 500 --duration 120 --pay
```

### Design limits to know about

- **One inventory row per ticket category** is the serialisation point. Checkout and fulfilment hold its lock for a few statements. Throughput for a single hot category is therefore bounded by database round-trip time, regardless of API replica count.
- **Checkout does roughly 25 database round trips.** If load tests show checkout latency is the limit, the first candidates are caching commission rules and brand policy versions for a few seconds, and moving the reservation into a single SQL function.
- **Caches**: storefront key lookup (5s, in-process), event listings (20s) and event presentation (15s) in Redis. Stock levels and payment status are never cached. A suspended brand or revoked key takes effect within 5 seconds per replica.

### Waiting room

A controlled waiting room for very high-demand releases is **not implemented**. The platform will stay correct under a surge (inventory cannot oversell, and excess checkouts are rejected quickly with `INSUFFICIENT_INVENTORY` or rate-limited with `429`), but customers would experience errors rather than an orderly queue. If you expect releases where demand far exceeds what the measured checkout rate can serve, add one before that event: either a CDN-level waiting room product, or an admission token issued by the API (Redis counter of admitted sessions per event) that the checkout endpoint requires.

## Backups and disaster recovery

| Item | Provided |
|---|---|
| Logical backups | `infra/scripts/backup.sh` (`pg_dump` custom format, verified with `pg_restore --list`), run every 6 hours by the `backup` service, 14 days kept |
| WAL archiving | Enabled in the production compose file to a local volume, as the basis for point-in-time recovery |
| Restore | `infra/scripts/restore.sh <dump> <new-db>` restores into a new database and prints integrity checks (row counts, ledger imbalance, oversold categories, latest order time) |

**Not done in this session, and required before launch:** copying backups and WAL off the host to another region, and a timed restore drill. On a managed PostgreSQL service use its automated backups and point-in-time recovery instead of the compose volumes.

Recovery procedure:

1. Stop the API and workers so no new orders are accepted. Storefronts show their maintenance page.
2. Restore the most recent backup into a new database (replay WAL to the target time if using point-in-time recovery).
3. Review the integrity checks printed by `restore.sh`.
4. Point `DATABASE_URL` at the restored database and start workers, then the API.
5. Run a reconciliation with gateway verification for the period since the backup. Payments captured after the backup will be found by the pending-payment sweep or reported by reconciliation; resolve each one (the gateway remains the record of what was charged).
6. Redis holds only queues, rate limits and caches. If it is lost, start a fresh one: the sweeps rebuild the queues from PostgreSQL.

Decide and write down your recovery point and recovery time objectives; the 6-hour dump interval alone means up to 6 hours of orders would need to be reconstructed from gateway records without WAL replay.

### Data breach response

1. Contain: revoke affected storefront keys and staff sessions (suspend the accounts), rotate `JWT_*` secrets (signs everyone out) and gateway credentials.
2. Assess from `audit_logs`, `integration_logs` and request logs using correlation ids: what was accessed, for which brands and customers.
3. Notify: under the Kenya Data Protection Act, 2019, the data controller must notify the Office of the Data Protection Commissioner within 72 hours of becoming aware of a breach involving real risk of harm, and affected data subjects without undue delay. Confirm the obligations for each brand and jurisdiction with counsel.
4. Record the incident, remediation and lessons.
