/**
 * Real Ticket Stubs — client app.
 * @see TODO.md
 */
import {
  defaultFields,
  normalizeExtractedFields,
  prepareTicketData,
  buildTicketHtml,
} from "./templates.js";
import { validateShippingFormat } from "./shipping-validation.js";

const $ = (sel) => document.querySelector(sel);
const form = $("#ticket-form");

// API base URL. Defaults to same-origin (works when the whole app — frontend +
// backend — is served together, including inside a GoHighLevel iframe embed).
// To host the frontend on GoHighLevel and the backend elsewhere, set
// `window.RTS_CONFIG = { apiBase: "https://your-backend.example.com" }` before
// this script loads, and add that origin to ALLOWED_ORIGINS on the server.
const API_BASE = (window.RTS_CONFIG && window.RTS_CONFIG.apiBase
  ? String(window.RTS_CONFIG.apiBase)
  : ""
).replace(/\/$/, "");
const api = (path) => `${API_BASE}${path}`;

const state = {
  imageDataUrl: null,
  fields: defaultFields(),
};

function setStatus(msg, kind = "") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status ${kind}`.trim();
}

function readForm() {
  const data = new FormData(form);
  for (const [key, value] of data.entries()) {
    state.fields[key] = String(value).trim();
  }
  return state.fields;
}

function fillForm(fields) {
  if (!form) return;
  for (const [key, value] of Object.entries(fields)) {
    const input = form.elements.namedItem(key);
    if (input && "value" in input) {
      input.value = value ?? "";
    }
  }
}

function upper(s) {
  return String(s || "").toUpperCase();
}

function renderStub(fields) {
  const d = prepareTicketData(fields);
  const stage = $("#stub-stage");
  stage.innerHTML = buildTicketHtml(d);

  const svg = stage.querySelector(".tm-barcode");
  if (svg && window.JsBarcode) {
    JsBarcode(svg, d.barcode, {
      format: "CODE128",
      width: 1.8,
      height: 48,
      displayValue: false,
      margin: 0,
      background: "transparent",
      lineColor: "#000000",
    });
  }
}

/** Clone the ticket into an off-screen, full-size container so the export
 *  isn't affected by the preview transform: scale(0.5). */
function makeOffscreenClone() {
  const live = document.querySelector(".tm");
  if (!live) return null;
  const clone = live.cloneNode(true);
  clone.style.transform = "none";
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed; left:-99999px; top:0; width:1300px; height:589px; " +
    "background:#fff; overflow:hidden; z-index:-1;";
  host.appendChild(clone);
  document.body.appendChild(host);
  return { host, clone };
}

async function waitForFonts() {
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* no-op */
    }
  }
}

async function exportPng() {
  if (!window.htmlToImage) {
    setStatus("PNG renderer not loaded — check your network.", "err");
    return;
  }
  setStatus("Loading fonts...", "working");
  await waitForFonts();
  const ctx = makeOffscreenClone();
  if (!ctx) return;
  try {
    setStatus("Generating PNG...", "working");
    const dataUrl = await window.htmlToImage.toPng(ctx.clone, {
      width: 1300,
      height: 589,
      pixelRatio: 3,
      backgroundColor: "#ffffff",
      cacheBust: true,
      skipFonts: false,
    });
    const link = document.createElement("a");
    link.download = `ticketmaster-stub-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
    setStatus("PNG downloaded (3900x1767, 300dpi-equivalent).", "ok");
  } catch (e) {
    setStatus("PNG export failed: " + (e?.message || e), "err");
  } finally {
    ctx.host.remove();
  }
}

async function exportSvg() {
  if (!window.htmlToImage) {
    setStatus("SVG renderer not loaded.", "err");
    return;
  }
  setStatus("Loading fonts...", "working");
  await waitForFonts();
  const ctx = makeOffscreenClone();
  if (!ctx) return;
  try {
    setStatus("Generating SVG...", "working");
    const dataUrl = await window.htmlToImage.toSvg(ctx.clone, {
      width: 1300,
      height: 589,
      backgroundColor: "#ffffff",
      cacheBust: true,
    });
    const link = document.createElement("a");
    link.download = `ticketmaster-stub-${Date.now()}.svg`;
    link.href = dataUrl;
    link.click();
    setStatus("SVG downloaded (vector, print-perfect).", "ok");
  } catch (e) {
    setStatus("SVG export failed: " + (e?.message || e), "err");
  } finally {
    ctx.host.remove();
  }
}

