/**
 * Order fulfillment: persist orders, store print PNGs, send notifications.
 *
 *   • Persistence  → Supabase  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *   • Storage      → Supabase bucket `order-stubs`
 *   • Email        → Resend    (RESEND_API_KEY + ORDER_FROM_EMAIL)
 *   • Owner alerts → FULFILLMENT_EMAIL (falls back to ORDER_FROM_EMAIL)
 */

import { TICKET_FIELD_KEYS } from "./public/templates.js";

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
const PRODUCT_CENTS = { mail: 399, framed: 2999 };

function cartLineItems(order) {
  return (order.cartItems || [])
    .filter((row) => row?.product && PRODUCT_LABELS[row.product])
    .map((row) => ({
      label: `${PRODUCT_LABELS[row.product]} × ${row.quantity}`,
      price: formatMoney((PRODUCT_CENTS[row.product] || 0) * row.quantity, order.currency),
    }));
}

async function uploadStubPng(orderId, pngBuffer) {
  if (!persistenceEnabled || !isAllowedSupabaseUrl(SUPABASE_URL)) {
    return { path: "", error: "Storage not configured." };
  }
  if (!pngBuffer?.length) {
    return { path: "", error: "Empty stub PNG." };
  }
  const objectPath = `${orderId}/stub.png`;
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
    return { path: "", error: `Storage upload failed: ${e.message}` };
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
    paymentIntent: row.stripe_payment_intent || "",
    addressStatus: row.address_status || "unknown",
    status: row.status || "pending",
    ownerNotifiedAt: row.owner_notified_at || null,
  };
}

/**
 * Create a pending order before Stripe checkout (captures stub + cart).
 * @returns {Promise<{orderId:string, persisted:boolean, error?:string}>}
 */
export async function createPendingOrder({
  cartItems,
  cartJson,
  productKey,
  productName,
  stubFields,
  stubPngBuffer,
}) {
  const orderId = crypto.randomUUID();
  const cleanFields = sanitizeStubFields(stubFields);

  if (!persistenceEnabled) {
    console.log("📝 [order] persistence off — pending order (not stored):", {
      orderId,
      product: productKey,
      stub: cleanFields.eventLine2 || cleanFields.section || "(empty)",
    });
    return { orderId, persisted: false };
  }

  if (!isAllowedSupabaseUrl(SUPABASE_URL)) {
    return { orderId, persisted: false, error: "Invalid SUPABASE_URL." };
  }

  let stubPngPath = "";
  if (stubPngBuffer?.length) {
    const uploaded = await uploadStubPng(orderId, stubPngBuffer);
    if (uploaded.error) {
      console.error("Stub PNG upload failed:", uploaded.error);
      return { orderId, persisted: false, error: uploaded.error };
    }
    stubPngPath = uploaded.path;
    console.log("🖼  Stub PNG stored:", stubPngPath, `(${Math.round((uploaded.bytes || 0) / 1024)} KB)`);
  } else {
    return { orderId, persisted: false, error: "Missing stub PNG for print fulfillment." };
  }

  const ticket = ticketSummary(cleanFields);
  const row = {
    id: orderId,
    status: "pending",
    stripe_session_id: null,
    email: "",
    product_key: productKey || "",
    product_name: productName || "",
    cart_json: cartJson || (cartItems?.length ? JSON.stringify(cartItems) : ""),
    stub_fields: cleanFields,
    stub_png_path: stubPngPath,
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
    console.log("📝 Pending order created:", orderId);
    return { orderId, persisted: true };
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
    } else {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
        method: "POST",
        headers: supabaseHeaders({
          "Content-Type": "application/json",
          Prefer: "return=representation,resolution=ignore-duplicates",
        }),
        body: JSON.stringify({ ...row, stub_png_path: order.stubPngPath || "" }),
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
      }
      if (!created) return { created: false, order };
    }
  } catch (e) {
    return { created: false, error: `Supabase request failed: ${e.message}` };
  }

  if (needsNotify) {
    await sendFulfillmentNotifications(order);
    await markOwnerNotified(order.id);
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

  const stubUrl = order.stubPngPath ? await createSignedStubUrl(order.stubPngPath) : null;
  const stubLink = stubUrl
    ? `<p style="margin:12px 0"><a href="${esc(stubUrl)}" style="color:#0066cc">Download print PNG (24h link)</a></p>` +
      `<p style="margin:8px 0"><img src="${esc(stubUrl)}" alt="Ticket stub preview" style="max-width:100%;border:1px solid #ddd" /></p>`
    : `<p style="margin:12px 0;color:#c00">Print PNG missing — check Supabase Storage (order-stubs bucket).</p>`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;line-height:1.5;max-width:640px;margin:0 auto;padding:24px">
    <h1 style="font-size:20px;margin:0 0 4px">New order — ${esc(code)}</h1>
    <p style="margin:0 0 16px;color:#555">A customer paid. Print and ship the stub below.</p>
    <h2 style="font-size:15px;margin:20px 0 8px">Customer</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:4px 8px 4px 0;color:#777">Email</td><td>${esc(order.email)}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Ship to</td><td>${esc(addr || "—")}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Items</td><td>${esc(itemsText.replace(/\n/g, ", "))}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Paid</td><td><strong>${esc(amount)}</strong></td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Stripe session</td><td style="font-size:12px">${esc(order.sessionId)}</td></tr>
      <tr><td style="padding:4px 8px 4px 0;color:#777">Address check</td><td>${esc(order.addressStatus || "unknown")}</td></tr>
    </table>
    ${stubLink}
    <h2 style="font-size:15px;margin:20px 0 8px">Stub fields</h2>
    ${stubFieldsHtml(order.stubFields || {})}
    <p style="margin:18px 0 0;font-size:12px;color:#999">Stub PNG attached when available.</p>
  </body></html>`;

  const text = [
    `New order — ${code}`,
    ``,
    `Email: ${order.email}`,
    `Ship to: ${addr || "—"}`,
    `Items:\n${itemsText}`,
    `Paid: ${amount}`,
    `Stripe: ${order.sessionId}`,
    `Address status: ${order.addressStatus || "unknown"}`,
    stubUrl ? `Print PNG: ${stubUrl}` : "",
    ``,
    `Stub fields:`,
    stubFieldsText(order.stubFields || {}),
  ].filter(Boolean).join("\n");

  return {
    subject: `[${BUSINESS_NAME}] New order ${code} — ${order.stubFields?.eventLine2 || order.productName || "stub"}`,
    html,
    text,
    stubUrl,
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
    return { sent: false, error: `Resend ${res.status} ${txt.slice(0, 160)}` };
  }
  return { sent: true };
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
  let png = null;
  if (order.stubPngPath) {
    png = await downloadStubPng(order.stubPngPath);
    if (!png?.length) {
      console.error("Owner email: could not download stub PNG from", order.stubPngPath);
    }
  } else {
    console.error("Owner email: order has no stub_png_path — PNG not attached");
  }
  if (png?.length) {
    attachments.push({
      filename: `stub-${code}.png`,
      content: png.toString("base64"),
      content_type: "image/png",
    });
    console.log(`📎 Attaching stub PNG (${Math.round(png.length / 1024)} KB) to owner email`);
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
  const customer = await sendOrderConfirmation(order);
  if (customer.error) console.error("Confirmation email error:", customer.error);
  else if (customer.sent) console.log("✉️  Confirmation email sent to", order.email);

  const owner = await sendOwnerNotification(order);
  if (owner.error) console.error("Owner notification error:", owner.error);
  else if (owner.sent) console.log("📬 Fulfillment alert sent to", FULFILLMENT_EMAIL);
}
