# Demo storefront

One small Next.js application that serves all five demonstration brands, each on its own
hostname with its own name, colours, contact details, policies, events and prices. It exists
to show how a storefront integrates with the central ticketing platform. The real storefronts
are separate websites; they follow the same rules and call the same API.

## How a request becomes a brand

```
browser ──► https://tamasha.localhost:3100/...        (never talks to the central API)
              │  Host: tamasha.localhost:3100
              ▼
        storefront server (this app)
              │  STOREFRONT_KEYS[host]  →  sfk_...      (server-side configuration)
              ▼
        central API   X-Storefront-Key: sfk_...
                      X-Storefront-Domain: tamasha.localhost:3100
              │  key → brand; host must be a verified domain of that brand
              ▼
        brand-scoped response (theme, events, prices, orders, tickets)
```

- `src/lib/api.ts` is the only module that calls the central API. It is marked `server-only`,
  so it cannot be bundled into browser code.
- The brand is never read from a query parameter, cookie or form field. The host selects a key
  from server configuration, and the central API derives the brand from that key.
- An unknown host renders "Storefront not configured" and makes no API call.
- The signed-in customer's session token is stored in an httpOnly, SameSite=Lax cookie scoped
  to the host and forwarded as `X-Customer-Token`. Browser script cannot read it.
- The theme (header, hero, buttons, focus colour) is set from the brand record returned by
  `GET /v1/storefront/brand`, with a readable text colour chosen for each brand colour.

## Configuration

Copy `.env.example` to `.env.local`.

| Variable | Purpose |
| --- | --- |
| `API_URL` | Central API address as reachable from this server. Default `http://localhost:4000`. |
| `STOREFRONT_KEYS` | JSON object mapping each host (with port, if any) to that brand's storefront API key. Server-side only: never give it a `NEXT_PUBLIC_` prefix. |

The keys in `.env.example` are the local development keys created by the demo seed. In any
real environment, issue a key per brand in Admin → Brands → API keys and keep it in a secret
store.

## Running it

```bash
# from the repository root, with the API running (npm run dev:api) and the demo seed loaded
npm run dev -w @ctp/storefront
```

Then open, for example:

- http://tamasha.localhost:3100
- http://gigpoa.localhost:3100
- http://uwanja.localhost:3100
- http://sherehe.localhost:3100
- http://pulsepass.localhost:3100

`*.localhost` resolves to `127.0.0.1` in current browsers. From a terminal, send the host
explicitly: `curl -H "Host: tamasha.localhost:3100" http://127.0.0.1:3100/`.

Payments in development go through the platform's sandbox gateway (clearly labelled, no real
money). Emails are delivered to Mailpit at http://localhost:8026.

## Adding a sixth brand

No code changes:

1. In the admin portal, create the brand, add and verify its domain, assign a legal entity and
   an approved payment configuration, publish its policies and issue a storefront API key.
2. Publish events to the brand.
3. Add `"<host>": "<key>"` to `STOREFRONT_KEYS` and restart this app (or deploy a separate
   storefront with its own key).

## Rules every real storefront must follow

1. **Keep the storefront key on the server.** Call the central API from your server only.
   Never ship the key, or the API address, to the browser.
2. **Never send a brand id.** The key identifies the brand. Send `X-Storefront-Domain` with the
   host the customer is actually on; it must be a verified domain of the brand.
3. **Never treat the payment return page as proof of payment.** Ignore `status`, `reference`
   and any other parameter the gateway adds to the return URL. Find the order from your own
   server-side state (this app uses an httpOnly cookie set at checkout), call
   `POST /v1/storefront/orders/{reference}/verify`, then show whatever
   `GET /v1/storefront/orders/{reference}` reports. Tickets exist only after the platform has
   verified the payment with the provider.
4. **Send an `Idempotency-Key` with every checkout.** Generate it for one specific basket and
   buyer and reuse it if the request is retried, so a double click or a network retry can never
   create two orders or hold stock twice. Use a new key when the basket changes.
5. **Take totals from the platform.** Use `POST /v1/storefront/checkout/quote` for the price
   breakdown. Do not calculate fees, tax or discounts in the storefront, and do not decide
   availability from cached data: the checkout call is the authoritative stock check.
6. **Marketing consent is opt-in and unticked by default**, worded for this brand only. Do not
   send `marketingOptIn` unless the customer ticked the box. Consent given to one brand never
   applies to another.
7. **Require acceptance of the terms and refund policy** before checkout (`acceptPolicies`),
   and link to the policy pages. The platform records which policy versions applied.
8. **Email verification needs a signed-in session.** Send the customer to sign in before
   posting the verification token. Do not show orders or tickets for an unverified account.
9. **Serve ticket PDFs and QR codes through your server**, so the customer's access (session,
   or order reference plus email) is checked by the platform on every request.
10. **Handle platform errors by `error.code`**, for example `INSUFFICIENT_INVENTORY`,
    `SALES_NOT_STARTED`, `PROMO_INVALID`, `BRAND_NOT_ACTIVE` (the brand is suspended: stop
    selling, keep order lookup and tickets working) and `ORDER_NOT_PAYABLE`.

## Pages

| Path | What it does |
| --- | --- |
| `/` | Events published to this brand, search and category filter |
| `/events/[slug]` | Event detail, ticket selection, live quote and checkout |
| `/orders`, `/orders/[reference]` | Guest order lookup; order status, payment retry, tickets with QR and PDF |
| `/orders/return` | Where the gateway returns the buyer; redirects to the order page without reading gateway parameters |
| `/tickets/[id]`, `/tickets/[id]/pdf` | A single ticket and its PDF download |
| `/account`, `/account/login`, `/account/register`, `/account/forgot-password`, `/reset-password`, `/verify-email` | Customer account, tickets, orders, ticket transfer and marketing preferences |
| `/transfers/claim` | Accept a transferred ticket |
| `/support` | Contact form creating a support request with this brand |
| `/terms`, `/refund-policy`, `/privacy` | The brand's current policy text and version |
