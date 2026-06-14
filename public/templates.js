/** Stub HTML/CSS generation. @see TODO.md — server-side PDF export for fulfillment. */

function upper(s) {
  return String(s ?? "").toUpperCase().trim();
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortDate(datetime) {
  const m = String(datetime).match(
    /(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*(\d{2,4})/i,
  );
  if (!m) return "";
  const day = m[1].padStart(2, "0");
  const mon = m[2].toUpperCase().slice(0, 3);
  const yr = m[3].length === 4 ? m[3].slice(-2) : m[3];
  return `${day}${mon}${yr}`;
}

/** Canonical form/stub field names (must match index.html input `name`s). */
export const TICKET_FIELD_KEYS = [
  "ticketCode", "headerRight", "section", "row", "seat", "price",
  "admissionType", "aisle", "eventNum", "auxLeft", "auxRight",
  "orderCode", "cn", "promo", "eventLine2", "tour", "venue",
  "disclaimer", "datetime", "dateShort", "barcode",
];

/** Map common AI/OCR key variants → canonical stub field names. */
const FIELD_ALIASES = new Map([
  ["artist", "eventLine2"],
  ["event", "eventLine2"],
  ["eventtitle", "eventLine2"],
  ["event_title", "eventLine2"],
  ["eventname", "eventLine2"],
  ["eventline2", "eventLine2"],
  ["eventline", "eventLine2"],
  ["title", "eventLine2"],
  ["performer", "eventLine2"],
  ["tourname", "tour"],
  ["subtitle", "tour"],
  ["venuename", "venue"],
  ["location", "venue"],
  ["date", "datetime"],
  ["datetime", "datetime"],
  ["date_time", "datetime"],
  ["eventdate", "datetime"],
  ["eventtime", "datetime"],
  ["dateshort", "dateShort"],
  ["shortdate", "dateShort"],
  ["ticketcode", "ticketCode"],
  ["eventcode", "ticketCode"],
  ["headerright", "headerRight"],
  ["header_right", "headerRight"],
  ["admission", "admissionType"],
  ["admissiontype", "admissionType"],
  ["admissioncode", "admissionType"],
  ["eventnum", "eventNum"],
  ["eventnumber", "eventNum"],
  ["event_num", "eventNum"],
  ["ordercode", "orderCode"],
  ["order_code", "orderCode"],
  ["confirmation", "orderCode"],
  ["auxleft", "auxLeft"],
  ["auxright", "auxRight"],
  ["barcodenumber", "barcode"],
  ["barcode_num", "barcode"],
  ["sectionaisle", "section"],
  ["sec", "section"],
]);

function compactKey(raw) {
  return String(raw).toLowerCase().replace(/[\s._-]+/g, "");
}

function resolveFieldKey(rawKey) {
  const compact = compactKey(rawKey);
  if (FIELD_ALIASES.has(compact)) return FIELD_ALIASES.get(compact);
  return TICKET_FIELD_KEYS.find((k) => compactKey(k) === compact) || null;
}

function assignField(out, key, value) {
  const s = String(value ?? "").trim();
  if (s) out[key] = s;
}

/** Normalize vision/OCR JSON into the flat field map the stub form expects. */
export function normalizeExtractedFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const root = raw.ticket || raw.fields || raw.data || raw;
  const sources = [root, raw];
  const out = {};

  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [rawKey, rawVal] of Object.entries(source)) {
      if (rawKey.startsWith("_")) continue;

      // Flatten one-level nests: { seating: { section: "117" } }
      if (rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)) {
        for (const [subKey, subVal] of Object.entries(rawVal)) {
          const key = resolveFieldKey(subKey);
          if (key) assignField(out, key, subVal);
        }
        continue;
      }

      const key = resolveFieldKey(rawKey);
      if (key) assignField(out, key, rawVal);
    }
  }

  return out;
}

