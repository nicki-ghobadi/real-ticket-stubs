/**
 * Real Ticket Stubs — HTTP server.
 * @see TODO.md for production checklist (Stripe, fulfillment, rate limits, etc.)
 */
import "./load-env.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { validateShippingComplete, validateAddressWithGoogle } from "./shipping-verify-server.mjs";
import { normalizeExtractedFields } from "./public/templates.js";
import {
  createPendingOrder,
  linkStripeSession,
  completePaidOrder,
  sanitizeStubFields,
  persistenceEnabled,
  emailEnabled,
  ownerEmailEnabled,
} from "./fulfillment.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENV_PATH = path.join(__dirname, ".env");
const PORT = Number(process.env.PORT) || 3456;
// 👉 ADD YOUR CLAUDE KEY: set ANTHROPIC_API_KEY in .env
//    Get it at https://console.anthropic.com/settings/keys
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_VERSION = "2023-06-01";
const IS_PROD = process.env.NODE_ENV === "production";

// ─────────────────────────── Stripe ───────────────────────────
// 👉 ADD YOUR STRIPE KEY: set STRIPE_SECRET_KEY in your .env file.
//    Get it at https://dashboard.stripe.com/apikeys
//    Use a restricted key (rk_...) or secret key (sk_test_... / sk_live_...).
//    With Stripe-hosted Checkout you only need this ONE server-side key —
//    no publishable key is required in the browser.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Optional real-deliverability checking (Google Address Validation API).
const ADDRESS_VALIDATION = !!process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;

/** Format Stripe shipping for display on the success page. */
function formatShippingDisplay(ship) {
  if (!ship) return "";
  return [ship.name, ship.line1, ship.line2, ship.city, ship.state, ship.postalCode, ship.country]
    .filter(Boolean)
    .join(", ");
}

/** Map Stripe ISO country + address into our shipping validator shape. */
function shippingForValidation(ship, email) {
  if (!ship) return null;
  const countryMap = { US: "United States", CA: "Canada" };
  return {
    name: ship.name || "",
    email: email || "",
    emailConfirm: email || "",
    street1: ship.line1 || "",
    street2: ship.line2 || "",
    city: ship.city || "",
    state: ship.state || "",
    zip: ship.postalCode || "",
    country: countryMap[String(ship.country || "").toUpperCase()] || ship.country || "",
  };
}
/** Normalize the shipping address out of a Stripe Checkout Session. */
function getShippingFromSession(session) {
  const sd =
    session?.collected_information?.shipping_details ||
    session?.shipping_details ||
    session?.shipping ||
    null;
  const a = sd?.address;
  if (!a) return null;
  return {
    name: sd.name || session?.customer_details?.name || "",
    line1: a.line1 || "",
    line2: a.line2 || "",
    city: a.city || "",
    state: a.state || "",
    postalCode: a.postal_code || "",
    country: a.country || "",
  };
}

// ─────────────────────── Security config ──────────────────────
// Comma-separated origins allowed to call the API from a different domain
// (needed only if you host the frontend on GoHighLevel and the backend
// elsewhere). Empty = same-origin only (the safe default).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Who may embed this app in an <iframe>. For GoHighLevel embedding, set this to
// your GHL domain(s), space-separated, e.g. "https://app.yoursite.com".
const FRAME_ANCESTORS = process.env.FRAME_ANCESTORS || "'self'";

// When behind a reverse proxy / platform load balancer (the normal case in
// production), trust X-Forwarded-* for the real client IP + protocol.
const TRUST_PROXY = process.env.TRUST_PROXY !== "false";

// Body size caps (defense against memory-exhaustion DoS).
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB decoded image
const MAX_EXTRACT_BODY = 14 * 1024 * 1024; // base64 inflates ~33% + JSON wrapper
const MAX_JSON_BODY = 64 * 1024; // 64 KB for ordinary JSON endpoints
const MAX_CHECKOUT_BODY = 12 * 1024 * 1024; // stub PNG base64 at checkout
const MAX_WEBHOOK_BODY = 1024 * 1024; // 1 MB Stripe webhook payload

// Stripe Payment Links — set in .env, never in source code.
// Public checkout URLs (not secret), but belong in env so you can swap test/live
// links per environment without committing or redeploying JS.
const STRIPE_PAYMENT_LINK_MAIL = process.env.STRIPE_PAYMENT_LINK_MAIL || "";
const STRIPE_PAYMENT_LINK_FRAMED = process.env.STRIPE_PAYMENT_LINK_FRAMED || "";

