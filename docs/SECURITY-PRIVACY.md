# Security and privacy

This describes the controls that are implemented and tested, and lists what still needs a decision or an external review. It is not legal advice and not a compliance certification.

## Authentication and sessions

| Area | Control |
|---|---|
| Staff passwords | scrypt with a per-password salt; minimum 12 characters; generic error on failure |
| Lockout | 5 failed attempts lock the account for 15 minutes and raise an alert |
| Two-step verification | TOTP (RFC 6238). Secrets are encrypted at rest. Enabling it ends the user's other sessions |
| Staff sessions | 15-minute access token held in memory by the portal; refresh token in an `HttpOnly`, `SameSite=Strict` cookie, rotated on every use and stored only as a hash |
| Immediate revocation | The session, user status and permissions are re-read on every request, so suspension, sign-out and permission changes apply at once |
| Storefronts | Secret API key per storefront (hash stored), brand derived from the key, claimed domain must be a verified domain of that brand |
| Customers | Per-brand accounts; tokens are bound to one brand and carry a version that is bumped on password reset, which revokes existing sessions |
| Webhooks | Signature verified with the receiving merchant account's own secret before anything is stored as valid |

Two-step verification is available to every staff member but **not yet enforced**. The `security.requireMfaForAdmins` setting exists as a placeholder; enforcing it for administrator roles needs to be implemented before launch.

## Authorisation

- Role-based permissions stored in the database and editable at runtime; 46 permissions, 7 default roles.
- Tenant scoping is applied in the API for every list, record, export and report. Automated tests prove a Website 1 administrator cannot read or change Website 2 customers, orders, tickets, refunds, reports, segments, campaigns or support tickets, including through search, exports and direct record URLs.
- Privilege escalation is blocked: staff cannot grant brands, platform-wide access or roles containing permissions they do not hold.
- Separation of duties: refund requesters cannot approve their own refunds (unless explicitly permitted) and payout creators cannot approve their own payouts.

## Application security

| Risk | Control |
|---|---|
| Injection | Parameterised queries throughout (Prisma, tagged-template raw SQL). Tested with SQL metacharacters in search inputs |
| Mass assignment and tampering | Strict validation rejects unknown fields, so a client cannot supply prices, totals or a brand id |
| Cross-site scripting | Notification templates escape variables; campaign HTML previews render in sandboxed iframes; the portal is a React app with no raw HTML injection of user data |
| Cross-site request forgery | Admin API uses bearer tokens; the only cookie is `SameSite=Strict`. Storefront keys are never in a browser |
| Open redirects | Gateway return URLs must be on the storefront's own domain; tracked links redirect only for valid tracking tokens and http(s) targets |
| File uploads | Images only, type decided from file contents, 5 MB limit, server-generated names |
| Spreadsheet formula injection | Exported text cells beginning with `= + - @` are neutralised |
| Abuse | Redis-backed rate limits on sign-in, checkout, webhooks and scanning, plus edge limits in Nginx |
| Transport and headers | HSTS, `nosniff`, frame denial and related headers via Helmet and the portal config; TLS terminates at the edge |
| Secrets | No secrets in code or in the browser. Gateway credentials, MFA secrets, QR tokens and payout details are AES-256-GCM encrypted. Audit logs redact secret-like fields |
| Account pre-hijacking | Email verification requires being signed in to the account being verified; a password reset revokes prior sessions |
| Audit | Sensitive actions are written to an append-only audit log with actor, brand, before and after values, IP and correlation id |

Automated security tests cover the items above (see `apps/api/test/06-tenant-isolation.spec.ts` and `08-security-units.spec.ts`). **No independent penetration test or dependency audit has been performed.** Commission one before handling live payments, and add dependency scanning (`npm audit`, Dependabot or similar) and static analysis to your CI pipeline.

## Payment card data (PCI DSS)

The platform uses provider-hosted checkout only. Card numbers and CVV never reach the platform's servers, database or logs; stored gateway verification data is limited to non-card fields. This keeps the platform's PCI DSS scope small (typically SAQ A for fully redirected checkout), but the exact obligations depend on each legal entity's agreement with its provider. Confirm scope with Paystack and Flutterwave for each merchant account.

## Privacy by design

Designed with the Kenya Data Protection Act, 2019 in mind. Other jurisdictions (for example UK GDPR for a UK-facing brand) need their own assessment.

| Principle | Implementation |
|---|---|
| Purpose limitation between brands | Brand staff see only their own brand's relationship with a customer. Linking a person across brands does not expose one brand's data to another |
| Consent | Marketing consent is recorded per customer, brand and channel with source, wording, time and IP, as an append-only history. Checkout consent is unticked by default. Nothing subscribes a customer to another brand |
| Lawful sending | Consent is re-checked when each marketing message is sent. Transactional messages (orders, tickets, refunds, event changes) do not depend on marketing consent. Event reminders honour the customer's reminder preference |
| Opt-out | One-click unsubscribe links and headers; customers manage consent per channel in their account |
| Access | A data access request is fulfilled with a per-brand export of everything held |
| Correction | Staff edit customer details through an audited correction workflow; customers edit their own profile |
| Erasure | Anonymisation scrubs personal fields, consents, notes and preferences for a brand and, when no brand relationship remains, the central record. Orders and ledger entries are kept in anonymised form because financial records must be retained |
| Requests | `data_subject_requests` tracks access, correction and deletion requests with a due date (default 30 days) |
| Minimisation | QR codes carry no personal data. Ticket manifests for offline scanning contain token hashes, references and holder names only |
| Retention | See [DATABASE.md](DATABASE.md#soft-deletion-and-retention) |
| Controlled employee access | Role and brand scoping, event-scoped roles, audit of exports and ticket downloads |

Before launch, each legal entity acting as data controller should: register with the Office of the Data Protection Commissioner where required, publish its privacy policy through Brands → Policies, record its retention periods, sign data processing agreements with its processors (hosting, email, SMS, payment providers), assess cross-border transfers, and carry out a data protection impact assessment for cross-brand customer recognition.

## Legal structure reminders

- The brand shown to customers, the legal seller, the payment merchant and the event organizer are four separate records on every order.
- A shared technical platform does not make the five businesses one seller. A brand can only use a merchant account that the payment provider has approved for it.
- Promoter funds are tracked as a liability separate from platform revenue. Whether customer funds must be held in a segregated or trust account is a legal and regulatory question for each entity.
