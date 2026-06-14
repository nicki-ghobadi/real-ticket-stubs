/**
 * Order fulfillment: persist paid orders and send confirmation emails.
 *
 * Both integrations are OPTIONAL and gated behind env vars so the app keeps
 * working (logging instead) until you wire your accounts:
 *   • Persistence  → Supabase  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *   • Email        → Resend    (RESEND_API_KEY + ORDER_FROM_EMAIL)
 *
 * The service-role key and Resend key are SERVER-ONLY secrets — never expose
 * them to the browser. @see DEPLOYMENT.md and supabase/migrations.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ORDER_FROM_EMAIL = process.env.ORDER_FROM_EMAIL || "";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || ORDER_FROM_EMAIL || "";
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Real Ticket Stubs";

export const persistenceEnabled = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
export const emailEnabled = !!(RESEND_API_KEY && ORDER_FROM_EMAIL);

/** Only allow HTTPS Supabase project URLs (blocks SSRF via a malicious env value). */
function isAllowedSupabaseUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /\.supabase\.co$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Format an integer amount of cents as a currency string, e.g. 2999 → $29.99 */
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

/** Build a short, human-friendly confirmation code from the Stripe session id. */
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

/**
 * Persist an order to Supabase. Idempotent: `stripe_session_id` is UNIQUE, so a
 * duplicate webhook delivery is ignored (returns {created:false}).
 * @returns {Promise<{persisted:boolean, created:boolean, id?:string, error?:string}>}
 */
export async function saveOrder(order) {
  if (!persistenceEnabled) {
    console.log("📝 [order] persistence off — order not stored:", {
      session: order.sessionId,
      email: order.email,
      product: order.productKey,
      amount: order.amountTotal,
    });
    // Treat as "created" so a confirmation email still goes out in setups that
    // have email configured but not a database yet.
    return { persisted: false, created: true };
  }

  if (!isAllowedSupabaseUrl(SUPABASE_URL)) {
    return { persisted: false, created: false, error: "Invalid SUPABASE_URL." };
  }

  const row = {
    stripe_session_id: order.sessionId,
    email: order.email || "",
    product_key: order.productKey || "",
    product_name: order.productName || "",
    amount_total: order.amountTotal ?? null,
    currency: order.currency || "usd",
    ship_name: order.shipping?.name || "",
    ship_line1: order.shipping?.line1 || "",
    ship_line2: order.shipping?.line2 || "",
    ship_city: order.shipping?.city || "",
    ship_state: order.shipping?.state || "",
    ship_postal_code: order.shipping?.postalCode || "",
    ship_country: order.shipping?.country || "",
    ticket_artist: order.ticket?.artist || "",
    ticket_venue: order.ticket?.venue || "",
    ticket_datetime: order.ticket?.datetime || "",
    address_status: order.addressStatus || "unknown",
    status: "paid",
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        // Ignore duplicates (idempotent on the unique session id) and return the row.
        Prefer: "return=representation,resolution=ignore-duplicates",
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { persisted: false, created: false, error: `Supabase ${res.status} ${txt.slice(0, 160)}` };
    }

    const data = await res.json().catch(() => []);
    const created = Array.isArray(data) && data.length > 0;
    return { persisted: true, created, id: created ? data[0].id : undefined };
  } catch (e) {
    return { persisted: false, created: false, error: `Supabase request failed: ${e.message}` };
  }
}

function buildEmail(order) {
  const code = confirmationCode(order.sessionId);
  const amount = formatMoney(order.amountTotal, order.currency);
  const addr = oneLineAddress(order.shipping);
  const product = order.productName || "Ticket stub";
  const support = SUPPORT_EMAIL ? `<a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>` : "us";
  const supportText = SUPPORT_EMAIL || "support";

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
    <h1 style="font-size:20px;margin:0 0 4px">Thanks for your order!</h1>
    <p style="margin:0 0 16px;color:#555">${esc(BUSINESS_NAME)} received your payment and your printed stub is being prepared.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:6px 0;color:#777">Confirmation #</td><td style="padding:6px 0;text-align:right;font-weight:600">${esc(code)}</td></tr>
      <tr><td style="padding:6px 0;color:#777">Item</td><td style="padding:6px 0;text-align:right">${esc(product)}</td></tr>
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
    `Item: ${product}`,
    `Amount paid: ${amount}`,
    addr ? `Shipping to: ${addr}` : "",
    ``,
    `We'll email you again when it ships (typically 3-5 business days).`,
    SUPPORT_EMAIL ? `Questions? ${supportText}` : "",
  ].filter(Boolean).join("\n");

  return { subject: `Order confirmed — ${code}`, html, text };
}

/**
 * Send an order confirmation email via Resend.
 * @returns {Promise<{sent:boolean, error?:string}>}
 */
export async function sendOrderConfirmation(order) {
  if (!order.email) return { sent: false, error: "No customer email on order." };
  if (!emailEnabled) {
    console.log("✉️  [order] email off — confirmation not sent to:", order.email);
    return { sent: false };
  }

  const { subject, html, text } = buildEmail(order);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${BUSINESS_NAME} <${ORDER_FROM_EMAIL}>`,
        to: [order.email],
        subject,
        html,
        text,
        ...(SUPPORT_EMAIL ? { reply_to: SUPPORT_EMAIL } : {}),
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { sent: false, error: `Resend ${res.status} ${txt.slice(0, 160)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: `Resend request failed: ${e.message}` };
  }
}
