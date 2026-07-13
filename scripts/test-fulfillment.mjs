#!/usr/bin/env node
/**
 * Smoke-test order persistence + confirmation email without Stripe.
 * Renders real ticket PNGs (same as checkout) before uploading to Supabase.
 *
 *   node scripts/test-fulfillment.mjs
 *   node scripts/test-fulfillment.mjs --email you@example.com
 *   node scripts/test-fulfillment.mjs --email you@example.com --base=http://localhost:3456
 */
import "../load-env.mjs";
import { renderStubPngBuffers } from "./render-stub-png.mjs";
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
const base =
  args.find((a) => a.startsWith("--base="))?.split("=")[1]?.replace(/\/$/, "")
  || "http://localhost:3456";
const testEmail = emailFlag
  ? emailFlag.split("=")[1]
  : process.env.TEST_ORDER_EMAIL || "test@example.com";

const sessionId = `cs_test_${Date.now().toString(36)}`;

const stubFields = {
  ticketCode: "SJ0718",
  headerRight: "ESJ0718",
  eventLine2: "COLDPLAY",
  tour: "VIVA LA VIDA TOUR",
  venue: "HP PAVILION AT SAN JOSE",
  datetime: "FRI JUL 18 2008 7:30 PM",
  disclaimer: "NO CAMERAS OR RECORDERS",
  section: "FLR 3",
  row: "14",
  seat: "1",
  orderCode: "404VSJA",
  barcode: "404VSJA",
  price: "180.00",
  promo: "WWW.LIVENATION.COM",
  admissionType: "VAUCTN",
  aisle: "AISLE 26",
  eventNum: "1046555",
  cn: "CN 17258",
  auxLeft: "CA  6X",
  auxRight: "CA404SJA",
  dateShort: "18JUL08",
};

console.log("Real Ticket Stubs — fulfillment smoke test\n");
console.log("  Base URL:   ", base);
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
let stubPngBuffer;

try {
  console.log("Rendering print-ready ticket PNG (headless browser)…");
  [stubPngBuffer] = await renderStubPngBuffers(stubFields, { base });
  console.log(`✅ Rendered ticket PNG (${Math.round(stubPngBuffer.length / 1024)} KB)\n`);
} catch (e) {
  console.error("❌ Could not render ticket PNG:", e.message);
  console.error("   Start the dev server: npm start");
  process.exit(1);
}

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
      if (pendingCheck.pngBytes < 50_000) {
        console.error("❌ PNG in storage looks too small to be a rendered ticket");
        failed = true;
      }
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
        console.log("✅ stub_tickets in Supabase:", verified.order.stubTickets.length, "entry/entries");
        for (const t of verified.order.stubTickets) {
          console.log(
            `   · seat ${t.seat || "—"} → ${t.stub_png_path} (${Object.keys(t.stub_fields || {}).length} fields)`,
          );
        }
        console.log("\n📋 Supabase — open Table Editor → orders, row id:", pending.orderId);
        console.log("   Storage → order-stubs →", pending.orderId, "→ stub.png");
      }
      if (emailEnabled && paid.created) {
        console.log("✅ Customer confirmation email sent to", testEmail);
      }
      if (ownerEmailEnabled && paid.created) {
        console.log(
          "✅ Owner alert sent with rendered ticket PNG to",
          process.env.FULFILLMENT_EMAIL || process.env.ORDER_FROM_EMAIL,
        );
      }
    }
  }

  const multiVariants = expandTicketsForSeating(stubFields, [
    { section: "FLR2", row: "4", seat: "15" },
    { section: "FLR2", row: "4", seat: "16" },
  ]);
  let multiBuffers;
  try {
    console.log("\nRendering multi-seat ticket PNGs…");
    multiBuffers = await renderStubPngBuffers(multiVariants, { base });
    console.log(
      `✅ Rendered ${multiBuffers.length} ticket PNGs (${multiBuffers.map((b) => `${Math.round(b.length / 1024)} KB`).join(", ")})`,
    );
  } catch (e) {
    console.error("❌ Multi-seat PNG render failed:", e.message);
    failed = true;
    multiBuffers = null;
  }

  if (multiBuffers) {
    const multiPending = await createPendingOrder({
      cartItems: [{ product: "mail", quantity: 1 }],
      cartJson: JSON.stringify([{ product: "mail", quantity: 1 }]),
      productKey: "mail",
      productName: "Printed ticket stub — mailed to you",
      stubFields,
      stubTickets: multiVariants.map((variant, i) => ({
        stubFields: variant,
        stubPngBuffer: multiBuffers[i],
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
        for (const t of multiCheck.order.stubTickets) {
          console.log(
            `   · seat ${t.seat} sec ${t.section} row ${t.row} → ${t.stub_png_path}`,
          );
        }

        const multiPaid = await completePaidOrder({
          orderId: multiPending.orderId,
          sessionId: `${sessionId}_multi`,
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
        if (multiPaid.error) {
          console.error("❌ Multi-seat completePaidOrder failed:", multiPaid.error);
          failed = true;
        } else {
          const multiPaidCheck = await verifyOrderRecord(multiPending.orderId, {
            expectStatus: "paid",
            expectTicketCount: 2,
          });
          if (!multiPaidCheck.ok) {
            console.error("❌ Multi-seat paid record incomplete:", multiPaidCheck.error);
            failed = true;
          } else {
            console.log("✅ Multi-seat paid order in Supabase:", multiPending.orderId);
            console.log("   email:", multiPaidCheck.order.email);
            console.log("   stub_fields + stub_tickets + 2 PNGs — check Table Editor & Storage");
          }
        }
      }
    }
  }
} else if (emailEnabled || ownerEmailEnabled) {
  console.log("⏭  Skipping Supabase (not configured) — emails require a pending order with PNG");
}

console.log();
if (failed) process.exit(1);
console.log("Done. In Supabase dashboard:");
console.log("  • Table Editor → public.orders → stub_fields, stub_tickets, ticket_artist, shipping columns");
console.log("  • Storage → order-stubs → <order-id> → stub.png / stub-1.png …");
console.log("  • Or run: npm run test:inspect-orders");