function blankFields() {
  return {
    ticketCode: "",
    headerRight: "",
    section: "",
    row: "",
    seat: "",
    price: "",
    admissionType: "",
    aisle: "",
    eventNum: "",
    auxLeft: "",
    auxRight: "",
    orderCode: "",
    cn: "",
    promo: "",
    eventLine2: "",
    tour: "",
    venue: "",
    disclaimer: "",
    datetime: "",
    dateShort: "",
    barcode: "",
  };
}

export function parseOcrText(text) {
  // Normalize Unicode accents so "Sección" → "SECCION", "Día" → "DIA", etc.
  // Then alias common non-English equivalents to their English label.
  // Also repair common Tesseract mis-segmentations like "S EAT", "R O W",
  // "SEC TIO N" so the regexes below have a chance.
  let normalized = String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bSECCION\b/gi, "SECTION")
    .replace(/\bFILA\b/gi, "ROW")
    .replace(/\bASIENTO\b/gi, "SEAT");

  // Repair "S E C T I O N", "S EAT", "R O W" → "SECTION", "SEAT", "ROW".
  // These are common when Tesseract sees small spacing as a word break.
  normalized = normalized
    .replace(/\bS\s*E\s*C\s*T\s*I\s*O\s*N\b/gi, "SECTION")
    .replace(/\bS\s*E\s*A\s*T\s*S?\b/gi, "SEAT")
    .replace(/\bR\s*O\s*W\b/gi, "ROW")
    .replace(/\bSEC\.\s*T?ION/gi, "SECTION")
    .replace(/\bSEC\.?\s/gi, "SECTION ")
    .replace(/\bSE[AC]T(?:S|2)?\b/gi, "SEAT")
    // "ROW" sometimes OCRs as "ROVV" or "RDW"
    .replace(/\bROVV\b/gi, "ROW")
    .replace(/\bRDW\b/gi, "ROW")
    // Common Apple Wallet / Ticketmaster mobile labels
    .replace(/\bSEC\/AISLE\b/gi, "SECTION")
    .replace(/\bROW\/BOX\b/gi, "ROW");

  const lines = normalized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const joined = lines.join("\n");
  const fields = blankFields();

  // Datetime — handle many formats
  const dateMatch =
    joined.match(
      /(MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*,?\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+(?:AT\s+)?\d{1,2}:\d{2}\s*[AP]M?)?/i,
    ) ||
    joined.match(
      /(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+(?:AT\s+)?\d{1,2}:\d{2}\s*[AP]M?)?/i,
    ) ||
    joined.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}\s*[AP]M?)?/i) ||
    joined.match(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2})?/);
  if (dateMatch) {
    fields.datetime = upper(dateMatch[0].replace(/,/g, "").replace(/\s+AT\s+/i, " "));
  }

  const timeMatch = joined.match(/\b\d{1,2}:\d{2}\s*(AM|PM)\b/i);
  if (timeMatch && fields.datetime) {
    const hhmm = timeMatch[0].toUpperCase().replace(/\s+/g, " ");
    const dt = fields.datetime.toUpperCase();
    if (!dt.includes(hhmm) && !dt.includes(timeMatch[0].split(/\s/)[0])) {
      fields.datetime += ` ${upper(timeMatch[0])}`;
    }
  }

  // Section / row / seat — match many formats:
  //   "Sec 117 Row 14 Seat 1"        (any whitespace including newlines)
  //   "Section: 117  Row: 14  Seat: 1"
  //   "Sec 117 · Row 14 · Seat 1"    (any separator)
  //   "SECTION\n117\nROW\n14\nSEAT\n1"  (label/value on separate lines)
  const sep = "[\\s:.,|/·•\\-]*";
  const sectionRe = new RegExp(
    `\\bSEC(?:TION)?${sep}([A-Z0-9][A-Z0-9 .'-]{0,15})`, "i",
  );
  const rowRe = new RegExp(
    `\\bROW${sep}([A-Z0-9][A-Z0-9-]{0,5})`, "i",
  );
  const seatRe = new RegExp(
    `\\bSEAT(?:S)?${sep}(\\d{1,4}[A-Z]?)`, "i",
  );

  // Reject reserved label words that occasionally bleed into captures
  // from compact label rows like "SECTION/AISLE ROW/BOX SEAT".
  const reserved = new Set([
    "AISLE", "ROW", "BOX", "SEAT", "SEATS", "ADMISSION",
    "EVENT", "CODE", "TICKET", "ORDER", "FILA", "ASIENTO",
  ]);
  const cleanCapture = (s) => {
    const t = upper(s).trim().replace(/[/:.,]+$/, "");
    const first = t.split(/\s+/)[0];
    if (reserved.has(first)) return "";
    // Truncate at the first reserved word — e.g. "117 ROW 14" → "117".
    const parts = t.split(/\s+/);
    const stopAt = parts.findIndex((w, i) => i > 0 && reserved.has(w));
    return stopAt > 0 ? parts.slice(0, stopAt).join(" ") : t;
  };

  const secM = joined.match(sectionRe);
  if (secM) fields.section = cleanCapture(secM[1]);
  const rowM = joined.match(rowRe);
  if (rowM) fields.row = cleanCapture(rowM[1]);
  const seatM = joined.match(seatRe);
  if (seatM) fields.seat = cleanCapture(seatM[1]);

  // Inline triple "Sec 117 · Row 14 · Seat 1" form — stronger match than singles
  const tripleInline = joined.match(
    /SEC(?:TION)?[:\s]+([A-Z0-9 -]+?)[\s,|·•/-]+ROW[:\s]+([A-Z0-9-]+)[\s,|·•/-]+SEAT[S]?[:\s]+(\d+[A-Z]?)/i,
  );
  if (tripleInline) {
    fields.section = upper(tripleInline[1]).trim();
    fields.row = upper(tripleInline[2]);
    fields.seat = upper(tripleInline[3]);
  }

  // Section/Row/Seat shown stacked as label\n(blank?)\nvalue (mobile UI style).
  // Some apps insert blank lines or extra noise between label and value, so we
  // scan up to 3 lines forward looking for the first plausible value.
  const isLabel = (s, want) => {
    const t = s.replace(/[:.()]+$/, "").trim().toUpperCase();
    if (Array.isArray(want)) return want.includes(t);
    return t === want;
  };
  const nextValue = (start, validator) => {
    for (let j = start + 1; j <= Math.min(start + 3, lines.length - 1); j++) {
      const v = lines[j].trim();
      if (v && validator(v)) return v;
    }
    return "";
  };
  for (let i = 0; i < lines.length; i++) {
    if (!fields.section && isLabel(lines[i], ["SECTION", "SEC", "SEC."])) {
      const v = nextValue(i, (x) => /^[A-Z0-9][A-Z0-9 .'-]{0,12}$/i.test(x));
      if (v) fields.section = upper(v);
    }
    if (!fields.row && isLabel(lines[i], ["ROW", "FILA"])) {
      const v = nextValue(i, (x) => /^[A-Z0-9-]{1,6}$/i.test(x));
      if (v) fields.row = upper(v);
    }
    if (!fields.seat && isLabel(lines[i], ["SEAT", "SEATS", "ASIENTO"])) {
      const v = nextValue(i, (x) => /^\d{1,4}[A-Z]?$/i.test(x));
      if (v) fields.seat = upper(v);
    }
  }

  // General Admission: many tickets just say "GENERAL ADMISSION" or "GA".
  // Treat them as section="GA" with empty row/seat unless we found explicit ones.
  if (!fields.section && /\b(GENERAL\s+ADMISSION|GEN\s+ADM)\b/i.test(joined)) {
    fields.section = "GA";
  }
  if (!fields.section && /\bGA\b(?!\s*\d{4})/i.test(joined)) {
    fields.section = "GA";
  }

  // Tabular Ticketmaster thermal-scan layout — values ABOVE labels:
  //   line N:   FLR 3   14   1   VAUCTN   ESJ0718
  //   line N+1: SECTION/AISLE  ROW/BOX  SEAT  ADMISSION  EVENT CODE
  // When we see a label line containing both SECTION/AISLE and ROW/BOX,
  // take the previous line and pair tokens left-to-right with the labels.
  for (let i = 1; i < lines.length; i++) {
    const upperLine = lines[i].toUpperCase();
    if (
      upperLine.includes("SECTION") &&
      upperLine.includes("ROW") &&
      upperLine.includes("SEAT")
    ) {
      const labels = upperLine.split(/\s{2,}|\t+/).filter(Boolean);
      const values = lines[i - 1]
        .toUpperCase()
        .split(/\s{2,}|\t+/)
        .filter(Boolean);
      if (labels.length === values.length && labels.length >= 3) {
        labels.forEach((lab, idx) => {
          const val = values[idx]?.trim();
          if (!val) return;
          if (/SECTION|AISLE/.test(lab) && !fields.section) fields.section = val;
          if (/ROW|BOX/.test(lab) && !fields.row) fields.row = val.replace(/^ROW\s*/i, "");
          if (/^SEAT/.test(lab) && !fields.seat) fields.seat = val.replace(/^SEAT\s*/i, "");
        });
      }
      break;
    }
  }

  // Price and barcode
  const priceMatch = joined.match(/\$\s*(\d+\.\d{2})/) || joined.match(/\b(\d{2,4}\.\d{2})\b/);
  if (priceMatch) fields.price = priceMatch[1];

  // Barcode: 10–18 digit run, preferring the longest one (so we skip event#)
  const allDigitRuns = (joined.match(/\b\d{10,18}\b/g) || []).slice().sort(
    (a, b) => b.length - a.length,
  );
  if (allDigitRuns.length) fields.barcode = allDigitRuns[0];

  // Promo URL
  const www = joined.match(/WWW\.[A-Z0-9.]+\.COM/i);
  if (www) fields.promo = upper(www[0]);

  // Aisle (e.g. AISLE 26)
  const aisle = joined.match(/\bAISLE\s+\d+\b/i);
  if (aisle) fields.aisle = upper(aisle[0]);

  // CN code
  const cn = joined.match(/\bCN\s+\d+\b/i);
  if (cn) fields.cn = upper(cn[0]);

  // Event number (7+ digit run that isn't the barcode)
  for (const line of lines) {
    const num = line.match(/\b(\d{6,8})\b/);
    if (num && num[1] !== fields.barcode) {
      fields.eventNum = num[1];
      break;
    }
  }

  // Short date (e.g. 18JUL08)
  const ds = joined.match(/\b(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})\b/i);
  if (ds) fields.dateShort = upper(ds[0]);

  // Ticket code (e.g. SJ0718) and header right (e.g. ESJ0718)
  const headerEcode = joined.match(/\bE([A-Z]{2}\d{3,5})\b/);
  if (headerEcode) {
    fields.headerRight = "E" + upper(headerEcode[1]);
    fields.ticketCode = upper(headerEcode[1]);
  } else {
    const code = joined.match(/\b([A-Z]{2}\d{3,5})\b/);
    if (code) fields.ticketCode = upper(code[1]);
  }

  // Admission code (single all-caps word 4-8 chars, common: VAUCTN, GENADM)
  const adm = joined.match(/\b(VAUCTN|GENADM|GENERAL|FLOOR|RESERVED|VIP)\b/i);
  if (adm) fields.admissionType = upper(adm[0]);

  // Venue
  const venueMatch = joined.match(
    /([A-Z][A-Z0-9 .'-]+(?:ARENA|CENTER|CENTRE|THEATRE|THEATER|STADIUM|HALL|GARDEN|AMPHITHEATRE|AMPHITHEATER|PAVILION|COLISEUM|DOME|FIELD)[A-Z0-9 .,-]*)/i,
  );
  if (venueMatch) fields.venue = upper(venueMatch[1].slice(0, 60)).trim();

  // Disclaimer (NO X OR Y form)
  const disclaim = joined.match(/\bNO\s+[A-Z]+(?:\s+OR\s+[A-Z]+)?\b/i);
  if (disclaim && !/REFUNDS|REENTRY|EXCHANGE/i.test(disclaim[0])) {
    fields.disclaimer = upper(disclaim[0]);
  }

  // Artist / tour heuristic: prefer lines with only letters (and spaces),
  // 3-30 chars, NOT containing digits (Ticketmaster codes have digits).
  const skip = new Set([
    "TICKET","MOBILE","ENTRY","GATE","BARCODE","ORDER","TOTAL",
    "TAX","FEE","USD","CAD","PRINT","HOME","DETAILS","VIEW",
    "EVENT","CODE","SECTION","AISLE","ROW","BOX","SEAT","ADMISSION",
    "CONVENIENCE","CHARGE","CAMERAS","RECORDERS","NO","OR",
    "TICKETMASTER","LIVENATION","EXCHANGE","REFUNDS","REENTRY",
    "PROVIDED","HEREIN","EXCEPT","GET","TICKETS","AT",
  ]);
  const isClean = (line) =>
    /^[A-Z][A-Z .'&-]+[A-Z]$/i.test(line) &&
    line.length >= 4 && line.length <= 40 &&
    !line.split(/\s+/).every((w) => skip.has(upper(w)));

  const cleanLines = lines.map(upper).filter(isClean);

  // Artist: shortest clean line with no "TOUR/VENUE/etc" keywords
  let artist = cleanLines.find(
    (l) => !/TOUR|PAVILION|ARENA|CENTER|CENTRE|THEATRE|THEATER|STADIUM|HALL|GARDEN|PAVILION|COLISEUM|HP |WWW|WORLD|PRESENTS/.test(l),
  );
  if (artist) fields.eventLine2 = artist;

  // Tour: line with tour-ish keyword (skip URLs and venues we already grabbed)
  const tourLine = cleanLines.find((l) => {
    if (l === artist || l === fields.venue) return false;
    if (/^WWW\.|\.COM$/.test(l)) return false;
    return /\b(TOUR|WORLD\s+TOUR|PRESENTS|VIVA|LIVE\s|TRIBUTE|REUNION|FAREWELL)\b/.test(l);
  });
  if (tourLine) fields.tour = tourLine;

  // auxLeft / auxRight / orderCode patterns (uppercase + digits)
  const codes = joined.match(/\b[A-Z]{1,3}\d{3,7}[A-Z]?\b/g) || [];
  const codeQueue = codes.filter(
    (c) => c !== fields.ticketCode && !c.startsWith("E" + fields.ticketCode),
  );
  if (codeQueue[0]) fields.orderCode = codeQueue[0];
  if (codeQueue[1]) fields.auxRight = codeQueue[1];

  // Aux left like "CA  6X"
  const auxL = joined.match(/\bCA\s+\d+[A-Z]?\b/);
  if (auxL) fields.auxLeft = upper(auxL[0]);

  return fields;
}

/** Preprocess the screenshot to give Tesseract a fighting chance:
 *  1. Upscale small images so labels like "ROW" / "SEAT" are at least 60px tall.
 *  2. Light contrast bump on a grayscale copy (helps low-contrast thermal text
 *     and faint mobile UI labels).
 *  Returns a new data URL (or the original if no canvas/Image support). */
async function preprocessForOcr(dataUrl) {
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = dataUrl;
    });

    // Target a long side of ~2000px — Tesseract sweetspot.
    const longSide = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longSide < 2000 ? Math.min(3, 2000 / longSide) : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    // Grayscale + contrast bump. Pixel-level loop is fine for sub-10MP images.
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      const c = Math.max(0, Math.min(255, (g - 128) * 1.25 + 128));
      d[i] = d[i + 1] = d[i + 2] = c;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL("image/png");
  } catch (e) {
    console.warn("preprocessForOcr failed, falling back to original:", e);
    return dataUrl;
  }
}

