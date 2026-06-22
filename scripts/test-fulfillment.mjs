#!/usr/bin/env node
/**
 * Smoke-test order persistence + confirmation email without Stripe.
 * Uses the same pending-order → paid flow as production (includes stub PNG).
 *
 *   node scripts/test-fulfillment.mjs
 *   node scripts/test-fulfillment.mjs --email you@example.com
 */
import "../load-env.mjs";
import {
  createPendingOrder,
  completePaidOrder,
  getOrderById,
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

/** Minimal valid PNG (70 bytes) — exercises storage + email attachment pipeline. */
const stubPngBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAD0lEQVQI12P4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const stubFields = {
  eventLine2: "COLDPLAY",
  venue: "HP PAVILION AT SAN JOSE",
  datetime: "FRI JUL 18 2008 7:30 PM",
  section: "117",
  row: "14",
  seat: "1",
  barcode: "6540422223612",
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
  const pending = await createPendingOrder({
    cartItems: [{ product: "mail", quantity: 1 }],
    cartJson: JSON.stringify([{ product: "mail", quantity: 1 }]),
    productKey: "mail",
    productName: "Printed ticket stub — mailed to you",
    stubFields,
    stubPngBuffer,
  });
  if (pending.error) {
    console.error("❌ Pending order / PNG upload failed:", pending.error);
    failed = true;
  } else {
    console.log("✅ Pending order created with stub PNG:", pending.orderId);

    const paid = await completePaidOrder({
      orderId: pending.orderId,
      sessionId,
      email: testEmail,
      productKey: "mail",
      productName: "Printed ticket stub — mailed to you",
      cartJson: JSON.stringify([{ product: "mail", quantity: 1 }]),
      cartItems: [{ product: "mail", quantity: 1 }],
      amountTotal: 399,
      currency: "usd",
      shipping: {
        name: "Test Customer",
        line1: "123 Main St",
        city: "San Jose",
        state: "CA",
        postalCode: "95110",
        country: "US",
      },
      addressStatus: "unknown",
    });

    if (paid.error) {
      console.error("❌ completePaidOrder failed:", paid.error);
      failed = true;
    } else {
      const row = await getOrderById(pending.orderId);
      if (row?.stubPngPath) {
        console.log("✅ Supabase stub_png_path:", row.stubPngPath);
      } else {
        console.error("❌ Supabase stub_png_path is empty on paid order");
        failed = true;
      }
      if (emailEnabled && paid.created) {
        console.log("✅ Customer confirmation email sent to", testEmail);
      }
      if (ownerEmailEnabled && paid.created) {
        console.log("✅ Owner alert sent with PNG attachment to", process.env.FULFILLMENT_EMAIL || process.env.ORDER_FROM_EMAIL);
      }
    }
  }
} else if (emailEnabled || ownerEmailEnabled) {
  console.log("⏭  Skipping Supabase (not configured) — emails require a pending order with PNG");
}

console.log();
if (failed) process.exit(1);
console.log("Done. Check Supabase → orders (stub_png_path) + Storage → order-stubs, and your inbox.");