export function defaultFields() {
  return {
    ticketCode: "SJ0718",
    headerRight: "ESJ0718",
    section: "FLR 3",
    row: "14",
    seat: "1",
    price: "180.00",
    admissionType: "VAUCTN",
    aisle: "AISLE 26",
    eventNum: "1046555",
    auxLeft: "CA  6X",
    auxRight: "CA404SJA",
    orderCode: "404VSJA",
    cn: "CN 17258",
    promo: "WWW.LIVENATION.COM",
    eventLine2: "COLDPLAY",
    tour: "VIVA LA VIDA TOUR",
    venue: "HP PAVILION AT SAN JOSE",
    disclaimer: "NO CAMERAS OR RECORDERS",
    datetime: "FRI JUL 18 2008 7:30 PM",
    dateShort: "18JUL08",
    barcode: "6540422223612",
  };
}

function pick(value, fallback) {
  const s = upper(value);
  return s === "" ? fallback : s;
}

// Deterministic A-Z derivation from a numeric/alphanumeric seed.
// Used to fabricate the legacy printed-only codes (auxLeft/auxRight/etc.)
// from data that DOES exist on a modern mobile ticket, so the rendered
// stub always looks complete.
function alphaCode(seed, len) {
  const s = String(seed || "TICKET").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  let out = "";
  for (let i = 0; i < len; i++) {
    out += A[(h + i * 7) % 26];
    h = (h * 17 + 13) >>> 0;
  }
  return out;
}

/** Deterministic numeric barcode from a seed (for when OCR/vision find no digits). */
function numericBarcode(seed, len) {
  const fromDigits = digits(seed, len);
  if (fromDigits) return fromDigits;
  const s = String(seed || "TICKET");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  let out = "";
  for (let i = 0; i < len; i++) {
    out += String((h + i * 7) % 10);
    h = (h * 17 + 13) >>> 0;
  }
  return out;
}

function digits(s, n) {
  const d = String(s || "").replace(/\D/g, "");
  if (!d) return "";
  return d.length <= n ? d.padStart(n, "0") : d.slice(-n);
}

function venuePrefix(venue) {
  const w = String(venue || "").toUpperCase().replace(/[^A-Z ]/g, "").split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  if (w.length === 1) return w[0].slice(0, 2);
  // grab the first letter of each significant word, max 2
  const stop = new Set(["AT", "OF", "THE", "AND", "ON", "IN"]);
  const initials = w.filter((x) => !stop.has(x)).map((x) => x[0]).join("");
  return initials.slice(0, 2) || w[0].slice(0, 2);
}

export function prepareTicketData(raw) {
  const f = raw || {};
  const datetime = upper(f.datetime);
  const section = upper(f.section);
  const row = upper(f.row);
  const seat = upper(f.seat);
  const venue = upper(f.venue);
  const artist = upper(f.eventLine2);
  const tour = upper(f.tour);
  const orderCodeRaw = upper(f.orderCode);
  const barcodeRaw = String(f.barcode || "").replace(/\D/g, "");

  const priceRaw = String(f.price || "").replace(/^\$/, "").trim();
  const priceDisplay = priceRaw === ""
    ? ""
    : priceRaw.includes(".") ? priceRaw : `${priceRaw}.00`;

  // ── Derive any printed-only field that's missing, so the stub looks
  // complete even from a mobile screenshot that doesn't print these codes.
  const seed = orderCodeRaw || barcodeRaw || `${artist}${section}${row}${seat}` || venue;
  const eventNum = pick(
    f.eventNum,
    digits(barcodeRaw, 7) || digits(orderCodeRaw, 7) || alphaCode(seed, 7),
  );
  const cn = pick(
    f.cn,
    `CN ${digits(barcodeRaw.slice(0, 5) || alphaCode(seed, 5), 5)}`,
  );

  const vp = venuePrefix(venue);
  const orderCode = orderCodeRaw || (vp + alphaCode(seed + "ORD", 5)).slice(0, 7);
  const ticketCodeRaw = upper(f.ticketCode);
  const ticketCode = ticketCodeRaw || (vp + digits(seed, 4)).slice(0, 6) || alphaCode(seed, 6);
  const headerRight = upper(f.headerRight) || (ticketCode ? "E" + ticketCode : "");

  const admissionType = pick(
    f.admissionType,
    artist ? alphaCode(artist + venue, 6) : "GENADM",
  );

  // aisle ↔ section: if we have aisle great, otherwise derive a sensible
  // "AISLE NN" from section/row digits so the sub-row isn't empty.
  const aisleRaw = upper(f.aisle);
  const aisleNum = (section.match(/\d+/) || row.match(/\d+/) || [""])[0];
  const aisle = aisleRaw || (aisleNum ? `AISLE ${aisleNum}` : "");

  // CA  6X style aux: derive from section abbrev + seat digits
  const auxLeft = upper(f.auxLeft) ||
    (section ? `${vp || "CA"}  ${(row || seat || "1").slice(0, 2)}X` : "");
  const auxRight = upper(f.auxRight) ||
    (section ? `${vp || "CA"}${alphaCode(section + row + seat, 3)}${(row || "1").slice(0, 2)}A` : "");

  const promo = pick(f.promo, "WWW.TICKETMASTER.COM");
  const disclaimer = pick(f.disclaimer, "NO CAMERAS OR RECORDERS");

  return {
    code: ticketCode,
    headerRight,
    section,
    row,
    seat,
    priceBig: priceDisplay ? `$${priceDisplay}` : "",
    priceDisplay,
    priceRight: priceDisplay ? `V ${priceDisplay}` : "",
    admissionType,
    aisle,
    eventNum,
    auxLeft,
    auxRight,
    orderCode,
    cn,
    promo,
    artist,
    tour,
    venue,
    disclaimer,
    datetime,
    dateShort: pick(f.dateShort, shortDate(datetime)),
    barcode: barcodeRaw || numericBarcode(seed, 13),
  };
}