async function runOcr(dataUrl) {
  setStatus("Preparing image for OCR...", "working");
  const processed = await preprocessForOcr(dataUrl);
  setStatus("Reading text from image (OCR)...", "working");
  // PSM 6 = "Assume a single uniform block of text." Works better than the
  // default PSM 3 on ticket grids where labels and values are misaligned.
  const result = await Tesseract.recognize(processed, "eng", {
    logger: (m) => {
      if (m.status === "recognizing text" && m.progress) {
        setStatus(`OCR ${Math.round(m.progress * 100)}%...`, "working");
      }
    },
    tessedit_pageseg_mode: 6,
  });
  return result.data.text;
}

async function runVision(dataUrl) {
  const res = await fetch(api("/api/extract"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err.error || `Server error ${res.status}`;
    const e = new Error(message);
    e.code = err.code;
    throw e;
  }
  return res.json();
}

function handleFile(file) {
  if (!file?.type?.startsWith("image/")) {
    setStatus("Please choose an image file.", "err");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.imageDataUrl = reader.result;
    $("#source-preview").src = state.imageDataUrl;
    $("#source-preview-wrap").classList.remove("hidden");
    $("#extract-btn").disabled = false;
    setStatus("Image loaded. Click Extract details.", "ok");
  };
  reader.readAsDataURL(file);
}

/** Merge two field objects: `primary` wins for non-empty values; `secondary`
 *  fills any blanks. Both are plain {key: string} maps. */
function mergeFields(primary, secondary) {
  const out = { ...secondary };
  for (const [k, v] of Object.entries(primary || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      out[k] = String(v).trim();
    }
  }
  return out;
}

/** Run server vision + browser OCR in parallel. Vision wins on conflicts;
 *  OCR fills gaps (especially section / row / seat). If the server has no
 *  API key configured, vision fails quietly and OCR results are used alone. */
async function extract() {
  if (!state.imageDataUrl) return;
  const extractBtn = $("#extract-btn");
  extractBtn.disabled = true;
  try {
    setStatus("Reading ticket details...", "working");
    const [visionRes, ocrText] = await Promise.allSettled([
      runVision(state.imageDataUrl),
      runOcr(state.imageDataUrl),
    ]);
    const visionFields = visionRes.status === "fulfilled" ? visionRes.value : {};
    const ocrFields =
      ocrText.status === "fulfilled" ? parseOcrText(ocrText.value) : {};
    const merged = mergeFields(visionFields, ocrFields);
    const fields = normalizeExtractedFields(merged);

    if (visionRes.status === "rejected") {
      console.warn("Server extract unavailable:", visionRes.reason);
    }

    state.fields = { ...blankFields(), ...fields };
    $("#edit-panel").classList.remove("hidden");
    fillForm(state.fields);
    // Render from state.fields (source of truth) and sync form → stub again.
    renderStub(state.fields);
    requestAnimationFrame(() => renderStub(readForm()));

    console.log("[extract] final fields:", state.fields);

    const required = ["section", "row", "seat", "eventLine2", "datetime"];
    const missing = required.filter((k) => !(state.fields[k] || "").trim());
    const seatMissing = ["section", "row", "seat"].filter((k) => !(state.fields[k] || "").trim());

    if (missing.length === 0) {
      const summary = ["section", "row", "seat"]
        .map((k) => `${k}=${state.fields[k]}`).join(", ");
      setStatus(`Details extracted (${summary}) — review and print.`, "ok");
    } else if (seatMissing.length >= 2) {
      setStatus(
        `Couldn't read ${seatMissing.join(" / ")} from this image. ` +
          `Fill those fields in step 2 to complete your stub.`,
        "warn",
      );
    } else {
      setStatus(
        `Extracted ${Object.values(state.fields).filter(Boolean).length} fields. ` +
          `Could not read: ${missing.join(", ")}. Edit fields below to complete.`,
        "warn",
      );
    }
  } catch (e) {
    setStatus(e.message || "Extraction failed.", "err");
  } finally {
    extractBtn.disabled = false;
  }
}

function initUpload() {
  const dropzone = $("#dropzone");
  const input = $("#file-input");
  const uploadBtn = $("#upload-btn");

  if (uploadBtn) {
    uploadBtn.addEventListener("click", () => input.click());
  }

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) handleFile(file);
  });
}

