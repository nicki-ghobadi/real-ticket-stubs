/**
 * Real Ticket Stubs — HTTP server.
 * @see TODO.md for production checklist (Stripe, fulfillment, rate limits, etc.)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateShippingComplete } from "./shipping-verify-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3456;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "text/plain") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

// Use the full GPT-4o for vision — the mini model often misses small grids of
// section/row/seat on busy mobile ticket UIs. Pricing is ~2x but accuracy is
// dramatically better on tile-style ticket layouts.
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o";

async function extractWithOpenAI(imageDataUrl) {
  if (!OPENAI_API_KEY) {
    const err = new Error("Extraction service is not configured.");
    err.code = "NO_API_KEY";
    throw err;
  }

  const body = {
    model: VISION_MODEL,
    messages: [
      {
        role: "system",
        content: [
          "You extract EVERY readable field from a concert/event ticket screenshot.",
          "Return ONLY valid JSON with the keys below. UPPERCASE all display strings.",
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
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract every ticket field from this image as JSON. Don't miss anything visible." },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      },
    ],
    max_tokens: 900,
    response_format: { type: "json_object" },
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from OpenAI");
  return JSON.parse(content);
}

/** Targeted second pass: when the main extract returned empty section/row/seat,
 *  ask the model again with a tiny, focused prompt. This dramatically improves
 *  recall on mobile ticket screenshots where those fields are in small chips. */
async function extractSeatingOnly(imageDataUrl) {
  if (!OPENAI_API_KEY) return {};
  const body = {
    model: VISION_MODEL,
    messages: [
      {
        role: "system",
        content: [
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
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Find SECTION, ROW, SEAT in this ticket image. Return JSON only." },
          { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
        ],
      },
    ],
    max_tokens: 150,
    response_format: { type: "json_object" },
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return {};
  const data = await response.json();
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return {};
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/api/validate-shipping") {
    try {
      const raw = await readBody(req);
      const data = JSON.parse(raw);
      const result = await validateShippingComplete(data);
      return send(res, 200, JSON.stringify(result), "application/json");
    } catch (e) {
      console.error("Validate shipping error:", e);
      return send(
        res,
        500,
        JSON.stringify({ valid: false, errors: { _form: "Validation failed. Try again." } }),
        "application/json",
      );
    }
  }

  if (req.method === "POST" && url.pathname === "/api/order") {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw);
      const shippingIn = payload?.shipping || {};
      const verified = await validateShippingComplete({
        ...shippingIn,
        emailConfirm: shippingIn.email,
      });
      if (!verified.valid) {
        return send(
          res,
          400,
          JSON.stringify({
            error: "Shipping address could not be verified.",
            errors: verified.errors,
          }),
          "application/json",
        );
      }
      const confirmation = "RTS-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      const shipping = verified.normalized;
      const item = payload?.item || {};
      // TODO(production): Stripe — create PaymentIntent / Checkout Session; reject unpaid orders.
      // TODO(production): Persist order + stub artifact to database (Supabase/Postgres).
      // TODO(production): Fulfillment API — submit print job (address + stub PDF/HTML).
      // TODO(production): Send confirmation email to shipping.email (Resend/SendGrid).
      console.log("📬 New order:", {
        confirmation,
        shipping: { name: shipping.name, city: shipping.city, country: shipping.country, email: shipping.email },
        item: { artist: item.artist, venue: item.venue, datetime: item.datetime, total: item.total },
        cardLast4: payload?.payment?.cardLast4,
      });
      return send(res, 200, JSON.stringify({ confirmation }), "application/json");
    } catch (e) {
      console.error("Order error:", e);
      return send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
  }

  if (req.method === "POST" && url.pathname === "/api/extract") {
    try {
      // TODO(production): Rate-limit /api/extract per IP. Cap request body size for images.
      const raw = await readBody(req);
      const { image } = JSON.parse(raw);
      if (!image?.startsWith("data:image/")) {
        return send(res, 400, JSON.stringify({ error: "Invalid image payload" }), "application/json");
      }
      const fields = await extractWithOpenAI(image);

      // If section/row/seat all came back empty, run a focused retry. This
      // catches the common case where the main extract overlooks small chips.
      const missing = ["section", "row", "seat"].filter((k) => !(fields?.[k] || "").trim());
      if (missing.length >= 2) {
        try {
          const retry = await extractSeatingOnly(image);
          for (const k of ["section", "row", "seat"]) {
            if (!(fields[k] || "").trim() && (retry[k] || "").trim()) {
              fields[k] = retry[k];
            }
          }
          fields._retried = true;
        } catch (e) {
          console.warn("Seating retry failed:", e.message);
        }
      }

      console.log("Extract result:", {
        model: VISION_MODEL,
        section: fields.section,
        row: fields.row,
        seat: fields.seat,
        retried: !!fields._retried,
      });
      return send(res, 200, JSON.stringify(fields), "application/json");
    } catch (e) {
      console.error("Extract error:", e);
      const status = e.code === "NO_API_KEY" ? 401 : 500;
      return send(
        res,
        status,
        JSON.stringify({ error: e.message, code: e.code || "EXTRACT_FAILED" }),
        "application/json",
      );
    }
  }

  let filePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  filePath = path.join(__dirname, path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, ""));

  if (!filePath.startsWith(__dirname)) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(filePath);
    send(res, 200, data, MIME[ext] || "application/octet-stream");
  });
});

server.listen(PORT, () => {
  console.log(`Real Ticket Stubs → http://localhost:${PORT}`);
  if (!OPENAI_API_KEY) {
    console.log("  OCR works in-browser. Set OPENAI_API_KEY for AI extract.");
  }
});
