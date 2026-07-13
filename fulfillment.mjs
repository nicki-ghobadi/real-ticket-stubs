/**
 * Order fulfillment: persist orders, store print PNGs, send notifications.
 *
 *   • Persistence  → Supabase  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *   • Storage      → Supabase bucket `order-stubs`
 *   • Email        → Resend    (RESEND_API_KEY + ORDER_FROM_EMAIL)
 *   • Owner alerts → FULFILLMENT_EMAIL (falls back to ORDER_FROM_EMAIL)
 */

import { TICKET_FIELD_KEYS } from "./public/templates.js";
import { MIN_STUB_PNG_BYTES, validateStubPngBuffer } from "./stub-png-validate.mjs";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ORDER_FROM_EMAIL = process.env.ORDER_FROM_EMAIL || "";
const FULFILLMENT_EMAIL = process.env.FULFILLMENT_EMAIL || ORDER_FROM_EMAIL || "";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || ORDER_FROM_EMAIL || "";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Real Ticket Stubs";
const STUB_BUCKET = "order-stubs";

export const persistenceEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
export const emailEnabled = !!(RESEND_API_KEY && ORDER_FROM_EMAIL);
export const ownerEmailEnabled = !!(RESEND_API_KEY && FULFILLMENT_EMAIL);

function isAllowedSupabaseUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /\.supabase\.co$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

/** Keep only known stub field keys with bounded string values. */
export function sanitizeStubFields(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const key of TICKET_FIELD_KEYS) {
    const v = raw[key];
    if (v != null && String(v).trim()) out[key] = String(v).trim().slice(0, 240);
  }
  return out;
}

export function formatMoney(cents, currency = "usd") {
  const n = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "usd").toUpperCase(),
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function confirmationCode(sessionId) {
  return String(sessionId || "")
    .replace(/^cs_(test_|live_)?/, "")
    .slice(0, 8)
    .toUpperCase() || "PENDING";
}

function oneLineAddress(s) {
  if (!s) return "";
  return [s.line1, s.line2, s.city, s.state, s.postalCode, s.country]
    .filter(Boolean)
    .join(", ");
}

function ticketSummary(stubFields = {}) {
  return {
    artist: stubFields.eventLine2 || "",
    venue: stubFields.venue || "",
    datetime: stubFields.datetime || "",
  };
}

function stubFieldsHtml(stubFields) {
  const rows = TICKET_FIELD_KEYS.filter((k) => stubFields[k])
    .map(
      (k) =>
        `<tr><td style="padding:4px 8px 4px 0;color:#777;vertical-align:top">${esc(k)}</td>` +
        `<td style="padding:4px 0;font-weight:500">${esc(stubFields[k])}</td></tr>`,
    )
    .join("");
  if (!rows) return "<p style='color:#777'>No stub fields recorded.</p>";
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>`;
}

function stubFieldsText(stubFields) {
  const lines = TICKET_FIELD_KEYS.filter((k) => stubFields[k]).map((k) => `${k}: ${stubFields[k]}`);
  return lines.length ? lines.join("\n") : "No stub fields recorded.";
}

const PRODUCT_LABELS = {
  mail: "Printed stub — mailed",
  framed: "Framed stub for the wall",
};
const PRODUCT_CENTS = { mail: 999, framed: 3999 };

function cartLineItems(order) {
  return (order.cartItems || [])
    .filter((row) => row?.product && PRODUCT_LABELS[row.product])
    .map((row) => ({
      label: `${PRODUCT_LABELS[row.product]} × ${row.quantity}`,
      price: formatMoney((PRODUCT_CENTS[row.product] || 0) * row.quantity, order.currency),
    }));
}

async function uploadStubPng(orderId, pngBuffer, filename = "stub.png") {
  if (!persistenceEnabled || !isAllowedSupabaseUrl(SUPABASE_URL)) {
    return { path: "", error: "Storage not configured." };
  }
  if (!pngBuffer?.length) {
    return { path: "", error: "Empty stub PNG." };
  }
  const objectPath = `${orderId}/${filename}`;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STUB_BUCKET}/${objectPath}`, {
      method: "PUT",
      headers: supabaseHeaders({
        "Content-Type": "image/png",
        "x-upsert": "true",
        "Cache-Control": "3600",
      }),
      body: pngBuffer,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { path: "", error: `Storage upload ${res.status} ${txt.slice(0, 200)}` };
    }
    return { path: `${STUB_BUCKET}/${objectPath}`, bytes: pngBuffer.length };
  } catch (e) {
    const hint =
      e?.cause?.code === "ENOTFOUND" || /fetch failed/i.test(e.message)
        ? " (check SUPABASE_URL and network)"
        : "";
    return { path: "", error: `Storage upload failed: ${e.message}${hint}` };
  }
}