function initActions() {
  $("#extract-btn").addEventListener("click", () => extract());
  $("#render-btn").addEventListener("click", () => {
    renderStub(readForm());
    setStatus("Stub updated.", "ok");
  });
  $("#print-btn").addEventListener("click", () => openOrderModal());
  $("#download-btn").addEventListener("click", () => exportPng());
  $("#download-svg-btn")?.addEventListener("click", () => exportSvg());

  form.addEventListener("input", () => {
    renderStub(readForm());
  });
}

// ───────────────────────── Order modal ─────────────────────────
// Multi-step flow triggered by the "Print stub" button:
//   choose  → print at home (free)  or  mail a stub ($3.99)  or  framed ($29.99)
//   address → shipping form, validated client + server
//   pay     → redirect to Stripe-hosted Checkout
//   success → confirmation # + masked address
// TODO(production): Address autocomplete on street1 (Google Places / Mapbox).

// Product catalog — keep in sync with PRODUCTS in server.mjs.
const PRODUCTS = {
  mail: { label: "Printed stub mailed (1x)", price: 3.99 },
  framed: { label: "Framed stub for the wall (1x)", price: 29.99 },
};
const money = (n) => `$${Number(n).toFixed(2)}`;
const order = { product: null, shipping: null, confirmation: null };

