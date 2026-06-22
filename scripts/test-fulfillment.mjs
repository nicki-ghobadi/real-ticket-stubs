#!/usr/bin/env node
/**
 * Smoke-test order persistence + confirmation email without Stripe.
 *
 * Usage (from project root):
 *   node scripts/test-fulfillment.mjs
 *   node scripts/test-fulfillment.mjs --email you@example.com
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for DB test.
 * Requires RESEND_API_KEY + ORDER_FROM_EMAIL for email test.
 * Loads .env from the project root automatically.
 */
import "../load-env.mjs";
import {
  saveOrder,
  sendOrderConfirmation,
  sendOwnerNotification,
  persistenceEnabled,
  emailEnabled,
  ownerEmailEnabled,
} from "../fulfillment.mjs";

const args = process.argv.slice(2);
const emailFlag = args.find((a) => a.startsWith("--email="));
const testEmail = emailFlag
  ? emailFlag.split("=")[1]
  : process.env.TEST_ORDER_EMAIL || "test@example.com";

const sessionId = `cs_test_${Date.now().toString(36)}`;

const sampleOrder = {
  sessionId,
  email: testEmail,
  productKey: "mail",
  productName: "Printed ticket stub — mailed to you",
  amountTotal: 399,
  currency: "usd",
  shipping: {
    name: "Test Customer",
    line1: "123 Main St",
    line2: "",
    city: "San Jose",
    state: "CA",
    postalCode: "95110",
    country: "US",
  },
  stubFields: {
    eventLine2: "COLDPLAY",
    venue: "HP PAVILION AT SAN JOSE",
    datetime: "FRI JUL 18 2008 7:30 PM",
    section: "117",
    row: "14",
    seat: "1",
    barcode: "6540422223612",
  },
  addressStatus: "unknown",
};

console.log("Real Ticket Stubs — fulfillment smoke test\n");
console.log("  Persistence:", persistenceEnabled ? "configured" : "OFF (set SUPABASE_* in .env)");
console.log("  Email:      ", emailEnabled ? "configured" : "OFF (set RESEND_* in .env)");
console.log("  Owner alert:", ownerEmailEnabled ? "configured" : "OFF (set FULFILLMENT_EMAIL in .env)");
console.log("  Test email: ", testEmail);
console.log("  Session id: ", sessionId);
console.log();

if (!persistenceEnabled && !emailEnabled && !ownerEmailEnabled) {
  console.error("Nothing to test. Add Supabase and/or Resend keys to .env first.");
  process.exit(1);
}

let failed = false;

if (persistenceEnabled) {
  const stored = await saveOrder(sampleOrder);
  if (stored.error) {
    console.error("❌ Supabase write failed:", stored.error);
    failed = true;
  } else if (stored.created) {
    console.log("✅ Supabase: order row created", stored.id ? `(id ${stored.id})` : "");
  } else {
    console.log("↩️  Supabase: duplicate session (unexpected on fresh test id)");
  }
} else {
  console.log("⏭  Skipping Supabase (not configured)");
}

if (emailEnabled) {
  const mail = await sendOrderConfirmation(sampleOrder);
  if (mail.error) {
    console.error("❌ Resend failed:", mail.error);
    failed = true;
  } else if (mail.sent) {
    console.log("✅ Resend: confirmation email sent to", testEmail);
  } else {
    console.log("⏭  Resend: skipped (no email on order)");
  }
} else {
  console.log("⏭  Skipping Resend customer email (not configured)");
}

if (ownerEmailEnabled) {
  const owner = await sendOwnerNotification(sampleOrder);
  if (owner.error) {
    console.error("❌ Owner alert failed:", owner.error);
    failed = true;
  } else if (owner.sent) {
    console.log("✅ Resend: owner alert sent to", process.env.FULFILLMENT_EMAIL || process.env.ORDER_FROM_EMAIL);
  }
} else {
  console.log("⏭  Skipping owner alert (set FULFILLMENT_EMAIL)");
}

console.log();
if (failed) process.exit(1);
console.log("Done. Check Supabase Table Editor → orders and your inbox.");
