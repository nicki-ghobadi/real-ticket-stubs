#!/usr/bin/env node
/**
 * Production smoke tests (no browser required).
 *
 *   node scripts/smoke-test.mjs
 *   node scripts/smoke-test.mjs --base http://localhost:3456
 */
import "../load-env.mjs";
import { normalizeExtractedFields, prepareTicketData } from "../templates.js";
import { validateShippingFormat } from "../shipping-validation.js";

const base = (process.argv.find((a) => a.startsWith("--base="))?.split("=")[1]
  || "http://localhost:3456").replace(/\/$/, "");

let passed = 0;
let failed = 0;
let warned = 0;

function ok(name) {
  passed++;
  console.log(`✅ ${name}`);
}

function fail(name, detail) {
  failed++;
  console.error(`❌ ${name}${detail ? `: ${detail}` : ""}`);
}

function warn(name, detail) {
  warned++;
  console.warn(`⚠️  ${name}${detail ? `: ${detail}` : ""}`);
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { res, text, json };
}

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

console.log("Real Ticket Stubs — smoke test\n");
console.log("  Base URL:", base);
console.log();

// ── Unit checks ──
const normalized = normalizeExtractedFields({
  section: "117",
  row: "14",
  seat: "1",
  eventLine2: "COLDPLAY",
});
if (normalized.section === "117" && normalized.row === "14") ok("normalizeExtractedFields");
else fail("normalizeExtractedFields", JSON.stringify(normalized));

const ticket = prepareTicketData({ section: "117", row: "14", seat: "1", eventLine2: "TEST" });
if (ticket.barcode && /^\d{10,}$/.test(ticket.barcode)) ok("prepareTicketData barcode fallback");
else fail("prepareTicketData barcode fallback", ticket.barcode);

const ship = validateShippingFormat({
  name: "Jane Doe",
  email: "jane@example.com",
  emailConfirm: "jane@example.com",
  street1: "123 Main St",
  city: "San Jose",
  state: "CA",
  zip: "95110",
  country: "United States",
});
if (ship.valid) ok("validateShippingFormat (US address)");
else fail("validateShippingFormat", JSON.stringify(ship.errors));

// ── HTTP checks ──
try {
  const health = await get("/healthz");
  if (health.res.status === 200 && health.json?.status === "ok") ok("/healthz");
  else fail("/healthz", `status ${health.res.status}`);

  const home = await get("/");
  if (home.res.status === 200 && home.text.includes("Extract details")) ok("GET / (index.html)");
  else fail("GET /", `status ${home.res.status}`);

  for (const page of ["/terms.html", "/privacy.html", "/refunds.html"]) {
    const p = await get(page);
    if (p.res.status === 200) ok(`GET ${page}`);
    else fail(`GET ${page}`, `status ${p.res.status}`);
  }

  const blocked = await get("/server.mjs");
  if (blocked.res.status === 404) ok("server.mjs not exposed");
  else fail("server.mjs not exposed", `got ${blocked.res.status}`);

  const config = await get("/api/config");
  if (config.res.status === 200 && config.json?.hasPaymentLinks !== undefined) ok("/api/config");
  else fail("/api/config");

  const checkout = await post("/api/create-checkout-session", {
    cart: [{ product: "mail", quantity: 1 }],
    item: { artist: "SMOKE", venue: "Arena", datetime: "FRI JUN 8 2026 8:00 PM" },
  });
  if (checkout.res.status === 200 && checkout.json?.url?.includes("checkout.stripe.com")) {
    ok("POST /api/create-checkout-session");
    if (checkout.json.url.includes("cs_live_")) {
      warn("Stripe mode", "LIVE checkout sessions — use test keys for safe dev checkout");
    }
  } else if (checkout.res.status === 200 && checkout.json?.mock) {
    ok("POST /api/create-checkout-session (mock mode)");
  } else {
    fail("POST /api/create-checkout-session", JSON.stringify(checkout.json));
  }

  const csp = home.res.headers.get("content-security-policy");
  if (csp && csp.includes("default-src")) ok("CSP header present");
  else warn("CSP header", "missing on HTML response");
} catch (e) {
  fail("HTTP smoke tests", e.message);
}

// ── Env readiness (names only, no secrets) ──
console.log("\nProduction env checklist:");
const checklist = [
  ["ANTHROPIC_API_KEY", true],
  ["STRIPE_SECRET_KEY", true],
  ["STRIPE_WEBHOOK_SECRET", true],
  ["SUPABASE_URL", true],
  ["SUPABASE_SERVICE_ROLE_KEY", true],
  ["GOOGLE_ADDRESS_VALIDATION_API_KEY", false],
  ["RESEND_API_KEY", true],
  ["ORDER_FROM_EMAIL", true],
  ["NODE_ENV=production", false],
];
for (const [key, required] of checklist) {
  if (key === "NODE_ENV=production") {
    if (process.env.NODE_ENV === "production") ok("env NODE_ENV=production");
    else warn("env NODE_ENV", "still development — set production on host");
    continue;
  }
  const val = (process.env[key] || "").trim();
  if (!val) {
    if (required) warn(`env ${key}`, "not set");
    else console.log(`   ${key}: optional, not set`);
  } else if (key === "SUPABASE_SERVICE_ROLE_KEY" && val.startsWith("sb_publishable")) {
    warn(`env ${key}`, "looks like a publishable key — use the service_role JWT from Supabase");
  } else if (key === "STRIPE_SECRET_KEY" && val.startsWith("sk_test")) {
    warn(`env ${key}`, "test mode — switch to sk_live_ before go-live");
  } else {
    ok(`env ${key} set`);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${warned} warnings`);
if (failed) process.exit(1);
console.log("\nDone. For fulfillment: npm run test:fulfillment -- --email=you@example.com");