// Stripe Payment Links — loaded from the server (/api/config), which reads
// STRIPE_PAYMENT_LINK_MAIL and STRIPE_PAYMENT_LINK_FRAMED from .env.
// Never hardcode link URLs here; they would be committed to git.
let paymentLinks = { mail: "", framed: "" };
const isStripeLink = (u) => {
  if (typeof u !== "string") return false;
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" && /(^|\.)stripe\.com$/i.test(hostname);
  } catch {
    return false;
  }
};

async function loadAppConfig() {
  try {
    const res = await fetch(api("/api/config"));
    if (!res.ok) return;
    const cfg = await res.json().catch(() => ({}));
    if (cfg.paymentLinks && typeof cfg.paymentLinks === "object") {
      paymentLinks = { ...paymentLinks, ...cfg.paymentLinks };
    }
  } catch (e) {
    console.warn("Could not load payment link config:", e);
  }
}

// Navigate to Stripe. If we're inside an iframe (e.g. embedded in GoHighLevel),
// break out to the top window — Stripe-hosted pages refuse to load in iframes.
function goToStripe(url) {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = url;
      return;
    }
  } catch {
    /* cross-origin top: fall through to same-window navigation */
  }
  window.location.href = url;
}

function openOrderModal() {
  const modal = $("#order-modal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  showStep("choose");
  document.body.style.overflow = "hidden";
}

function closeOrderModal() {
  const modal = $("#order-modal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function showStep(name) {
  document.querySelectorAll("#order-modal .modal-step").forEach((el) => {
    el.hidden = el.dataset.step !== name;
  });
}

function markInvalid(form) {
  let firstBad = null;
  for (const input of form.querySelectorAll("input[required], select[required]")) {
    const empty = !input.value.trim();
    input.setAttribute("aria-invalid", empty ? "true" : "false");
    if (empty && !firstBad) firstBad = input;
  }
  if (firstBad) firstBad.focus();
  return !firstBad;
}

function clearAddressFieldErrors(form) {
  const banner = $("#address-form-banner");
  if (banner) {
    banner.textContent = "";
    banner.classList.add("hidden");
  }
  for (const el of form.querySelectorAll(".field-error")) {
    el.textContent = "";
    el.hidden = true;
  }
  for (const input of form.querySelectorAll("input, select")) {
    input.removeAttribute("aria-invalid");
  }
}

function showAddressFieldErrors(form, errors) {
  clearAddressFieldErrors(form);
  const banner = $("#address-form-banner");
  let firstInput = null;

  for (const [field, message] of Object.entries(errors || {})) {
    if (field === "_form") {
      if (banner) {
        banner.textContent = message;
        banner.classList.remove("hidden");
      }
      continue;
    }
    const errEl = form.querySelector(`[data-error-for="${field}"]`);
    const input = form.elements.namedItem(field);
    if (errEl) {
      errEl.textContent = message;
      errEl.hidden = false;
    }
    if (input) {
      input.setAttribute("aria-invalid", "true");
      if (!firstInput) firstInput = input;
    }
  }
  if (firstInput) firstInput.focus();
  else if (banner && !banner.classList.contains("hidden")) banner.focus?.();
}

async function validateShippingWithServer(data) {
  const res = await fetch(api("/api/validate-shipping"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.errors?._form || json.error || "Address verification failed.");
  }
  return json;
}

function readFormData(form) {
  const data = {};
  for (const [k, v] of new FormData(form).entries()) data[k] = String(v).trim();
  return data;
}

/** Create a Stripe Checkout Session for the chosen product and return either
 *  { url } (redirect to Stripe) or { mock, confirmation } (demo fallback when
 *  the server has no STRIPE_SECRET_KEY configured). */
async function createCheckoutSession() {
  const payload = {
    product: order.product,
    shipping: order.shipping,
    item: {
      artist: state.fields.eventLine2 || "",
      venue: state.fields.venue || "",
      datetime: state.fields.datetime || "",
    },
  };

  const res = await fetch(api("/api/create-checkout-session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 400 && json.errors) {
    const err = new Error(json.error || "Shipping address could not be verified.");
    err.errors = json.errors;
    throw err;
  }
  if (!res.ok) {
    throw new Error(json.error || `Checkout failed (${res.status})`);
  }
  return json;
}

function initOrderModal() {
  const modal = $("#order-modal");
  if (!modal) return;

  modal.addEventListener("click", (e) => {
    if (e.target.matches("[data-close]")) closeOrderModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeOrderModal();
  });

  // Step 1 — choice.
  modal.querySelector('.choice[data-action="print"]').addEventListener("click", () => {
    closeOrderModal();
    setTimeout(() => window.print(), 60);
  });
  modal.querySelectorAll('.choice[data-action="order"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const productKey = btn.dataset.product;
      if (!PRODUCTS[productKey]) return;
      order.product = productKey;

      // If a Stripe Payment Link is configured for this product, hand off to it.
      // Stripe collects the shipping address, email, and payment, then redirects
      // back to the URL configured on the link.
      const link = paymentLinks[productKey];
      if (isStripeLink(link)) {
        closeOrderModal();
        goToStripe(link);
        return;
      }

      // Otherwise fall back to in-app address verification + API Checkout.
      updatePaySummary();
      showStep("address");
    });
  });

  // Back buttons on address + pay.
  modal.querySelectorAll("[data-back]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const step = btn.closest(".modal-step")?.dataset.step;
      if (step === "address") showStep("choose");
      else if (step === "pay") showStep("address");
    });
  });

  // Step 2 — shipping address (format check, then server: email MX + postal API).
  $("#address-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    clearAddressFieldErrors(form);
    if (!markInvalid(form)) return;

    const data = readFormData(form);
    const format = validateShippingFormat(data);
    if (!format.valid) {
      showAddressFieldErrors(form, format.errors);
      return;
    }

    const btn = $("#address-continue-btn");
    const prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Verifying address…";
    try {
      const result = await validateShippingWithServer(data);
      if (!result.valid) {
        showAddressFieldErrors(form, result.errors);
        return;
      }
      order.shipping = result.normalized;
      showStep("pay");
    } catch (err) {
      showAddressFieldErrors(form, {
        _form: err.message || "Could not verify address. Try again.",
      });
    } finally {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  });

  // Clear field errors as the user edits the address form.
  $("#address-form")?.addEventListener("input", (e) => {
    const form = e.target.closest("#address-form");
    if (!form) return;
    const name = e.target.name;
    if (!name) return;
    const errEl = form.querySelector(`[data-error-for="${name}"]`);
    if (errEl) {
      errEl.textContent = "";
      errEl.hidden = true;
    }
    e.target.removeAttribute("aria-invalid");
  });

  // Step 3 — payment via Stripe-hosted Checkout.
  $("#pay-btn").addEventListener("click", async () => {
    const payBtn = $("#pay-btn");
    const payErr = $("#pay-error");
    payErr.textContent = "";
    payErr.classList.add("hidden");
    payBtn.disabled = true;
    payBtn.textContent = "Starting secure checkout…";
    try {
      const result = await createCheckoutSession();
      if (result.url) {
        // Hand off to Stripe's hosted payment page (breaks out of an iframe).
        goToStripe(result.url);
        return;
      }
      // Demo fallback (no STRIPE_SECRET_KEY configured on the server).
      order.confirmation = result.confirmation;
      showSuccess({
        confirmation: result.confirmation,
        email: order.shipping?.email,
      });
    } catch (err) {
      if (err?.errors) {
        showStep("address");
        showAddressFieldErrors($("#address-form"), err.errors);
      } else {
        payErr.textContent = err?.message || "Could not start checkout. Try again.";
        payErr.classList.remove("hidden");
      }
    } finally {
      payBtn.disabled = false;
      payBtn.textContent = "Pay with Stripe";
    }
  });
}