async function downloadStubPng(stubPngPath) {
  if (!stubPngPath || !persistenceEnabled) return null;
  const objectPath = stubPngPath.startsWith(`${STUB_BUCKET}/`)
    ? stubPngPath.slice(STUB_BUCKET.length + 1)
    : stubPngPath;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STUB_BUCKET}/${objectPath}`, {
      headers: supabaseHeaders(),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function createSignedStubUrl(stubPngPath, expiresIn = 86_400) {
  if (!stubPngPath || !persistenceEnabled) return null;
  const objectPath = stubPngPath.startsWith(`${STUB_BUCKET}/`)
    ? stubPngPath.slice(STUB_BUCKET.length + 1)
    : stubPngPath;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STUB_BUCKET}/${objectPath}`, {
      method: "POST",
      headers: supabaseHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    if (!data.signedURL) return null;
    return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
  } catch {
    return null;
  }
}

async function supabaseSelectOrders(filterQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filterQuery}&select=*&limit=1`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { error: `Supabase ${res.status} ${txt.slice(0, 160)}` };
  }
  const data = await res.json().catch(() => []);
  return { row: Array.isArray(data) && data.length ? data[0] : null };
}

function rowToOrder(row) {
  if (!row) return null;
  const stubFields = row.stub_fields && typeof row.stub_fields === "object" ? row.stub_fields : {};
  let cartItems = [];
  if (row.cart_json) {
    try {
      const parsed = JSON.parse(row.cart_json);
      if (Array.isArray(parsed)) cartItems = parsed;
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.id,
    sessionId: row.stripe_session_id || "",
    email: row.email || "",
    productKey: row.product_key || "",
    productName: row.product_name || "",
    cartJson: row.cart_json || "",
    cartItems,
    amountTotal: row.amount_total ?? null,
    currency: row.currency || "usd",
    shipping: {
      name: row.ship_name || "",
      line1: row.ship_line1 || "",
      line2: row.ship_line2 || "",
      city: row.ship_city || "",
      state: row.ship_state || "",
      postalCode: row.ship_postal_code || "",
      country: row.ship_country || "",
    },
    ticket: ticketSummary(stubFields),
    stubFields,
    stubPngPath: row.stub_png_path || "",
    stubTickets: Array.isArray(row.stub_tickets) ? row.stub_tickets : [],
    paymentIntent: row.stripe_payment_intent || "",
    addressStatus: row.address_status || "unknown",
    status: row.status || "pending",
    ownerNotifiedAt: row.owner_notified_at || null,
  };
}

/**
 * Create a pending order before Stripe checkout (captures stub + cart).
 * @returns {Promise<{orderId:string, persisted:boolean, ticketCount?:number, error?:string}>}
 */
export async function createPendingOrder({
  cartItems,
  cartJson,
  productKey,
  productName,
  stubFields,
  stubPngBuffer,
  stubTickets,
}) {
  const orderId = crypto.randomUUID();
  const sharedFields = sanitizeStubFields(stubFields);

  let ticketsInput = Array.isArray(stubTickets) ? stubTickets : [];
  if (!ticketsInput.length) {
    if (!stubPngBuffer?.length) {
      return { orderId, persisted: false, error: "Missing stub PNG for print fulfillment." };
    }
    ticketsInput = [{ stubFields: sharedFields, stubPngBuffer }];
  }

  if (!persistenceEnabled) {
    console.log("📝 [order] persistence off — pending order (not stored):", {
      orderId,
      product: productKey,
      tickets: ticketsInput.length,
      stub: sharedFields.eventLine2 || sharedFields.section || "(empty)",
    });
    return { orderId, persisted: false, ticketCount: ticketsInput.length };
  }

  if (!isAllowedSupabaseUrl(SUPABASE_URL)) {
    return { orderId, persisted: false, error: "Invalid SUPABASE_URL." };
  }

  const storedTickets = [];
  for (let i = 0; i < ticketsInput.length; i++) {
    const entry = ticketsInput[i] || {};
    const clean = sanitizeStubFields(entry.stubFields || sharedFields);
    const buffer = entry.stubPngBuffer;
    if (!buffer?.length) {
      return { orderId, persisted: false, error: `Missing stub PNG for ticket ${i + 1}.` };
    }
    const valid = validateStubPngBuffer(buffer, `Ticket ${i + 1}`);
    if (!valid.ok) {
      console.error("Invalid print PNG rejected:", valid.error);
      return { orderId, persisted: false, error: valid.error };
    }
    const filename = ticketsInput.length === 1 ? "stub.png" : `stub-${i + 1}.png`;
    const uploaded = await uploadStubPng(orderId, buffer, filename);
    if (uploaded.error) {
      console.error(`Stub PNG upload failed (ticket ${i + 1}):`, uploaded.error);
      return { orderId, persisted: false, error: uploaded.error };
    }
    storedTickets.push({
      index: i + 1,
      seat: clean.seat || "",
      row: clean.row || "",
      section: clean.section || "",
      stub_fields: clean,
      stub_png_path: uploaded.path,
    });
    console.log(
      `🖼  Stub PNG stored (ticket ${i + 1}/${ticketsInput.length}):`,
      uploaded.path,
      `(${Math.round((uploaded.bytes || 0) / 1024)} KB)`,
    );
  }

  const primary = storedTickets[0];
  const ticket = ticketSummary(primary?.stub_fields || sharedFields);
  const row = {
    id: orderId,
    status: "pending",
    stripe_session_id: null,
    email: "",
    product_key: productKey || "",
    product_name: productName || "",
    cart_json: cartJson || (cartItems?.length ? JSON.stringify(cartItems) : ""),
    stub_fields: sharedFields,
    stub_png_path: primary?.stub_png_path || "",
    stub_tickets: storedTickets,
    ticket_artist: ticket.artist,
    ticket_venue: ticket.venue,
    ticket_datetime: ticket.datetime,
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: supabaseHeaders({
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }),
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { orderId, persisted: false, error: `Supabase ${res.status} ${txt.slice(0, 160)}` };
    }
    console.log(
      "📝 Pending order created:",
      orderId,
      `(${storedTickets.length} ticket(s), ${Object.keys(sharedFields).length} shared fields)`,
    );
    return { orderId, persisted: true, ticketCount: storedTickets.length };
  } catch (e) {
    return { orderId, persisted: false, error: `Supabase request failed: ${e.message}` };
  }
}

/** Attach Stripe session id to pending order (after session.create). */
export async function linkStripeSession(orderId, sessionId) {
  if (!persistenceEnabled || !orderId || !sessionId) return { ok: false };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}&status=eq.pending`,
      {
        method: "PATCH",
        headers: supabaseHeaders({
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        }),
        body: JSON.stringify({ stripe_session_id: sessionId }),
      },
    );
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function getOrderById(orderId) {
  if (!persistenceEnabled || !orderId) return null;
  const { row, error } = await supabaseSelectOrders(`id=eq.${encodeURIComponent(orderId)}`);
  if (error) {
    console.warn("getOrderById:", error);
    return null;
  }
  return rowToOrder(row);
}

