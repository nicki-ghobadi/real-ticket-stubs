# Real Ticket Stubs — production TODO

Track implementation status here. Matching `TODO:` comments live in the codebase.

## Payments & orders

- [ ] **Stripe Checkout** — Replace mock card form with Stripe Payment Element / Checkout Session (`server.mjs`, `app.js`)
- [ ] **Stripe webhooks** — Confirm payment before fulfillment; handle `payment_intent.succeeded` (`server.mjs`)
- [ ] **Order persistence** — Store orders in a database (Supabase, Postgres, etc.) instead of console.log only (`server.mjs`)
- [ ] **Order confirmation email** — Send email with confirmation # and shipping summary (Resend, SendGrid, etc.) (`server.mjs`)

## Shipping & address validation

- [ ] **Google Address Validation API** — Deliverability / completeness checks beyond ZIP lookup (`shipping-verify-server.mjs`)
- [ ] **USPS Address API** — US-only verification via USPS Web Tools `USPS_USER_ID` (`shipping-verify-server.mjs`)
- [ ] **Address autocomplete** — Google Places / Mapbox on street field (`index.html`, `app.js`)
- [ ] **International shipping** — Expand beyond US/Canada if needed (`shipping-validation.js`)

## Ticket extraction (AI / OCR)

- [ ] **Production `OPENAI_API_KEY`** — Set on host (Railway, Fly, Render, etc.); never expose to browser (`server.mjs`)
- [ ] **Extract rate limiting** — Throttle `/api/extract` per IP/session (`server.mjs`)
- [ ] **Upload size limits** — Cap image payload size on server (`server.mjs`)

## Fulfillment

- [ ] **Print fulfillment partner** — API to submit verified address + stub PDF/HTML for mailed $2.99 orders (`server.mjs`)
- [ ] **Stub PDF generation** — Server-side PDF for fulfillment (Puppeteer / pdfkit) (`server.mjs`)

## Security & ops

- [ ] **HTTPS only** — Enforce TLS in production reverse proxy
- [ ] **CORS / CSRF** — Lock API origins when deployed
- [ ] **Secrets** — `.env` for all keys; document in `.env.example`
- [ ] **Logging & monitoring** — Structured logs + error tracking (Sentry)
- [ ] **CI** — GitHub Action: lint + validation unit tests

## Tests

- [ ] **Shipping validation tests** — Node test script for ZIP/email edge cases (`shipping-validation.js`)
- [ ] **E2E smoke test** — Upload → extract → checkout flow

## Legal & product

- [ ] **Terms / privacy** — Memorbilia disclaimer + data retention policy pages
- [ ] **Refund policy** — Linked from checkout modal
