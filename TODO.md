# Real Ticket Stubs — production TODO

Track implementation status here. Matching `TODO:` comments live in the codebase.

## Payments & orders

- [x] **Stripe Checkout** — Stripe-hosted Checkout Session via `/api/create-checkout-session`; client redirects to Stripe (`server.mjs`, `app.js`)
- [x] **Stripe webhooks** — Signature-verified `/api/stripe/webhook` handling `checkout.session.completed` (`server.mjs`). TODO: do the actual fulfillment inside the handler.
- [ ] **Order persistence** — Store orders in a database (Supabase, Postgres, etc.) instead of console.log only (`server.mjs`)
- [ ] **Order confirmation email** — Send email with confirmation # and shipping summary (Resend, SendGrid, etc.) (`server.mjs`)

## Shipping & address validation

- [ ] **Google Address Validation API** — Deliverability / completeness checks beyond ZIP lookup (`shipping-verify-server.mjs`)
- [ ] **USPS Address API** — US-only verification via USPS Web Tools `USPS_USER_ID` (`shipping-verify-server.mjs`)
- [ ] **Address autocomplete** — Google Places / Mapbox on street field (`index.html`, `app.js`)
- [ ] **International shipping** — Expand beyond US/Canada if needed (`shipping-validation.js`)

## Ticket extraction (AI / OCR)

- [ ] **Production `ANTHROPIC_API_KEY`** — Set on host (Railway, Fly, Render, etc.); never expose to browser (`server.mjs`)
- [x] **Extract rate limiting** — Per-IP fixed-window throttling on all API routes (`server.mjs`)
- [x] **Upload size limits** — Body caps + image type/size validation on `/api/extract` (`server.mjs`)

## Fulfillment

- [ ] **Print fulfillment partner** — API to submit verified address + stub PDF/HTML for mailed $2.99 orders (`server.mjs`)
- [ ] **Stub PDF generation** — Server-side PDF for fulfillment (Puppeteer / pdfkit) (`server.mjs`)

## Security & ops

- [x] **Static file allowlist** — Server only serves whitelisted assets (closed the `.env`/source disclosure hole) (`server.mjs`)
- [x] **Security headers** — CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors` (`server.mjs`)
- [x] **Request hardening** — Body size caps, request/headers timeouts (Slowloris), generic error responses (`server.mjs`)
- [x] **CORS** — Origin allowlist via `ALLOWED_ORIGINS` + preflight handling (`server.mjs`)
- [x] **Secrets** — `.env` git-ignored + auto-loaded; variables documented in `README.md`
- [ ] **HTTPS only** — Enforce TLS in production reverse proxy / platform (see DEPLOYMENT.md)
- [ ] **Upstream WAF/CDN** — Cloudflare (or similar) in front for real volumetric DDoS protection (see DEPLOYMENT.md)
- [ ] **Distributed rate limiting** — Move the in-memory limiter to Redis for multi-instance deploys (`server.mjs`)
- [ ] **Logging & monitoring** — Structured logs + error tracking (Sentry)
- [ ] **CI** — GitHub Action: lint + validation unit tests

## Tests

- [ ] **Shipping validation tests** — Node test script for ZIP/email edge cases (`shipping-validation.js`)
- [ ] **E2E smoke test** — Upload → extract → checkout flow

## Legal & product

- [ ] **Terms / privacy** — Memorbilia disclaimer + data retention policy pages
- [ ] **Refund policy** — Linked from checkout modal