/** Only allow https://*.stripe.com payment links (blocks open redirects). */
function isValidStripePaymentLink(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && /(^|\.)stripe\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function getPaymentLinksConfig() {
  return {
    mail: isValidStripePaymentLink(STRIPE_PAYMENT_LINK_MAIL) ? STRIPE_PAYMENT_LINK_MAIL.trim() : "",
    framed: isValidStripePaymentLink(STRIPE_PAYMENT_LINK_FRAMED) ? STRIPE_PAYMENT_LINK_FRAMED.trim() : "",
  };
}

// Product catalog — prices are in cents. Keep these in sync with client.js.
const PRODUCTS = {
  mail: {
    name: "Printed ticket stub — mailed to you",
    description: "Thermal-style cardstock, perforated, shipped in 3–5 days.",
    amount: 399, // $3.99
  },
  framed: {
    name: "Framed ticket stub for the wall",
    description: "Printed stub mounted in a nice frame, ready to hang.",
    amount: 2999, // $29.99
  },
};

const MAX_CART_QTY = 99;

/** Normalize cart payload (multi-item) or legacy single `product` field. */
function parseCartPayload(payload) {
  let raw = [];
  if (Array.isArray(payload?.cart) && payload.cart.length) {
    raw = payload.cart;
  } else if (payload?.product && PRODUCTS[payload.product]) {
    raw = [{ product: payload.product, quantity: 1 }];
  } else {
    return { error: "Your cart is empty." };
  }

  const merged = new Map();
  for (const row of raw) {
    const key = String(row?.product || "");
    if (!PRODUCTS[key]) return { error: "Unknown product in cart." };
    const qty = Math.min(MAX_CART_QTY, Math.max(1, Math.floor(Number(row?.quantity) || 0)));
    merged.set(key, (merged.get(key) || 0) + qty);
  }

  const items = [...merged.entries()].map(([product, quantity]) => ({ product, quantity }));
  if (!items.length) return { error: "Your cart is empty." };

  const lineItems = items.map(({ product, quantity }) => ({
    quantity,
    price_data: {
      currency: "usd",
      unit_amount: PRODUCTS[product].amount,
      product_data: {
        name: PRODUCTS[product].name,
        description: PRODUCTS[product].description,
      },
    },
  }));

  const cartJson = JSON.stringify(items);
  const productSummary = items.map(({ product, quantity }) => `${product}:${quantity}`).join(",");
  const productName = items
    .map(({ product, quantity }) => `${PRODUCTS[product].name} × ${quantity}`)
    .join(", ");

  return { items, lineItems, cartJson, productSummary, productName, productKey: items.length === 1 ? items[0].product : "cart" };
}

/** Decode PNG IHDR width/height. */
function pngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Decode a PNG data-URL from checkout (print-ready stub). */
function parseStubPng(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return { error: "Missing stub image. Render your stub before checkout." };
  }
  const m = dataUrl.match(/^data:image\/png;base64,/i);
  if (!m) return { error: "Invalid stub image. Try exporting the stub again." };
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.slice(0, 256))) {
    return { error: "Malformed stub image data." };
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length > 15 * 1024 * 1024) return { error: "Stub image is too large (15 MB max)." };
  const dim = pngDimensions(buffer);
  if (!dim || dim.width < 1000 || dim.height < 400) {
    return {
      error: "Stub image looks blank or too small. Fill in your ticket stub preview, then try checkout again.",
    };
  }
  return { buffer, dimensions: dim };
}

/** Parse cart from Stripe session metadata (webhook / success page). */
function cartFromMetadata(metadata) {
  if (!metadata) return [];
  if (metadata.cart_json) {
    try {
      const parsed = JSON.parse(metadata.cart_json);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through */
    }
  }
  if (metadata.cart) {
    return String(metadata.cart)
      .split(",")
      .map((part) => {
        const [product, qty] = part.split(":");
        return { product, quantity: Number(qty) || 1 };
      })
      .filter((row) => row.product && PRODUCTS[row.product]);
  }
  if (metadata.product && PRODUCTS[metadata.product]) {
    return [{ product: metadata.product, quantity: 1 }];
  }
  return [];
}