// Tiny pseudo CODE128 renderer — visually-correct vertical barcode stripes
// derived deterministically from the input. The actual digits are printed
// beneath, so this is for visual fidelity, not machine scanning.
function renderBarcodeSvg(value) {
  const raw = String(value || "0000000000000").replace(/\D/g, "") || "6540422223612";
  // Derive stripe heights from input digits.
  let heights = [];
  for (let i = 0; i < raw.length; i++) {
    const d = parseInt(raw[i], 10);
    heights.push(1 + (d % 4));
    heights.push(1 + ((d * 7 + i) % 3));
  }
  while (heights.length < 60) heights.push(1 + (heights.length % 3));

  // Vertical barcode: stripes run horizontally (full width), stacked top-to-bottom.
  const viewW = 54;
  const viewH = 470;
  let y = 4;
  const rects = [];
  for (let i = 0; i < heights.length && y < viewH - 4; i++) {
    const h = heights[i] * 2;
    if (i % 2 === 0) {
      rects.push(`<rect x="0" y="${y}" width="${viewW}" height="${h}" fill="#0a0a0a"/>`);
    }
    y += h + 1;
  }
  return `<svg class="tm-barcode" viewBox="0 0 ${viewW} ${viewH}" preserveAspectRatio="none" aria-label="Barcode">${rects.join("")}</svg>`;
}