export async function getOrderByStripeSession(sessionId) {
  if (!persistenceEnabled || !sessionId) return null;
  const { row, error } = await supabaseSelectOrders(
    `stripe_session_id=eq.${encodeURIComponent(sessionId)}`,
  );
  if (error) {
    console.warn("getOrderByStripeSession:", error);
    return null;
  }
  return rowToOrder(row);
}

/** Normalize stored ticket entries for emails and verification. */
function orderTicketEntries(order) {
  if (Array.isArray(order?.stubTickets) && order.stubTickets.length) {
    return order.stubTickets;
  }
  if (order?.stubPngPath) {
    return [
      {
        index: 1,
        seat: order.stubFields?.seat || "",
        row: order.stubFields?.row || "",
        section: order.stubFields?.section || "",
        stub_fields: order.stubFields || {},
        stub_png_path: order.stubPngPath,
      },
    ];
  }
  return [];
}

/** Validate that an order row has the print PNG and extracted stub fields. */
export async function verifyOrderRecord(orderId, { expectStatus = "paid", expectTicketCount } = {}) {
  const order = await getOrderById(orderId);
  if (!order) return { ok: false, error: "Order not found", issues: ["order missing"] };

  const issues = [];
  if (expectStatus && order.status !== expectStatus) {
    issues.push(`status is ${order.status}, expected ${expectStatus}`);
  }

  const tickets = orderTicketEntries(order);
  if (!tickets.length) issues.push("no stub tickets on order");
  if (expectTicketCount && tickets.length !== expectTicketCount) {
    issues.push(`ticket count is ${tickets.length}, expected ${expectTicketCount}`);
  }
  if (!Object.keys(order.stubFields || {}).length) issues.push("stub_fields empty");

  let pngBytes = 0;
  for (const ticket of tickets) {
    const label = ticket.seat ? `seat ${ticket.seat}` : `ticket ${ticket.index || "?"}`;
    if (!ticket.stub_png_path) {
      issues.push(`${label}: missing stub_png_path`);
      continue;
    }
    const png = await downloadStubPng(ticket.stub_png_path);
    if (!png?.length) issues.push(`${label}: PNG missing from storage`);
    else {
      pngBytes += png.length;
      const valid = validateStubPngBuffer(png, label);
      if (!valid.ok) issues.push(valid.error);
    }
    const fields = ticket.stub_fields || {};
    if (!fields.seat && !fields.section && !fields.eventLine2) {
      issues.push(`${label}: stub_fields incomplete`);
    }
  }

  if (!order.ticket?.artist && !order.stubFields?.eventLine2) {
    issues.push("ticket artist / eventLine2 missing");
  }

  return {
    ok: issues.length === 0,
    order,
    issues,
    ticketCount: tickets.length,
    pngBytes,
    error: issues.length ? issues.join("; ") : undefined,
  };
}

