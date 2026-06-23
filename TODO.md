# Real Ticket Stubs — production TODO

Track implementation status here. Matching `TODO:` comments live in the codebase.

## Payments & orders

- [x] **Stripe Checkout** — Stripe-hosted Checkout Session via `/api/create-checkout-session`; client redirects to Stripe (`server.mjs`, `client.js`)
- [x] **Stripe webhooks** — Signature-verified `/api/stripe/webhook` handling `checkout.session.completed` (`server.mjs`)
- [x] **Order persistence** — Supabase orders + stub PNG in Storage (`fulfillment.mjs`, migrations)
- [x] **Order confirmation email** — Customer + owner fulfillment emails via Resend (`fulfillment.mjs`)
- [ ] **Stripe Payment Links** — Update `STRIPE_PAYMENT_LINK_MAIL` / `_FRAMED` in Stripe Dashboard to $9.99 / $39.99 if using Payment Links

## Shipping & address validation

- [x] **Google Address Validation API** — Deliverability checks when `GOOGLE_ADDRESS_VALIDATION_API_KEY` is set (`shipping-verify-server.mjs`)
- [ ] **USPS Address API** — US-only verification via USPS Web Tools `USPS_USER_ID` (`shipping-verify-server.mjs`)
- [ ] **Address autocomplete** — Google Places / Mapbox on street field (Stripe collects shipping today)
- [ ] **International shipping** — Expand beyond US/Canada if needed (`shipping-validation.js`)

## Ticket extraction (AI / OCR)

- [x] **Production `ANTHROPIC_API_KEY`** — Set on Vercel; server-side only (`server.mjs`)
- [x] **Extract rate limiting** — Per-IP fixed-window throttling on all API routes (`server.mjs`)
- [x] **Upload size limits** — Body caps + image type/size validation on `/api/extract` (`server.mjs`)

## Fulfillment

- [x] **Stub PNG capture** — Client exports full-size PNG at checkout; validated + stored in Supabase Storage
- [ ] **Print fulfillment partner** — API to submit verified address + stub PNG for mailed orders
- [ ] **Stub PDF generation** — Server-side PDF if a partner requires it (Puppeteer / pdfkit)

## Security & ops

- [x] **Static file allowlist** — Server only serves whitelisted assets (`server.mjs`)
- [x] **Security headers** — CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors` (`server.mjs`)
- [x] **Request hardening** — Body size caps, request/headers timeouts (Slowloris), generic error responses (`server.mjs`)
- [x] **CORS** — Origin allowlist via `ALLOWED_ORIGINS` + preflight handling (`server.mjs`)
- [x] **Secrets** — `.env` git-ignored + auto-loaded; variables documented in `README.md`
- [x] **HTTPS** — Vercel + custom domain `www.realticketstubs.com`
- [ ] **Upstream WAF/CDN** — Cloudflare (or similar) in front for volumetric DDoS protection
- [ ] **Distributed rate limiting** — Move the in-memory limiter to Redis for multi-instance deploys (`server.mjs`)
- [ ] **Logging & monitoring** — Structured logs + error tracking (Sentry)
- [ ] **CI** — GitHub Action: smoke + PNG export tests

## Tests

- [x] **Smoke test** — `npm run test:smoke` (HTTP + unit checks)
- [x] **PNG export test** — `npm run test:png` (Playwright layout + dimensions)
- [x] **Fulfillment test** — `npm run test:fulfillment` (Supabase + Resend, optional)
- [ ] **Shipping validation tests** — Node test script for ZIP/email edge cases (`shipping-validation.js`)

## Legal & product

- [x] **Terms / privacy / refunds** — Pages served and linked in footer
- [ ] **Legal review** — Have a lawyer review terms/privacy/refunds before scaling marketing
