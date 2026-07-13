#!/usr/bin/env node
/**
 * Smoke-test order persistence + confirmation email without Stripe.
 * Uses the same pending-order → paid flow as production (includes stub PNG).
 *
 *   node scripts/test-fulfillment.mjs
 *   node scripts/test-fulfillment.mjs --email you@example.com
 */
import "../load-env.mjs";
import { minStubPngBuffer } from "./png-fixture.mjs";
import {
  createPendingOrder,
  completePaidOrder,
  verifyOrderRecord,
  persistenceEnabled,
  emailEnabled,
  ownerEmailEnabled,
} from "../fulfillment.mjs";
import { expandTicketsForSeating } from "../public/templates.js";

const args = process.argv.slice(2);
const emailFlag = args.find((a) => a.startsWith("--email="));
const testEmail = emailFlag
  ? emailFlag.split("=")[1]
  : process.env.TEST_ORDER_EMAIL || "test@example.com";

const sessionId = `cs_test_${Date.now().toString(36)}`;
const stubPngBuffer = minStubPngBuffer();

const stubFields = {
  eventLine2: "COLDPLAY",
  tour: "VIVA LA VIDA TOUR",
  venue: "HP PAVILION AT SAN JOSE",
  datetime: "FRI JUL 18 2008 7:30 PM",
  section: "FLR 3",
  row: "14",
  seat: "1",
  orderCode: "404VSJA",
  barcode: "404VSJA",
  price: "180.00",
  promo: "WWW.LIVENATION.COM",
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

    const pendingCheck = await verifyOrderRecord(pending.orderId, { expectStatus: "pending" });
    if (!pendingCheck.ok) {
      console.error("❌ Pending order record incomplete:", pendingCheck.error);
      failed = true;
    } else {
      console.log("✅ Pending stub_fields saved:", Object.keys(pendingCheck.order.stubFields).join(", "));
      console.log("✅ Pending stub PNG in storage:", `${Math.round(pendingCheck.pngBytes / 1024)} KB`);
    }

    const paid = await completePaidOrder({
      orderId: pending.orderId,
      sessionId,
      email: testEmail,
      productKey: "mail",
      productName: "Printed ticket stub — mailed to you",
      cartJson: JSON.stringify([{ product: "mail", quantity: 1 }]),
      cartItems: [{ product: "mail", quantity: 1 }],
      amountTotal: 999,
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
      const verified = await verifyOrderRecord(pending.orderId, { expectStatus: "paid" });
      if (!verified.ok) {
        console.error("❌ Paid order record incomplete:", verified.error);
        failed = true;
      } else {
        console.log("✅ Paid order status:", verified.order.status);
        console.log("✅ Supabase stub_png_path:", verified.order.stubPngPath);
        console.log("✅ Extracted fields persisted:", {
          artist: verified.order.stubFields.eventLine2,
          venue: verified.order.stubFields.venue,
          section: verified.order.stubFields.section,
          row: verified.order.stubFields.row,
          seat: verified.order.stubFields.seat,
          orderCode: verified.order.stubFields.orderCode,
        });
        console.log("✅ Print PNG ready for fulfillment email:", `${Math.round(verified.pngBytes / 1024)} KB`);
      }
      if (emailEnabled && paid.created) {
        console.log("✅ Customer confirmation email sent to", testEmail);
      }
      if (ownerEmailEnabled && paid.created) {
        console.log(
          "✅ Owner alert sent with PNG attachment to",
          process.env.FULFILLMENT_EMAIL || process.env.ORDER_FROM_EMAIL,
        );
      }
    }
  }

  // Multi-seat order: one PNG + field set per ticket.
  const multiVariants = expandTicketsForSeating(stubFields, [
    { section: "FLR2", row: "4", seat: "15" },
    { section: "FLR2", row: "4", seat: "16" },
  ]);
  const multiPending = await createPendingOrder({
    cartItems: [{ product: "mail", quantity: 1 }],
    cartJson: JSON.stringify([{ product: "mail", quantity: 1 }]),
    productKey: "mail",
    productName: "Printed ticket stub — mailed to you",
    stubFields,
    stubTickets: multiVariants.map((variant) => ({
      stubFields: variant,
      stubPngBuffer: minStubPngBuffer(),
    })),
  });
  if (multiPending.error) {
    console.error("❌ Multi-seat pending order failed:", multiPending.error);
    failed = true;
  } else {
    const multiCheck = await verifyOrderRecord(multiPending.orderId, {
      expectStatus: "pending",
      expectTicketCount: 2,
    });
    if (!multiCheck.ok) {
      console.error("❌ Multi-seat pending record incomplete:", multiCheck.error);
      failed = true;
    } else {
      console.log("✅ Multi-seat pending order:", multiPending.orderId, "(2 tickets)");
      const seats = multiCheck.order.stubTickets.map((t) => t.seat).join(", ");
      console.log("✅ Per-seat PNGs stored for seats:", seats);
    }
  }
} else if (emailEnabled || ownerEmailEnabled) {
  console.log("⏭  Skipping Supabase (not configured) — emails require a pending order with PNG");
}

console.log();
if (failed) process.exit(1);
console.log("Done. Check Supabase → orders (stub_fields, stub_tickets, stub_png_path) + Storage → order-stubs, and your inbox.");
