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
  if (svg && window.JsBarcode && d.barcode) {
    try {
      JsBarcode(svg, d.barcode, {
        format: "CODE128",
        width: 1.8,
        height: 48,
        displayValue: false,
        margin: 0,
        background: "transparent",
        lineColor: "#000000",
      });
    } catch (e) {
      console.warn("JsBarcode skipped:", e?.message || e);
    }
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
    let ocrFields = {};
    if (ocrText.status === "fulfilled") {
      try {
        ocrFields = parseOcrText(ocrText.value);
      } catch (e) {
        console.warn("OCR parse failed:", e);
      }
    }
    const merged = mergeFields(visionFields, ocrFields);
    const fields = normalizeExtractedFields(merged);

    if (visionRes.status === "rejected") {
      console.warn("Server extract unavailable:", visionRes.reason);
    }
    if (ocrText.status === "rejected") {
      console.warn("Browser OCR unavailable:", ocrText.reason);
    }

    const hasExtractedData = Object.values(fields).some((v) => String(v || "").trim());
    if (!hasExtractedData && visionRes.status === "rejected" && ocrText.status === "rejected") {
      const reason = visionRes.reason?.message || ocrText.reason?.message || "Extraction failed.";
      throw new Error(reason);
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

// ───────────────────────── Order modal + cart ─────────────────────────
// Multi-step flow: shop/cart → address → Stripe Checkout → success.
// Cart supports multiple products and quantities; checkout uses API Sessions
// (not Payment Links — those only support one product at a time).

const MAX_CART_QTY = 99;

// Product catalog — keep in sync with PRODUCTS in server.mjs.
const PRODUCTS = {
  mail: {
    label: "Printed stub — mailed",
    shortLabel: "Mailed stub",
    price: 3.99,
    amount: 399,
  },
  framed: {
    label: "Framed stub for the wall",
    shortLabel: "Framed stub",
    price: 29.99,
    amount: 2999,
  },
};
const money = (n) => `$${Number(n).toFixed(2)}`;

/** @type {{ product: string, quantity: number }[]} */
const cart = [];
const order = { confirmation: null };

function clampQty(n) {
  return Math.min(MAX_CART_QTY, Math.max(1, Math.floor(Number(n) || 1)));
}

function readQtyInput(input) {
  return clampQty(input?.value);
}

function cartLineTotal(item) {
  const p = PRODUCTS[item.product];
  return p ? p.price * item.quantity : 0;
}

function cartGrandTotal() {
  return cart.reduce((sum, item) => sum + cartLineTotal(item), 0);
}

function cartItemLabel(item) {
  const p = PRODUCTS[item.product];
  if (!p) return item.product;
  return `${p.shortLabel} × ${item.quantity}`;
}

function findCartIndex(productKey) {
  return cart.findIndex((item) => item.product === productKey);
}

function addToCart(productKey, quantity) {
  if (!PRODUCTS[productKey]) return;
  const qty = clampQty(quantity);
  const idx = findCartIndex(productKey);
  if (idx >= 0) cart[idx].quantity = clampQty(cart[idx].quantity + qty);
  else cart.push({ product: productKey, quantity: qty });
  renderCart();
}

function setCartQty(productKey, quantity) {
  const idx = findCartIndex(productKey);
  if (idx < 0) return;
  const qty = clampQty(quantity);
  cart[idx].quantity = qty;
  renderCart();
}

function removeFromCart(productKey) {
  const idx = findCartIndex(productKey);
  if (idx >= 0) cart.splice(idx, 1);
  renderCart();
}

function renderCart() {
  const panel = $("#cart-panel");
  const list = $("#cart-lines");
  const totalEl = $("#cart-total");
  if (!panel || !list) return;

  if (!cart.length) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    if (totalEl) totalEl.textContent = money(0);
    return;
  }

  panel.classList.remove("hidden");
  list.innerHTML = cart
    .map((item) => {
      const p = PRODUCTS[item.product];
      if (!p) return "";
      return `<li class="cart-line" data-product="${item.product}">
        <span class="cart-line-label">${p.shortLabel}</span>
        <span class="cart-line-price">${money(cartLineTotal(item))}</span>
        <button type="button" class="cart-line-remove" data-remove-cart="${item.product}">Remove</button>
        <div class="qty-control" aria-label="Quantity for ${p.shortLabel}">
          <button type="button" class="qty-btn" data-cart-qty-delta="-1" data-product="${item.product}" aria-label="Decrease">−</button>
          <input type="number" class="qty-input cart-qty-input" data-product="${item.product}" value="${item.quantity}" min="1" max="${MAX_CART_QTY}" inputmode="numeric" aria-label="Quantity" />
          <button type="button" class="qty-btn" data-cart-qty-delta="1" data-product="${item.product}" aria-label="Increase">+</button>
        </div>
      </li>`;
    })
    .join("");

  if (totalEl) totalEl.textContent = money(cartGrandTotal());
}

async function loadAppConfig() {
  try {
    const res = await fetch(api("/api/config"));
    if (!res.ok) return;
    await res.json().catch(() => ({}));
  } catch (e) {
    console.warn("Could not load app config:", e);
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
  renderCart();
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

/** Create a Stripe Checkout Session for the cart and return either
 *  { url } (redirect to Stripe) or { mock, confirmation } (demo fallback). */
async function createCheckoutSession() {
  const payload = {
    cart: cart.map((item) => ({ product: item.product, quantity: item.quantity })),
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
  if (!res.ok) {
    throw new Error(json.error || `Checkout failed (${res.status})`);
  }
  return json;
}

/** Cart → Stripe Checkout (address + payment collected on Stripe's page). */
async function startCheckout() {
  const btn = $("#cart-checkout-btn");
  const errEl = $("#cart-checkout-error");
  if (!cart.length) {
    setStatus("Add at least one item to your cart.", "warn");
    return;
  }
  if (errEl) {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }
  const prevLabel = btn?.textContent || "Checkout with Stripe";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Redirecting to Stripe…";
  }
  try {
    const result = await createCheckoutSession();
    if (result.url) {
      goToStripe(result.url);
      return;
    }
    // Demo fallback (no STRIPE_SECRET_KEY on the server).
    order.confirmation = result.confirmation;
    showSuccess({
      confirmation: result.confirmation,
      charged: money(cartGrandTotal()),
    });
    cart.length = 0;
    renderCart();
  } catch (err) {
    const msg = err?.message || "Could not start checkout. Try again.";
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove("hidden");
    } else {
      setStatus(msg, "err");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }
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

  // Step 1 — print at home or build cart.
  modal.querySelector('.choice[data-action="print"]')?.addEventListener("click", () => {
    closeOrderModal();
    setTimeout(() => window.print(), 60);
  });

  modal.querySelectorAll(".shop-product").forEach((row) => {
    const productKey = row.dataset.product;
    const qtyInput = row.querySelector(".qty-input");
    if (!PRODUCTS[productKey] || !qtyInput) return;

    row.querySelectorAll("[data-qty-delta]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = Number(btn.dataset.qtyDelta);
        qtyInput.value = String(clampQty(readQtyInput(qtyInput) + delta));
      });
    });

    qtyInput.addEventListener("change", () => {
      qtyInput.value = String(readQtyInput(qtyInput));
    });

    row.querySelector(".btn-add-cart")?.addEventListener("click", () => {
      addToCart(productKey, readQtyInput(qtyInput));
      qtyInput.value = "1";
    });
  });

  $("#cart-lines")?.addEventListener("click", (e) => {
    const removeKey = e.target.closest("[data-remove-cart]")?.dataset.removeCart;
    if (removeKey) {
      removeFromCart(removeKey);
      return;
    }
    const deltaBtn = e.target.closest("[data-cart-qty-delta]");
    if (deltaBtn) {
      const productKey = deltaBtn.dataset.product;
      const idx = findCartIndex(productKey);
      if (idx < 0) return;
      const delta = Number(deltaBtn.dataset.cartQtyDelta);
      setCartQty(productKey, cart[idx].quantity + delta);
    }
  });

  $("#cart-lines")?.addEventListener("change", (e) => {
    const input = e.target.closest(".cart-qty-input");
    if (!input) return;
    setCartQty(input.dataset.product, readQtyInput(input));
  });

  $("#cart-checkout-btn")?.addEventListener("click", () => startCheckout());
}

/** Render the success step (used by both Stripe return + demo fallback). */
function showSuccess({ confirmation, email, charged, address }) {
  $("#success-confirm").textContent = confirmation || "—";
  $("#success-email").textContent = email || "your email";
  $("#success-address").textContent = address || "—";
  const chargedEl = $("#success-charged");
  if (chargedEl) {
    chargedEl.textContent = charged || (cart.length ? money(cartGrandTotal()) : "—");
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
  showSuccess({
    confirmation: info.confirmation || "PAID",
    email: info.email,
    address: info.shippingAddress || "",
    charged: typeof info.amountTotal === "number" ? money(info.amountTotal / 100) : undefined,
  });
  cart.length = 0;
  renderCart();
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
