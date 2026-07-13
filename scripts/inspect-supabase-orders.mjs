#!/usr/bin/env node
/**
 * List recent orders in Supabase with stub fields, tickets, and storage PNGs.
 *
 *   node scripts/inspect-supabase-orders.mjs
 *   node scripts/inspect-supabase-orders.mjs --id=<order-uuid>
 */
import "../load-env.mjs";
import { getOrderById, verifyOrderRecord, persistenceEnabled } from "../fulfillment.mjs";

const args = process.argv.slice(2);
const idFlag = args.find((a) => a.startsWith("--id="));
const orderId = idFlag?.split("=")[1];

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function listRecentOrders(limit = 5) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/orders?select=*&order=created_at.desc&limit=${limit}`,
    { headers: supabaseHeaders() },
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listStorageFiles(orderId) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/order-stubs`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefix: `${orderId}/`, limit: 20 }),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

function printOrderSummary(row) {
  const tickets = Array.isArray(row.stub_tickets) ? row.stub_tickets : [];
  const fields = row.stub_fields && typeof row.stub_fields === "object" ? row.stub_fields : {};
  console.log("─".repeat(60));
  console.log(`Order ${row.id}`);
  console.log(`  status:      ${row.status}`);
  console.log(`  created:     ${row.created_at}`);
  console.log(`  email:       ${row.email || "(empty — pending checkout)"}`);
  console.log(`  product:     ${row.product_key} — ${row.product_name}`);
  console.log(`  artist:      ${row.ticket_artist || fields.eventLine2 || "—"}`);
  console.log(`  venue:       ${row.ticket_venue || fields.venue || "—"}`);
  console.log(`  datetime:    ${row.ticket_datetime || fields.datetime || "—"}`);
  console.log(`  shipping:    ${[row.ship_name, row.ship_line1, row.ship_city, row.ship_state, row.ship_postal_code].filter(Boolean).join(", ") || "—"}`);
  console.log(`  stub_png:    ${row.stub_png_path || "(none)"}`);
  console.log(`  stub_fields: ${Object.keys(fields).length} keys`);
  for (const key of ["eventLine2", "venue", "section", "row", "seat", "orderCode", "datetime"]) {
    if (fields[key]) console.log(`    ${key}: ${fields[key]}`);
  }
  console.log(`  stub_tickets: ${tickets.length} ticket(s)`);
  for (const t of tickets) {
    const tf = t.stub_fields || {};
    console.log(
      `    #${t.index || "?"} seat ${t.seat || "—"} row ${t.row || "—"} sec ${t.section || "—"} → ${t.stub_png_path || "(no png)"}`,
    );
    if (tf.seat && tf.seat !== t.seat) console.log(`      stub_fields.seat: ${tf.seat}`);
  }
}

async function main() {
  console.log("Supabase order inspector\n");
  if (!persistenceEnabled) {
    console.error("❌ SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(1);
  }

  const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] || "your-project";
  console.log(`Project: ${projectRef}`);
  console.log(`Dashboard → Table Editor → public.orders`);
  console.log(`Dashboard → Storage → order-stubs → <order-id>/\n`);

  if (orderId) {
    const order = await getOrderById(orderId);
    if (!order) {
      console.error(`❌ Order not found: ${orderId}`);
      process.exit(1);
    }
    printOrderSummary({
      id: order.id,
      status: order.status,
      created_at: "(see dashboard)",
      email: order.email,
      product_key: order.productKey,
      product_name: order.productName,
      ticket_artist: order.ticket?.artist,
      ticket_venue: order.ticket?.venue,
      ticket_datetime: order.ticket?.datetime,
      ship_name: order.shipping?.name,
      ship_line1: order.shipping?.line1,
      ship_city: order.shipping?.city,
      ship_state: order.shipping?.state,
      ship_postal_code: order.shipping?.postalCode,
      stub_png_path: order.stubPngPath,
      stub_fields: order.stubFields,
      stub_tickets: order.stubTickets,
    });
    const files = await listStorageFiles(orderId);
    console.log(`  storage:     ${files.length} PNG(s) in order-stubs/${orderId}/`);
    for (const f of files) {
      const kb = f.metadata?.size ? Math.round(f.metadata.size / 1024) : "?";
      console.log(`    ${f.name} (${kb} KB)`);
    }
    const verified = await verifyOrderRecord(orderId, { expectStatus: order.status });
    console.log(verified.ok ? "\n✅ Record complete (fields + PNGs verified)" : `\n❌ Issues: ${verified.error}`);
    return;
  }

  const rows = await listRecentOrders(5);
  if (!rows.length) {
    console.log("No orders found. Run: npm run test:fulfillment -- --email=you@example.com");
    return;
  }
  for (const row of rows) {
    printOrderSummary(row);
    const files = await listStorageFiles(row.id);
    console.log(`  storage:     ${files.length} PNG(s) under order-stubs/${row.id}/`);
  }
  console.log("\nTip: node scripts/inspect-supabase-orders.mjs --id=<uuid> for full verification");
}

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