/** Identify which product(s) were bought from session metadata or amount. */
function productFromSession(session) {
  const items = cartFromMetadata(session?.metadata);
  if (items.length) {
    const productName = items
      .map(({ product, quantity }) => `${PRODUCTS[product]?.name || product} × ${quantity}`)
      .join(", ");
    return {
      key: items.length === 1 ? items[0].product : "cart",
      name: productName || "Ticket stub order",
      items,
    };
  }
  const key = session?.metadata?.product;
  if (key && PRODUCTS[key]) return { key, name: PRODUCTS[key].name, items: [{ product: key, quantity: 1 }] };
  const amount = session?.amount_total;
  const match = Object.entries(PRODUCTS).find(([, p]) => p.amount === amount);
  if (match) return { key: match[0], name: match[1].name, items: [{ product: match[0], quantity: 1 }] };
  return { key: "", name: "Ticket stub", items: [] };
}

/** Best-effort public origin for Stripe success/cancel redirects. */
function getOrigin(req) {
  const proto = TRUST_PROXY
    ? (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim()
    : "http";
  const host = (TRUST_PROXY && req.headers["x-forwarded-host"]) || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

/** Real client IP (first hop in X-Forwarded-For when behind a trusted proxy). */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    if (xf) return String(xf).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// Content-Security-Policy: allows only the specific CDNs the app actually uses
// (Tesseract OCR, JsBarcode, html-to-image via jsDelivr; OCR-A font), plus the
// blob/wasm workers Tesseract needs. `frame-ancestors` governs iframe embedding.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.cdnfonts.com",
  "font-src 'self' https://fonts.cdnfonts.com data:",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com https://unpkg.com blob: data:",
  `frame-ancestors ${FRAME_ANCESTORS}`,
  "upgrade-insecure-requests",
].join("; ");

function securityHeaders(type) {
  const h = {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "Content-Security-Policy": CSP,
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  // HSTS only matters over HTTPS; safe to always send (ignored on http://).
  if (IS_PROD) h["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  // Legacy clickjacking guard for old browsers (CSP frame-ancestors handles
  // modern ones). Only when embedding isn't explicitly allowed, since
  // X-Frame-Options can't express an allowlist of external embedders.
  if (FRAME_ANCESTORS.trim() === "'self'") h["X-Frame-Options"] = "SAMEORIGIN";
  return h;
}

/** Apply CORS headers when the request origin is explicitly allowlisted. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, securityHeaders(type));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), "application/json");
}

// ─────────────────────── Rate limiting ────────────────────────
// In-memory fixed-window limiter. NOTE: this protects a single instance and
// stops casual abuse / cost-bombing. Real volumetric DDoS protection requires
// an upstream CDN/WAF (Cloudflare, etc.) — see DEPLOYMENT.md. For multi-instance
// deployments, back this with Redis instead of an in-process Map.
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  return { ok: b.count <= limit, retryAfter: Math.ceil((b.reset - now) / 1000) };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now > b.reset) rateBuckets.delete(k);
}, 60_000).unref();

/** Enforce a rate limit; writes a 429 and returns false when exceeded. */
function enforceRateLimit(req, res, name, limit, windowMs) {
  const { ok, retryAfter } = rateLimit(`${name}:${clientIp(req)}`, limit, windowMs);
  if (!ok) {
    res.setHeader("Retry-After", String(retryAfter));
    sendJson(res, 429, { error: "Too many requests. Please slow down and try again." });
    return false;
  }
  return true;
}

// Claude Sonnet is strong on vision + small UI text (section/row/seat chips).
const VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-4-6";

const TICKET_EXTRACT_SYSTEM = [
  "You extract EVERY readable field from a concert/event ticket screenshot.",
  "Return ONLY valid JSON with the keys below. UPPERCASE all display strings.",
  "Do not wrap JSON in markdown fences.",
  "",
  "★ TOP PRIORITY — section / row / seat are ALMOST ALWAYS on every ticket.",
  "Look carefully on mobile screenshots. They commonly appear as:",
  "  • three labeled tiles/cards stacked or side-by-side:",
  "        SECTION 117   ROW 14   SEAT 1",
  "  • a horizontal line: \"Sec 117 · Row 14 · Seat 1\"",
  "  • abbreviations: \"Sec\", \"Row\", \"Seat\", \"Asiento\", \"Fila\", \"Sección\"",
  "  • general admission tickets use \"GA\" or \"General Admission\" as section",
  "    and row/seat may be \"GA\" or blank — still fill section=\"GA\".",
  "  • floor seats use \"FLR\" + number (e.g. \"FLR 3\").",
  "  • some tickets show the values WITHOUT explicit labels, in a small monospace",
  "    row near the barcode — look there too.",
  "If you can read ANY of section/row/seat, fill them. Never leave all three empty",
  "unless the screenshot truly has no seating information.",
  "",
  "Other fields to capture:",
  "  • price (face value or paid), order/confirmation #, barcode (QR text or numeric)",
  "  • artist/event title, tour/subtitle, venue, city, date, time, gate, door time",
  "  • every visible code (ticket code, event code, CN/CR, confirmation, admission type)",
  "  • disclaimers / no-camera notes / age restrictions",
  "",
  "Rules:",
  "  • Use empty string \"\" for fields you cannot read.",
  "  • Never invent — only transcribe what's visible.",
  "  • For sections like \"Section 117\" output section=\"117\". For \"FLR 3\" output \"FLR 3\".",
  "  • For rows shown as letters like \"Row G\" output row=\"G\".",
  "  • datetime example: \"FRI JUL 18 2008 7:30 PM\" — keep weekday + month abbrev + day + year + time.",
  "",
  "JSON keys to include (always present, empty if unknown):",
  "  eventLine2 (artist/event title),",
  "  tour (subtitle / tour name),",
  "  promo (URL like WWW.LIVENATION.COM if shown, else \"\"),",
  "  venue, disclaimer,",
  "  datetime (e.g. \"FRI JUL 18 2008 7:30 PM\"),",
  "  dateShort (compact like \"18JUL08\"),",
  "  section, row, seat, aisle (full like \"AISLE 26\"),",
  "  price (\"180.00\" — no $),",
  "  ticketCode (short alphanum code if printed, else first 6 chars of order),",
  "  headerRight (matching code, usually \"E\"+ticketCode),",
  "  admissionType (e.g. VAUCTN, GENADM, ADULT),",
  "  eventNum (numeric event/confirmation #),",
  "  auxLeft (short section variant like \"CA 6X\"),",
  "  auxRight (e.g. \"CA404SJA\"),",
  "  orderCode (e.g. \"404VSJA\"),",
  "  cn (e.g. \"CN 17258\"),",
  "  barcode (digits only — pull from QR/barcode/ticketID).",
].join("\n");

const SEATING_EXTRACT_SYSTEM = [
  "You are a seat-info extractor. Look at the image and find SECTION,",
  "ROW, and SEAT for the ticket. Return JSON ONLY with three keys:",
  "  { \"section\": \"...\", \"row\": \"...\", \"seat\": \"...\" }",
  "Search EVERYWHERE in the image — top, bottom, sides, inside small chips,",
  "near the barcode, under the artist name. Common patterns:",
  "  • A three-tile row: SECTION 117 / ROW 14 / SEAT 1",
  "  • Inline: \"Sec 117 · Row 14 · Seat 1\"",
  "  • Labeled column with values below labels",
  "  • Floor seats: section starts with FLR/Floor",
  "  • Pit/General Admission: section = \"GA\"",
  "Return UPPERCASE strings. Empty string \"\" only if truly absent.",
  "Do not wrap JSON in markdown fences.",
].join("\n");

/** Parse a data-URL image into Anthropic's base64 image block format. */
function parseImageDataUrl(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]+=*)/i);
  if (!m) {
    const err = new Error("Invalid image data URL for vision API.");
    err.code = "BAD_IMAGE";
    throw err;
  }
  let mediaType = m[1].toLowerCase();
  if (mediaType === "image/jpg") mediaType = "image/jpeg";
  return { media_type: mediaType, data: m[2] };
}

