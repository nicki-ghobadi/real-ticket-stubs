#!/usr/bin/env node
/**
 * Browser test: full-size PNG export has correct dimensions and no overlapping text.
 *
 *   node scripts/test-png-export.mjs
 *   node scripts/test-png-export.mjs --base=http://localhost:3456
 */
import { chromium } from "playwright";

const base = (
  process.argv.find((a) => a.startsWith("--base="))?.split("=")[1]
  || "http://localhost:3456"
).replace(/\/$/, "");

const LONG_FIELDS = {
  promo: "WWW.TICKETMASTER.COM",
  eventLine2: "COLDPLAY MUSIC OF THE SPHERES WORLD TOUR EXTRA LONG",
  tour: "MUSIC OF THE SPHERES WORLD TOUR 2026 NORTH AMERICA",
  venue: "HP PAVILION AT SAN JOSE CALIFORNIA DOWNTOWN ARENA COMPLEX",
  datetime: "FRI JUL 18 2008 7:30 PM",
  disclaimer: "NO CAMERAS OR RECORDERS OR FLASH PHOTOGRAPHY",
  ticketCode: "SJ0718",
  headerRight: "ESJ0718",
  section: "FLOOR SECTION THREE AISLE",
  aisle: "AISLE TWENTY SIX NEAR STAGE LEFT",
  row: "14",
  seat: "1",
  price: "180.00",
  admissionType: "VAUCTN",
  eventNum: "1046555",
  cn: "CN 17258",
  auxLeft: "CA  6X",
  auxRight: "CA404SJA",
  orderCode: "404VSJA",
  dateShort: "18JUL08",
  barcode: "6540422223612",
};

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function rectsOverlap(a, b, gap = 2) {
  return !(
    a.right + gap <= b.left
    || b.right + gap <= a.left
    || a.bottom + gap <= b.top
    || b.bottom + gap <= a.top
  );
}

function overlapArea(a, b) {
  const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return w * h;
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✅ ${msg}`);
}

console.log("Real Ticket Stubs — PNG export test\n");
console.log("  Base URL:", base);
console.log();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.htmlToImage && document.fonts?.ready);

  // Fill form (show edit panel if hidden).
  await page.evaluate(() => {
    document.getElementById("edit-panel")?.classList.remove("hidden");
  });

  for (const [name, value] of Object.entries(LONG_FIELDS)) {
    const input = page.locator(`#ticket-form [name="${name}"]`);
    if (await input.count()) await input.fill(value);
  }

  await page.click("#render-btn");
  await page.waitForSelector(".stub-stage .tm");
  await page.waitForTimeout(500);

  const layout = await page.evaluate(async (fields) => {
    const { prepareTicketData, buildTicketHtml } = await import("/templates.js");
    const d = prepareTicketData(fields);
    const host = document.createElement("div");
    host.className = "stub-export-host";
    host.innerHTML = buildTicketHtml(d);
    document.body.appendChild(host);
    await document.fonts.ready;

    const selectors = [
      ".tm-head-vals > span",
      ".tm-sub-aisle",
      ".tm-sub-price",
      ".tm-sub-evnum",
      ".tm-artist",
      ".tm-tour",
      ".tm-venue",
      ".tm-disclaim",
      ".tm-datetime",
      ".tm-left-sec",
      ".tm-r-val",
      ".tm-r-side",
    ];

    const items = [];
    for (const sel of selectors) {
      for (const el of host.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        items.push({
          sel,
          text: (el.textContent || "").slice(0, 40),
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
        });
      }
    }

    const hostBox = host.querySelector(".tm").getBoundingClientRect();
    host.remove();

    return { items, hostBox: { width: hostBox.width, height: hostBox.height } };
  }, LONG_FIELDS);

  if (Math.round(layout.hostBox.width) !== 1300 || Math.round(layout.hostBox.height) !== 589) {
    fail(`Export node size ${layout.hostBox.width}x${layout.hostBox.height}, expected 1300x589`);
  }
  ok(`Export node renders at ${Math.round(layout.hostBox.width)}×${Math.round(layout.hostBox.height)}`);

  const overlaps = [];
  for (let i = 0; i < layout.items.length; i++) {
    for (let j = i + 1; j < layout.items.length; j++) {
      const a = layout.items[i];
      const b = layout.items[j];
      if (rectsOverlap(a, b) && overlapArea(a, b) > 80) {
        overlaps.push({ a, b, area: overlapArea(a, b) });
      }
    }
  }

  if (overlaps.length) {
    console.error("Overlapping text regions:");
    for (const { a, b } of overlaps.slice(0, 5)) {
      console.error(`  ${a.sel} "${a.text}" ↔ ${b.sel} "${b.text}"`);
    }
    fail(`${overlaps.length} overlapping text region(s) in export layout`);
  }
  ok(`No overlapping text among ${layout.items.length} measured regions`);

  const dataUrl = await page.evaluate(async (fields) => {
    const form = document.getElementById("ticket-form");
    for (const [name, value] of Object.entries(fields)) {
      const el = form?.elements.namedItem(name);
      if (el && "value" in el) el.value = value;
    }
    document.getElementById("render-btn")?.click();
    await new Promise((r) => setTimeout(r, 300));
    await document.fonts.ready;

    const { prepareTicketData, buildTicketHtml } = await import("/templates.js");
    const d = prepareTicketData(fields);
    const host = document.createElement("div");
    host.className = "stub-export-host";
    host.innerHTML = buildTicketHtml(d);
    const node = host.querySelector(".tm");
    document.body.appendChild(host);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const url = await window.htmlToImage.toPng(node, {
      width: 1300,
      height: 589,
      pixelRatio: 2,
      backgroundColor: "#ffffff",
      cacheBust: true,
      skipAutoScale: true,
    });
    host.remove();
    return url;
  }, LONG_FIELDS);

  if (!dataUrl?.startsWith("data:image/png;base64,")) {
    fail("html-to-image did not return a PNG data URL");
  }

  const buffer = Buffer.from(dataUrl.split(",")[1], "base64");
  const dim = pngDimensions(buffer);
  if (!dim) fail("Could not read PNG dimensions");

  if (dim.width !== 2600 || dim.height !== 1178) {
    fail(`PNG size ${dim.width}x${dim.height}, expected 2600x1178 (1300x589 @2x)`);
  }
  ok(`PNG export ${dim.width}×${dim.height} (${Math.round(buffer.length / 1024)} KB)`);

  if (buffer.length < 50_000) {
    fail(`PNG too small (${buffer.length} bytes) — likely blank or incomplete render`);
  }
  ok("PNG file size looks healthy");

  console.log("\nAll PNG export checks passed.");
} catch (e) {
  fail(e.message || String(e));
} finally {
  await browser.close();
}