/**
 * Mark order paid after Stripe webhook. Sends notifications on first completion.
 * @returns {Promise<{created:boolean, order?:object, error?:string}>}
 */
export async function completePaidOrder(orderInput) {
  const orderId = orderInput.orderId || orderInput.id;
  let existing = orderId ? await getOrderById(orderId) : null;
  if (!existing && orderInput.sessionId) {
    existing = await getOrderByStripeSession(orderInput.sessionId);
  }

  const stubFields = existing?.stubFields || sanitizeStubFields(orderInput.stubFields || {});
  let stubPngPath = existing?.stubPngPath || orderInput.stubPngPath || "";
  let stubTickets = existing?.stubTickets?.length
    ? existing.stubTickets
    : orderInput.stubTickets?.length
      ? orderInput.stubTickets
      : [];

  // Legacy/test path: upload PNG when completing without a pending order draft.
  if (!stubPngPath && orderInput.stubPngBuffer?.length && (orderId || existing?.id)) {
    const targetId = existing?.id || orderId;
    const uploaded = await uploadStubPng(targetId, orderInput.stubPngBuffer);
    if (uploaded.path) stubPngPath = uploaded.path;
    else if (uploaded.error) console.error("Stub PNG upload on complete failed:", uploaded.error);
  }

  const ticket = ticketSummary(stubFields);
  const order = {
    id: existing?.id || orderId,
    sessionId: orderInput.sessionId || existing?.sessionId || "",
    email: orderInput.email || existing?.email || "",
    productKey: orderInput.productKey || existing?.productKey || "",
    productName: orderInput.productName || existing?.productName || "",
    cartJson: orderInput.cartJson || existing?.cartJson || "",
    cartItems: orderInput.cartItems?.length ? orderInput.cartItems : existing?.cartItems || [],
    amountTotal: orderInput.amountTotal ?? existing?.amountTotal ?? null,
    currency: orderInput.currency || existing?.currency || "usd",
    shipping: orderInput.shipping || existing?.shipping,
    ticket: orderInput.ticket || ticket,
    stubFields,
    stubPngPath,
    stubTickets,
    paymentIntent: orderInput.paymentIntent || "",
    addressStatus: orderInput.addressStatus || "unknown",
  };

  if (existing?.status === "paid" && existing.ownerNotifiedAt) {
    console.log("↩️  Order already fulfilled:", existing.id);
    return { created: false, order };
  }

  const needsNotify = !existing?.ownerNotifiedAt;

  if (!persistenceEnabled) {
    console.log("📝 [order] persistence off — paid order logged:", {
      session: order.sessionId,
      email: order.email,
      product: order.productKey,
      amount: order.amountTotal,
    });
    if (needsNotify) await sendFulfillmentNotifications(order);
    return { created: needsNotify, order };
  }

  const row = {
    stripe_session_id: order.sessionId,
    email: order.email || "",
    product_key: order.productKey || "",
    product_name: order.productName || "",
    cart_json: order.cartJson || "",
    amount_total: order.amountTotal ?? null,
    currency: order.currency || "usd",
    ship_name: order.shipping?.name || "",
    ship_line1: order.shipping?.line1 || "",
    ship_line2: order.shipping?.line2 || "",
    ship_city: order.shipping?.city || "",
    ship_state: order.shipping?.state || "",
    ship_postal_code: order.shipping?.postalCode || "",
    ship_country: order.shipping?.country || "",
    ticket_artist: order.ticket?.artist || ticket.artist,
    ticket_venue: order.ticket?.venue || ticket.venue,
    ticket_datetime: order.ticket?.datetime || ticket.datetime,
    stub_fields: stubFields,
    stripe_payment_intent: order.paymentIntent || "",
    address_status: order.addressStatus || "unknown",
    status: "paid",
    ...(order.stubPngPath ? { stub_png_path: order.stubPngPath } : {}),
    ...(order.stubTickets?.length ? { stub_tickets: order.stubTickets } : {}),
  };

  try {
    if (existing?.id) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        headers: supabaseHeaders({
          "Content-Type": "application/json",
          Prefer: "return=representation",
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { created: false, error: `Supabase ${res.status} ${txt.slice(0, 160)}` };
      }
      const data = await res.json().catch(() => []);
      const updated = rowToOrder(Array.isArray(data) && data.length ? data[0] : { ...existing, ...row, id: existing.id });
      order.id = updated?.id || existing.id;
      order.stubPngPath = updated?.stubPngPath || existing.stubPngPath;
      order.stubTickets = updated?.stubTickets?.length ? updated.stubTickets : existing.stubTickets;
    } else {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
        method: "POST",
        headers: supabaseHeaders({
          "Content-Type": "application/json",
          Prefer: "return=representation,resolution=ignore-duplicates",
        }),
        body: JSON.stringify({
          ...row,
          stub_png_path: order.stubPngPath || "",
          stub_tickets: order.stubTickets || [],
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { created: false, error: `Supabase ${res.status} ${txt.slice(0, 160)}` };
      }
      const data = await res.json().catch(() => []);
      const created = Array.isArray(data) && data.length > 0;
      if (created) {
        order.id = data[0].id;
        order.stubPngPath = data[0].stub_png_path || "";
        order.stubTickets = Array.isArray(data[0].stub_tickets) ? data[0].stub_tickets : [];
      }
      if (!created) return { created: false, order };
    }
  } catch (e) {
    return { created: false, error: `Supabase request failed: ${e.message}` };
  }

  if (needsNotify) {
    console.log("📦 Paid order ready for print:", {
      orderId: order.id,
      email: order.email,
      ticketCount: orderTicketEntries(order).length,
      stubPngPath: order.stubPngPath,
      fieldCount: Object.keys(order.stubFields || {}).length,
    });
    const notify = await sendFulfillmentNotifications(order);
    if (notify.ownerSent) await markOwnerNotified(order.id);
  }

  return { created: needsNotify, order };
}

async function markOwnerNotified(orderId) {
  if (!persistenceEnabled || !orderId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      headers: supabaseHeaders({
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify({ owner_notified_at: new Date().toISOString() }),
    });
  } catch {
    /* best-effort */
  }
}

/** @deprecated Use completePaidOrder — kept for test script compatibility. */
export async function saveOrder(order) {
  const result = await completePaidOrder(order);
  return {
    persisted: persistenceEnabled && !result.error,
    created: result.created,
    id: result.order?.id,
    error: result.error,
  };
}

function buildCustomerEmail(order) {
  const code = confirmationCode(order.sessionId);
  const amount = formatMoney(order.amountTotal, order.currency);
  const addr = oneLineAddress(order.shipping);
  const support = SUPPORT_EMAIL ? `<a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>` : "us";
  const supportText = SUPPORT_EMAIL || "support";

  const cartLines = cartLineItems(order);
  const itemRows = cartLines.length
    ? cartLines
        .map(
          (line) =>
            `<tr><td style="padding:6px 0;color:#777">${esc(line.label)}</td><td style="padding:6px 0;text-align:right">${esc(line.price)}</td></tr>`,
        )
        .join("")
    : `<tr><td style="padding:6px 0;color:#777">Item</td><td style="padding:6px 0;text-align:right">${esc(order.productName || "Ticket stub")}</td></tr>`;

  const textLines = cartLines.length
    ? cartLines.map((line) => `${line.label}: ${line.price}`)
    : [`Item: ${order.productName || "Ticket stub"}`];

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
    <h1 style="font-size:20px;margin:0 0 4px">Thanks for your order!</h1>
    <p style="margin:0 0 16px;color:#555">${esc(BUSINESS_NAME)} received your payment and your printed stub is being prepared.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:6px 0;color:#777">Confirmation #</td><td style="padding:6px 0;text-align:right;font-weight:600">${esc(code)}</td></tr>
      ${itemRows}
      <tr><td style="padding:6px 0;color:#777">Amount paid</td><td style="padding:6px 0;text-align:right;font-weight:600">${esc(amount)}</td></tr>
      ${addr ? `<tr><td style="padding:6px 0;color:#777">Shipping to</td><td style="padding:6px 0;text-align:right">${esc(addr)}</td></tr>` : ""}
    </table>
    <p style="margin:18px 0 0;color:#555">We'll email you again when it ships (typically 3–5 business days). Questions? Reach ${support}.</p>
    <p style="margin:18px 0 0;font-size:12px;color:#999">${esc(BUSINESS_NAME)} — for personal memorabilia only. Not affiliated with Ticketmaster or Live Nation.</p>
  </body></html>`;

  const text = [
    `Thanks for your order!`,
    `${BUSINESS_NAME} received your payment and your printed stub is being prepared.`,
    ``,
    `Confirmation #: ${code}`,
    ...textLines,
    `Amount paid: ${amount}`,
    addr ? `Shipping to: ${addr}` : "",
    ``,
    `We'll email you again when it ships (typically 3-5 business days).`,
    SUPPORT_EMAIL ? `Questions? ${supportText}` : "",
  ].filter(Boolean).join("\n");

  return { subject: `Order confirmed — ${code}`, html, text };
}