/** Pull JSON out of a model reply (handles optional ```json fences). */
function parseJsonFromModel(text) {
  const t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : t;
  return JSON.parse(raw);
}

/** Call Claude vision (Anthropic Messages API). Returns raw text content. */
async function callClaudeVision({ system, userText, imageDataUrl, maxTokens }) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("Extraction service is not configured.");
    err.code = "NO_API_KEY";
    throw err;
  }
  const img = parseImageDataUrl(imageDataUrl);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: img.media_type, data: img.data },
            },
            { type: "text", text: userText },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("No content from Claude");
  return text;
}

async function extractWithClaude(imageDataUrl) {
  const text = await callClaudeVision({
    system: TICKET_EXTRACT_SYSTEM,
    userText: "Extract every ticket field from this image as JSON. Don't miss anything visible.",
    imageDataUrl,
    maxTokens: 900,
  });
  return parseJsonFromModel(text);
}

/** Targeted second pass: when the main extract returned empty section/row/seat,
 *  ask Claude again with a tiny, focused prompt. */
async function extractSeatingOnly(imageDataUrl) {
  if (!ANTHROPIC_API_KEY) return {};
  try {
    const text = await callClaudeVision({
      system: SEATING_EXTRACT_SYSTEM,
      userText: "Find SECTION, ROW, SEAT in this ticket image. Return JSON only.",
      imageDataUrl,
      maxTokens: 150,
    });
    return parseJsonFromModel(text);
  } catch {
    return {};
  }
}