export function buildTicketHtml(d) {
  const parts = [];
  parts.push('<article class="tm" aria-label="Ticketmaster printable ticket">');

  // Left stub + perforation
  parts.push('<aside class="tm-left">');
  parts.push(`<div class="tm-left-top">${esc(d.code)}</div>`);
  parts.push('<div class="tm-left-toplbl">EVENT CODE</div>');
  parts.push(`<div class="tm-left-price">${esc(d.priceBig)}</div>`);
  parts.push('<div class="tm-left-cc">CONVENIENCE CHARGE</div>');
  parts.push('<div class="tm-left-cc-sym">$</div>');
  parts.push('<div class="tm-left-seclbl">SECTION/AISLE</div>');
  parts.push(`<div class="tm-left-sec">${esc(d.section)}</div>`);
  parts.push(`<div class="tm-left-aux">${esc(d.auxLeft)}</div>`);
  parts.push('<div class="tm-left-rowlbl">ROW</div>');
  parts.push('<div class="tm-left-seatlbl">SEAT</div>');
  parts.push(`<div class="tm-left-row">${esc(d.row)}</div>`);
  parts.push(`<div class="tm-left-seat">${esc(d.seat)}</div>`);
  parts.push(`<div class="tm-left-order">${esc(d.orderCode)}</div>`);
  parts.push(`<div class="tm-left-date">${esc(d.dateShort)}</div>`);
  parts.push('</aside>');

  parts.push('<div class="tm-perf tm-perf-left" aria-hidden="true"></div>');

  // Center: header + event
  parts.push('<section class="tm-center">');
  parts.push('<div class="tm-head-vals">');
  parts.push(`<span>${esc(d.section)}</span>`);
  parts.push(`<span>${esc(d.row)}</span>`);
  parts.push(`<span>${esc(d.seat)}</span>`);
  parts.push(`<span>${esc(d.admissionType)}</span>`);
  parts.push(`<span>${esc(d.headerRight)}</span>`);
  parts.push('</div>');
  parts.push('<div class="tm-head-lbls">');
  parts.push('<span>SECTION/AISLE</span>');
  parts.push('<span>ROW/BOX</span>');
  parts.push('<span>SEAT</span>');
  parts.push('<span>ADMISSION</span>');
  parts.push('<span>EVENT CODE</span>');
  parts.push('</div>');
  parts.push('<div class="tm-sub">');
  parts.push(`<span class="tm-sub-aisle">${esc(d.aisle)}</span>`);
  parts.push(`<span class="tm-sub-price">${esc(d.priceDisplay)}</span>`);
  parts.push(`<span class="tm-sub-evnum">${esc(d.eventNum)}</span>`);
  parts.push('</div>');
  parts.push('<div class="tm-event">');
  parts.push('<div class="tm-wm" aria-hidden="true">ticketmaster</div>');
  parts.push(`<p class="tm-promo">${esc(d.promo)}</p>`);
  parts.push(`<p class="tm-artist">${esc(d.artist)}</p>`);
  parts.push(`<p class="tm-tour">${esc(d.tour)}</p>`);
  parts.push(`<p class="tm-venue">${esc(d.venue)}</p>`);
  parts.push(`<p class="tm-disclaim">${esc(d.disclaimer)}</p>`);
  parts.push(`<p class="tm-datetime">${esc(d.datetime)}</p>`);
  parts.push('</div>');
  parts.push('</section>');

  // Right perforation + stub
  parts.push('<div class="tm-perf tm-perf-right" aria-hidden="true"></div>');
  parts.push('<aside class="tm-right">');
  parts.push(`<div class="tm-r-top">${esc(d.headerRight)}</div>`);
  parts.push('<div class="tm-r-toplbl">EVENT CODE</div>');
  parts.push(`<div class="tm-r-evnum">${esc(d.eventNum)}</div>`);
  parts.push(`<div class="tm-r-cn">${esc(d.cn)}</div>`);
  // Mini grid: 3 columns [blue tag | big value | aux text].
  //   SEC.  FLR 3   —
  //   ROW   14      CA404SJA   (auxRight, same horizontal line as ROW)
  //                 V 180.00   (priceRight, between ROW and SEAT rows)
  //   SEAT  [1]     —
  parts.push('<div class="tm-r-grid">');
  parts.push(`<span class="tm-r-tag">SEC.</span><span class="tm-r-val">${esc(d.section)}</span><span></span>`);
  parts.push(`<span class="tm-r-tag">ROW</span><span class="tm-r-val">${esc(d.row)}</span><span class="tm-r-side">${esc(d.auxRight)}</span>`);
  parts.push(`<span></span><span></span><span class="tm-r-side">${esc(d.priceRight)}</span>`);
  parts.push(`<span class="tm-r-tag">SEAT</span><span class="tm-r-val tm-r-seat-box">${esc(d.seat)}</span><span></span>`);
  parts.push('</div>');
  parts.push('<div class="tm-scan">');
  parts.push(renderBarcodeSvg(d.barcode));
  parts.push(`<span class="tm-barcode-num">${esc(d.barcode)}</span>`);
  parts.push('</div>');
  parts.push('<div class="tm-brand" aria-hidden="true">');
  parts.push('<span class="tm-logo">ticketmaster</span>');
  parts.push('<span class="tm-swoosh"></span>');
  parts.push('<span class="tm-brand-url">get tickets at ticketmaster.com</span>');
  parts.push('</div>');
  parts.push('<p class="tm-legal">NO EXCHANGE EXCEPT AS PROVIDED HEREIN. NO REFUNDS. NO REENTRY.</p>');
  parts.push('</aside>');

  parts.push('</article>');
  return parts.join('');
}
