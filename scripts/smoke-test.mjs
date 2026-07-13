#!/usr/bin/env node
/**
 * Production smoke tests (no browser required).
 *
 *   node scripts/smoke-test.mjs
 *   node scripts/smoke-test.mjs --base http://localhost:3456
 */
import "../load-env.mjs";
import { minStubPngDataUrl } from "./png-fixture.mjs";
import { verifyOrderRecord, persistenceEnabled } from "../fulfillment.mjs";
import { normalizeExtractedFields, prepareTicketData, parseSeatList, expandTicketsForSeating, resolveSeatingSlots } from "../public/templates.js";
import { validateShippingFormat } from "../public/shipping-validation.js";

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

const multiNorm = normalizeExtractedFields({
  seating: [
    { section: "117", row: "14", seat: "1" },
    { section: "117", row: "14", seat: "2" },
  ],
});
if (Array.isArray(multiNorm.seating) && multiNorm.seating.length === 2) ok("normalizeExtractedFields seating array");
else fail("normalizeExtractedFields seating array", JSON.stringify(multiNorm.seating));

if (parseSeatList("1-4").join(",") === "1,2,3,4") ok("parseSeatList range");
else fail("parseSeatList range", parseSeatList("1-4"));

const multiTickets = expandTicketsForSeating(
  { section: "117", row: "14", seat: "1-3", eventLine2: "TEST" },
  resolveSeatingSlots({ section: "117", row: "14", seat: "1-3" }),
);
if (multiTickets.length === 3 && multiTickets[2].seat === "3") ok("expandTicketsForSeating");
else fail("expandTicketsForSeating", JSON.stringify(multiTickets.map((t) => t.seat)));

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

  for (const asset of ["/favicon.svg", "/og-image.jpg", "/apple-touch-icon.png"]) {
    const a = await get(asset);
    if (a.res.status === 200) ok(`GET ${asset}`);
    else fail(`GET ${asset}`, `status ${a.res.status}`);
  }

  const blocked = await get("/server.mjs");
  if (blocked.res.status === 404) ok("server.mjs not exposed");
  else fail("server.mjs not exposed", `got ${blocked.res.status}`);

  const config = await get("/api/config");
  if (config.res.status === 200 && config.json?.hasPaymentLinks !== undefined) ok("/api/config");
  else fail("/api/config");

  const checkout = await post("/api/create-checkout-session", {
    cart: [{ product: "mail", quantity: 1 }],
    stubFields: {
      eventLine2: "SMOKE TEST",
      venue: "Arena",
      datetime: "FRI JUN 8 2026 8:00 PM",
      section: "FLR2",
      row: "4",
      seat: "15",
    },
    stubTickets: [
      {
        stubFields: {
          eventLine2: "SMOKE TEST",
          venue: "Arena",
          datetime: "FRI JUN 8 2026 8:00 PM",
          section: "FLR2",
          row: "4",
          seat: "15",
        },
        stubPng: minStubPngDataUrl(),
      },
      {
        stubFields: {
          eventLine2: "SMOKE TEST",
          venue: "Arena",
          datetime: "FRI JUN 8 2026 8:00 PM",
          section: "FLR2",
          row: "4",
          seat: "16",
        },
        stubPng: minStubPngDataUrl(),
      },
    ],
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

  if (checkout.res.status === 200 && checkout.json?.orderId && persistenceEnabled) {
    const expectStatus = checkout.json.mock ? "paid" : "pending";
    const verified = await verifyOrderRecord(checkout.json.orderId, {
      expectStatus,
      expectTicketCount: 2,
    });
    if (verified.ok) {
      ok(`Order saved to Supabase (${expectStatus}, 2 stub PNGs + fields)`);
    } else {
      fail("Order Supabase record", verified.error);
    }
  } else if (checkout.res.status === 200 && persistenceEnabled && !checkout.json?.orderId) {
    fail("Order Supabase record", "checkout succeeded but orderId missing");
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