async function buildOwnerEmail(order) {
  const code = confirmationCode(order.sessionId);
  const amount = formatMoney(order.amountTotal, order.currency);
  const addr = oneLineAddress(order.shipping);
  const cartLines = cartLineItems(order);
  const itemsText = cartLines.length
    ? cartLines.map((l) => `${l.label} — ${l.price}`).join("\n")
    : order.productName || "Ticket stub";

  const tickets = orderTicketEntries(order);
  const stubBlocks = [];
  const stubTextLines = [];
  for (const ticket of tickets) {
    const seatLabel = [ticket.section, ticket.row, ticket.seat].filter(Boolean).join(" / ") || `Ticket ${ticket.index || 1}`;
    const stubUrl = ticket.stub_png_path ? await createSignedStubUrl(ticket.stub_png_path) : null;
    if (stubUrl) {
      stubBlocks.push(
        `<h3 style="font-size:14px;margin:18px 0 8px">Print stub — ${esc(seatLabel)}</h3>` +
          `<p style="margin:8px 0"><a href="${esc(stubUrl)}" style="color:#0066cc">Download PNG (24h link)</a></p>` +
          `<p style="margin:8px 0"><img src="${esc(stubUrl)}" alt="Stub ${esc(seatLabel)}" style="max-width:100%;border:1px solid #ddd" /></p>` +
          stubFieldsHtml(ticket.stub_fields || {}),
      );
      stubTextLines.push(`Print PNG (${seatLabel}): ${stubUrl}`);
      stubTextLines.push(stubFieldsText(ticket.stub_fields || {}));
    }
  }
  const stubLink = stubBlocks.length
    ? stubBlocks.join("")
    : `<p style="margin:12px 0;color:#c00">Print PNG missing — check Supabase Storage (order-stubs bucket).</p>`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;line-height:1.5;max-width:640px;margin:0 auto;padding:24px">
    <h1 style="font-size:20px;margin:0 0 4px">New order — ${esc(code)}</h1>
    <p style="margin:0 0 16px;color:#555">A customer paid. Print and ship ${tickets.length > 1 ? `all ${tickets.length} stubs` : "the stub"} below.</p>
    <h2 style="font-size:15px;margin:20px 0 8px">Customer</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:4px 8px 4px 0;color:#777">Email</td><td>${esc(order.email)}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Ship to</td><td>${esc(addr || "—")}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Items</td><td>${esc(itemsText.replace(/\n/g, ", "))}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Tickets</td><td>${esc(String(tickets.length || 1))}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Paid</td><td><strong>${esc(amount)}</strong></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Stripe session</td><td style="font-size:12px">${esc(order.sessionId)}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Address check</td><td>${esc(order.addressStatus || "unknown")}</td></tr>
    </table>
    ${stubLink}
    <h2 style="font-size:15px;margin:20px 0 8px">Shared event fields</h2>
    ${stubFieldsHtml(order.stubFields || {})}
    <p style="margin:18px 0 0;font-size:12px;color:#999">Stub PNGs attached when available.</p>
  </body></html>`;

  const text = [
    `New order — ${code}`,
    ``,
    `Email: ${order.email}`,
    `Ship to: ${addr || "—"}`,
    `Items:\n${itemsText}`,
    `Tickets: ${tickets.length || 1}`,
    `Paid: ${amount}`,
    `Stripe: ${order.sessionId}`,
    `Address status: ${order.addressStatus || "unknown"}`,
    ...stubTextLines,
    ``,
    `Shared stub fields:`,
    stubFieldsText(order.stubFields || {}),
  ].filter(Boolean).join("\n");

  return {
    subject: `[${BUSINESS_NAME}] New order ${code} — ${order.stubFields?.eventLine2 || order.productName || "stub"}${tickets.length > 1 ? ` (${tickets.length} tickets)` : ""}`,
    html,
    text,
    stubUrl: tickets[0]?.stub_png_path ? await createSignedStubUrl(tickets[0].stub_png_path) : null,
  };
}

async function sendResendEmail({ to, subject, html, text, attachments, replyTo }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${BUSINESS_NAME} <${ORDER_FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      ...(attachments?.length ? { attachments } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { sent: false, error: `Resend ${res.status} ${txt.slice(0, 300)}` };
  }
  const body = await res.json().catch(() => ({}));
  return { sent: true, id: body.id };
}

export async function sendOrderConfirmation(order) {
  if (!order.email) return { sent: false, error: "No customer email on order." };
  if (!emailEnabled) {
    console.log("✉️  [order] email off — confirmation not sent to:", order.email);
    return { sent: false };
  }
  const { subject, html, text } = buildCustomerEmail(order);
  return sendResendEmail({
    to: order.email,
    subject,
    html,
    text,
    replyTo: SUPPORT_EMAIL || undefined,
  });
}

export async function sendOwnerNotification(order) {
  if (!ownerEmailEnabled) {
    console.log("📬 [order] owner email off — set FULFILLMENT_EMAIL + RESEND_API_KEY");
    return { sent: false };
  }
  const code = confirmationCode(order.sessionId);
  const { subject, html, text } = await buildOwnerEmail(order);

  const attachments = [];
  const tickets = orderTicketEntries(order);
  for (const ticket of tickets) {
    const seatTag = ticket.seat ? `seat-${ticket.seat}` : `ticket-${ticket.index || 1}`;
    if (!ticket.stub_png_path) continue;
    const png = await downloadStubPng(ticket.stub_png_path);
    if (png?.length) {
      attachments.push({
        filename: `stub-${code}-${seatTag}.png`,
        content: png.toString("base64"),
      });
      console.log(`📎 Owner email: attaching ${seatTag} PNG (${Math.round(png.length / 1024)} KB)`);
      continue;
    }
    const stubUrl = await createSignedStubUrl(ticket.stub_png_path, 86_400);
    if (stubUrl) {
      attachments.push({
        filename: `stub-${code}-${seatTag}.png`,
        path: stubUrl,
      });
      console.log(`📎 Owner email: attaching ${seatTag} via signed URL (${ticket.stub_png_path})`);
      continue;
    }
    console.error("Owner email: could not download stub PNG from", ticket.stub_png_path);
  }
  if (!attachments.length) {
    console.error("Owner email: order has no stub PNGs — nothing attached");
  }

  return sendResendEmail({
    to: FULFILLMENT_EMAIL,
    subject,
    html,
    text,
    attachments,
    replyTo: order.email || undefined,
  });
}

export async function sendFulfillmentNotifications(order) {
  let printCheck = { ok: true };
  if (persistenceEnabled && order.id) {
    printCheck = await verifyOrderRecord(order.id, { expectStatus: "paid" });
    if (!printCheck.ok) {
      console.error(
        "🚨 PRINT FULFILLMENT BLOCKED — order has invalid or missing ticket PNGs:",
        printCheck.error,
      );
    }
  }

  const customer = await sendOrderConfirmation(order);
  if (customer.error) console.error("Confirmation email error:", customer.error);
  else if (customer.sent) console.log("✉️  Confirmation email sent to", order.email);

  let ownerSent = false;
  if (printCheck.ok) {
    const owner = await sendOwnerNotification(order);
    if (owner.error) console.error("Owner notification error:", owner.error);
    else if (owner.sent) {
      ownerSent = true;
      console.log("📬 Fulfillment alert sent to", FULFILLMENT_EMAIL);
    }
  } else {
    console.error("📬 Owner print email skipped until valid ticket PNGs are stored for order", order.id);
  }

  return { customerSent: !!customer.sent, ownerSent, printOk: printCheck.ok };
}