/** Read the request body as a Buffer, rejecting once it exceeds `maxBytes`.
 *  On overflow we stop buffering (bounded memory) and pause the stream, but
 *  leave the socket alive so the handler can still send a clean 413 response. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        req.pause();
        const err = new Error("Payload too large");
        err.code = "TOO_LARGE";
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Read and JSON-parse a capped body. Throws BAD_JSON / TOO_LARGE on failure. */
async function readJson(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  try {
    return JSON.parse(buf.toString("utf8") || "{}");
  } catch {
    const err = new Error("Invalid JSON body");
    err.code = "BAD_JSON";
    throw err;
  }
}

/** Validate a base64 data-URL image: allowed type + decoded size cap. */
function validateImagePayload(image) {
  if (typeof image !== "string") return "Invalid image payload.";
  const m = image.match(/^data:image\/(png|jpe?g|webp);base64,/i);
  if (!m) return "Unsupported image. Upload a PNG, JPG, or WEBP.";
  const comma = image.indexOf(",");
  const b64 = image.slice(comma + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64.slice(0, 256))) return "Malformed image data.";
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) return "Image is too large (8 MB max).";
  return null;
}

// Files the browser is allowed to fetch. Everything else (server.mjs, .env,
// package.json, README, node_modules, …) returns 404 — closing the critical
// source/secret disclosure hole in the old "serve any file" handler.
const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/ticket.css", "ticket.css"],
  ["/client.js", "client.js"],
  ["/templates.js", "templates.js"],
  ["/shipping-validation.js", "shipping-validation.js"],
  ["/terms.html", "terms.html"],
  ["/privacy.html", "privacy.html"],
  ["/refunds.html", "refunds.html"],
]);

/** Process a paid checkout: capture address, verify deliverability, fulfill.
 *  Runs after we've already 200'd the webhook, so errors only log. */
async function handleCheckoutCompleted(sessionObj) {
  try {
    // Re-retrieve to make sure shipping + customer details are populated.
    let session = sessionObj;
    if (stripe && sessionObj?.id) {
      try {
        session = await stripe.checkout.sessions.retrieve(sessionObj.id, {
          expand: ["customer_details"],
        });
      } catch (e) {
        console.warn("Could not retrieve session; using event payload:", e.message);
      }
    }

    const ship = getShippingFromSession(session);
    const email = session?.customer_details?.email || session?.customer_email || "";
    const product = productFromSession(session);
    console.log("✅ Payment completed:", {
      session: session?.id,
      email,
      product: product.key,
      amount: session?.amount_total,
      ship,
    });

    // Post-payment address checks (charge is already captured — flag bad addresses
    // for manual review/refund rather than blocking payment).
    let addressStatus = "unknown";
    if (!ship) {
      addressStatus = "missing";
      console.warn("⚠️  No shipping address on completed checkout:", session?.id);
    } else {
      const forValidation = shippingForValidation(ship, email);
      const verified = await validateShippingComplete(forValidation);
      if (!verified.valid) {
        addressStatus = "needs_review";
        console.warn("⚠️  ADDRESS FAILED VERIFICATION:", {
          entered: ship,
          errors: verified.errors,
        });
      } else if (ADDRESS_VALIDATION) {
        const verdict = await validateAddressWithGoogle(ship);
        if (verdict.configured && verdict.ok) {
          if (verdict.deliverable) {
            addressStatus = "deliverable";
            console.log("📦 Address verified deliverable:", verdict.formatted);
          } else {
            addressStatus = "needs_review";
            console.warn("⚠️  ADDRESS NEEDS REVIEW (possibly undeliverable):", {
              entered: ship,
              granularity: verdict.granularity,
              unconfirmed: verdict.hasUnconfirmedComponents,
              suggestion: verdict.formatted,
            });
          }
        } else if (verdict.configured) {
          addressStatus = "check_error";
          console.warn("Address validation error:", verdict.error);
        } else {
          addressStatus = "verified_basic";
        }
      } else {
        addressStatus = "verified_basic";
      }
    }

    const order = {
      orderId: session?.metadata?.order_id || "",
      sessionId: session?.id || "",
      email,
      productKey: product.key,
      productName: product.name,
      cartJson: session?.metadata?.cart_json || session?.metadata?.cart || "",
      cartItems: product.items,
      amountTotal: session?.amount_total ?? null,
      currency: session?.currency || "usd",
      shipping: ship,
      paymentIntent: session?.payment_intent || "",
      addressStatus,
    };

    const fulfilled = await completePaidOrder(order);
    if (fulfilled.error) console.error("Order fulfillment error:", fulfilled.error);
    else if (!fulfilled.created) {
      console.log("↩️  Duplicate webhook for", session?.id, "— skipping notifications.");
    }

    // TODO(production): submit the print job to your fulfillment partner.
  } catch (e) {
    console.error("handleCheckoutCompleted error:", e);
  }
}