/** Update the order summary shown on the payment step from the chosen product. */
function updatePaySummary() {
  const p = PRODUCTS[order.product];
  if (!p) return;
  const price = money(p.price);
  const label = $("#pay-summary-label");
  const sPrice = $("#pay-summary-price");
  const total = $("#pay-summary-total");
  const payBtn = $("#pay-btn");
  if (label) label.textContent = p.label;
  if (sPrice) sPrice.textContent = price;
  if (total) total.textContent = price;
  if (payBtn) payBtn.textContent = "Pay with Stripe";
}

/** Render the success step (used by both Stripe return + demo fallback). */
function showSuccess({ confirmation, email, charged }) {
  $("#success-confirm").textContent = confirmation || "—";
  $("#success-email").textContent = email || order.shipping?.email || "your email";
  const s = order.shipping || {};
  const addr =
    `${s.name || ""}, ${s.street1 || ""}${s.street2 ? ", " + s.street2 : ""}, ${s.city || ""} ${s.state || ""} ${s.zip || ""}`
      .replace(/\s+/g, " ")
      .trim();
  $("#success-address").textContent = addr.replace(/^,\s*/, "") || "—";
  const chargedEl = $("#success-charged");
  if (chargedEl) {
    const fallback = order.product ? money(PRODUCTS[order.product].price) : "—";
    chargedEl.textContent = charged || fallback;
  }
  const modal = $("#order-modal");
  if (!modal.classList.contains("open")) openOrderModal();
  showStep("success");
}

/** After Stripe redirects back to /?checkout=success|cancel, show the result. */
async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("checkout");
  if (!status) return;

  // Clean the query string so a refresh doesn't re-trigger this.
  window.history.replaceState({}, document.title, window.location.pathname);

  if (status === "cancel") {
    setStatus("Checkout canceled — your card was not charged.", "warn");
    return;
  }
  if (status !== "success") return;

  let info = {};
  const sessionId = params.get("session_id");
  if (sessionId) {
    try {
      const res = await fetch(api(`/api/checkout-session?id=${encodeURIComponent(sessionId)}`));
      info = await res.json().catch(() => ({}));
    } catch {
      /* best-effort */
    }
  }
  if (info.product && PRODUCTS[info.product]) order.product = info.product;
  showSuccess({
    confirmation: info.confirmation || "PAID",
    email: info.email,
    charged: typeof info.amountTotal === "number" ? money(info.amountTotal / 100) : undefined,
  });
}

(async () => {
  await loadAppConfig();
  initUpload();
  initActions();
  initOrderModal();
  fillForm(state.fields);
  renderStub(state.fields);
  handleCheckoutReturn();
})();