/** Map internal errors to safe client responses without leaking details. */
function handleError(res, where, e) {
  if (e?.code === "TOO_LARGE") {
    // The request body wasn't fully read; close the connection to avoid
    // keep-alive desync, but still deliver a clean 413 first.
    res.setHeader("Connection", "close");
    return sendJson(res, 413, { error: "Payload too large." });
  }
  if (e?.code === "BAD_JSON") return sendJson(res, 400, { error: "Invalid request body." });
  console.error(`${where} error:`, e);
  return sendJson(res, 500, { error: "Something went wrong. Please try again." });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return send(res, 400, "Bad request");
  }
  const { pathname } = url;

  applyCors(req, res);

  // CORS preflight.
  if (req.method === "OPTIONS") {
    res.writeHead(204, securityHeaders("text/plain"));
    return res.end();
  }

  if (req.method !== "GET" && req.method !== "POST" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return sendJson(res, 405, { error: "Method not allowed." });
  }

  // ── Public app config (payment link URLs from env — safe to expose to browser) ──
  if (req.method === "GET" && pathname === "/api/config") {
    if (!enforceRateLimit(req, res, "config", 120, 10 * 60_000)) return;
    const links = getPaymentLinksConfig();
    return sendJson(res, 200, {
      paymentLinks: links,
      hasPaymentLinks: !!(links.mail || links.framed),
    });
  }

  // ── Health check (for load balancers / uptime monitors) ──
  if (req.method === "GET" && pathname === "/healthz") {
    return sendJson(res, 200, {
      status: "ok",
      ai: !!ANTHROPIC_API_KEY,
      payments: !!stripe,
      time: new Date().toISOString(),
    });
  }

  // ── Stripe webhook — MUST verify the signature on the RAW body ──
  // This is how you confirm a payment really succeeded before fulfilling.
  if (req.method === "POST" && pathname === "/api/stripe/webhook") {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return sendJson(res, 503, { error: "Webhooks not configured." });
    }
    try {
      const raw = await readBody(req, MAX_WEBHOOK_BODY);
      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.warn("Stripe webhook signature failed:", err.message);
        return sendJson(res, 400, { error: "Invalid signature." });
      }
      if (event.type === "checkout.session.completed") {
        // Acknowledge fast, then process (Stripe expects a prompt 2xx).
        sendJson(res, 200, { received: true });
        void handleCheckoutCompleted(event.data.object);
        return;
      }
      return sendJson(res, 200, { received: true });
    } catch (e) {
      return handleError(res, "Webhook", e);
    }
  }

  // ── Verify shipping address ──
  if (req.method === "POST" && pathname === "/api/validate-shipping") {
    if (!enforceRateLimit(req, res, "validate", 30, 10 * 60_000)) return;
    try {
      const data = await readJson(req, MAX_JSON_BODY);
      const result = await validateShippingComplete(data);
      return sendJson(res, 200, result);
    } catch (e) {
      if (e.code === "TOO_LARGE" || e.code === "BAD_JSON") return handleError(res, "Validate shipping", e);
      console.error("Validate shipping error:", e);
      return sendJson(res, 500, { valid: false, errors: { _form: "Validation failed. Try again." } });
    }
  }

  // ── Create Stripe Checkout session ──
  if (req.method === "POST" && pathname === "/api/create-checkout-session") {
    if (!enforceRateLimit(req, res, "checkout", 15, 10 * 60_000)) return;
    try {
      const payload = await readJson(req, MAX_CHECKOUT_BODY);
      const parsed = parseCartPayload(payload);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });

      const stubFields = sanitizeStubFields(payload?.stubFields || payload?.item || {});
      const pngParsed = parseStubPng(payload?.stubPng);
      if (pngParsed.error) return sendJson(res, 400, { error: pngParsed.error });

      // Demo fallback for local dev only.
      if (!stripe) {
        if (IS_PROD) {
          return sendJson(res, 503, { error: "Payments are not configured." });
        }
        const confirmation = "RTS-" + Math.random().toString(36).slice(2, 8).toUpperCase();
        console.log("⚠️  STRIPE_SECRET_KEY not set — mocking order:", {
          confirmation,
          cart: parsed.productSummary,
          stub: stubFields.eventLine2 || stubFields.section || "(empty)",
        });
        return sendJson(res, 200, { mock: true, confirmation });
      }

      const pending = await createPendingOrder({
        cartItems: parsed.items,
        cartJson: parsed.cartJson,
        productKey: parsed.productKey,
        productName: parsed.productName,
        stubFields,
        stubPngBuffer: pngParsed.buffer,
      });
      if (pending.error) {
        return sendJson(res, 503, { error: "Could not save your stub for printing. Try again." });
      }

      const origin = getOrigin(req);
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: parsed.lineItems,
        shipping_address_collection: { allowed_countries: ["US", "CA"] },
        success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?checkout=cancel`,
        metadata: {
          order_id: pending.orderId,
          cart: parsed.productSummary,
          cart_json: parsed.cartJson.slice(0, 450),
          product: parsed.productKey,
        },
      });

      await linkStripeSession(pending.orderId, session.id);

      return sendJson(res, 200, { url: session.url, orderId: pending.orderId });
    } catch (e) {
      return handleError(res, "Create checkout session", e);
    }
  }

  // ── Look up a completed Checkout Session for the success screen ──
  if (req.method === "GET" && pathname === "/api/checkout-session") {
    if (!enforceRateLimit(req, res, "session-lookup", 60, 10 * 60_000)) return;
    try {
      const id = url.searchParams.get("id");
      // Only accept well-formed Stripe session ids.
      if (!stripe || !id || !/^cs_[A-Za-z0-9_]+$/.test(id)) {
        return sendJson(res, 200, { paid: false });
      }
      const session = await stripe.checkout.sessions.retrieve(id, {
        expand: ["customer_details"],
      });
      const ship = getShippingFromSession(session);
      const items = cartFromMetadata(session.metadata);
      return sendJson(res, 200, {
        paid: session.payment_status === "paid",
        confirmation: (session.id || "").replace(/^cs_(test_|live_)?/, "").slice(0, 8).toUpperCase(),
        email: session.customer_details?.email || session.customer_email || "",
        product: session.metadata?.product || "",
        cart: items,
        shippingAddress: formatShippingDisplay(ship),
        amountTotal: session.amount_total,
      });
    } catch (e) {
      console.error("Retrieve checkout session error:", e.message);
      return sendJson(res, 200, { paid: false });
    }
  }

  // ── AI ticket extraction ──
  if (req.method === "POST" && pathname === "/api/extract") {
    if (!enforceRateLimit(req, res, "extract", 12, 5 * 60_000)) return;
    try {
      const payload = await readJson(req, MAX_EXTRACT_BODY);
      const image = payload?.image;
      const imgErr = validateImagePayload(image);
      if (imgErr) return sendJson(res, 400, { error: imgErr });

      let fields = normalizeExtractedFields(await extractWithClaude(image));

      // If section/row/seat all came back empty, run a focused retry. This
      // catches the common case where the main extract overlooks small chips.
      const missing = ["section", "row", "seat"].filter((k) => !(fields[k] || "").trim());
      let retried = false;
      if (missing.length >= 2) {
        try {
          const retry = normalizeExtractedFields(await extractSeatingOnly(image));
          for (const k of ["section", "row", "seat"]) {
            if (!(fields[k] || "").trim() && (retry[k] || "").trim()) fields[k] = retry[k];
          }
          retried = true;
        } catch (e) {
          console.warn("Seating retry failed:", e.message);
        }
      }

      console.log("Extract result:", {
        model: VISION_MODEL,
        section: fields.section,
        row: fields.row,
        seat: fields.seat,
        eventLine2: fields.eventLine2,
        retried,
      });
      return sendJson(res, 200, fields);
    } catch (e) {
      if (e.code === "TOO_LARGE" || e.code === "BAD_JSON") return handleError(res, "Extract", e);
      if (e.code === "NO_API_KEY") {
        return sendJson(res, 503, { error: "Extraction is not configured on the server.", code: "NO_API_KEY" });
      }
      console.error("Extract error:", e);
      return sendJson(res, 502, { error: "Could not read the ticket right now. Try again.", code: "EXTRACT_FAILED" });
    }
  }

  // ── Static files (strict allowlist) ──
  if (req.method === "GET" || req.method === "HEAD") {
    const file = PUBLIC_FILES.get(pathname);
    if (!file) return send(res, 404, "Not found");
    const filePath = path.join(__dirname, "public", file);
    return fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat.isFile()) return send(res, 404, "Not found");
      const ext = path.extname(filePath);
      // ETag from size + mtime so the browser revalidates and we serve 304s,
      // but any code change is picked up immediately (no stale-asset bug).
      const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      const headers = securityHeaders(MIME[ext] || "application/octet-stream");
      headers["Cache-Control"] = "no-cache"; // always revalidate via ETag
      headers["ETag"] = etag;

      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      fs.readFile(filePath, (err, data) => {
        if (err) return send(res, 404, "Not found");
        res.writeHead(200, headers);
        res.end(req.method === "HEAD" ? undefined : data);
      });
    });
  }

  return sendJson(res, 404, { error: "Not found." });
});

// Mitigate slow-client (Slowloris) attacks and runaway requests.
server.requestTimeout = 60_000; // allow large image uploads, but bound them
server.headersTimeout = 20_000; // headers must arrive promptly
server.keepAliveTimeout = 5_000;

server.listen(PORT, () => {
  console.log(`Real Ticket Stubs → http://localhost:${PORT}  (NODE_ENV=${process.env.NODE_ENV || "development"})`);
  if (fs.existsSync(ENV_PATH)) {
    console.log("  📄 Loaded config from .env");
  }
  if (!ANTHROPIC_API_KEY) {
    console.log("  OCR works in-browser. Set ANTHROPIC_API_KEY for Claude AI extract.");
  }
  if (!stripe) {
    console.log("  ⚠️  STRIPE_SECRET_KEY not set — checkout runs in mock mode (no real charges).");
  } else {
    console.log("  💳 Stripe checkout enabled.");
    if (!STRIPE_WEBHOOK_SECRET) {
      console.log("  ⚠️  STRIPE_WEBHOOK_SECRET not set — set it before fulfilling paid orders.");
    }
  }
  const links = getPaymentLinksConfig();
  const linkCount = [links.mail, links.framed].filter(Boolean).length;
  console.log(`  🔗 Payment links: ${linkCount}/2 configured (STRIPE_PAYMENT_LINK_MAIL / _FRAMED in .env)`);
  console.log(`  📦 Address deliverability check: ${ADDRESS_VALIDATION ? "Google Address Validation ON" : "off (set GOOGLE_ADDRESS_VALIDATION_API_KEY)"}`);
  console.log(`  🗄  Order persistence: ${persistenceEnabled ? "Supabase ON" : "off (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)"}`);
  console.log(`  ✉️  Customer emails: ${emailEnabled ? "Resend ON" : "off (set RESEND_API_KEY + ORDER_FROM_EMAIL)"}`);
  console.log(`  📬 Owner alerts: ${ownerEmailEnabled ? `Resend → ${process.env.FULFILLMENT_EMAIL || process.env.ORDER_FROM_EMAIL}` : "off (set FULFILLMENT_EMAIL + RESEND_API_KEY)"}`);
  console.log(`  🔒 CORS allowlist: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "same-origin only"}`);
  console.log(`  🖼  frame-ancestors: ${FRAME_ANCESTORS}`);
  if (!IS_PROD) console.log("  ℹ️  Set NODE_ENV=production in production to enable HSTS.");
});

// Don't crash the process on an unexpected async error.
process.on("unhandledRejection", (r) => console.error("Unhandled rejection:", r));
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e));
