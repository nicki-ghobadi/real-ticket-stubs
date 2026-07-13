/**
 * Render print-ready ticket stub PNGs via headless browser (same path as checkout).
 */
import { chromium } from "playwright";
import { validateStubPngBuffer } from "../stub-png-validate.mjs";

/** Render one or more tickets; returns PNG buffers at 2× print resolution. */
export async function renderStubPngBuffers(fieldsList, { base = "http://localhost:3456" } = {}) {
  const list = Array.isArray(fieldsList) ? fieldsList : [fieldsList];
  const browser = await chromium.launch({ headless: true });
  const buffers = [];

  try {
    const page = await browser.newPage();
    const origin = base.replace(/\/$/, "");
    const res = await page.goto(origin, { waitUntil: "networkidle", timeout: 30_000 });
    if (!res?.ok()) {
      throw new Error(`Could not load ${origin} (HTTP ${res?.status() || "?"}). Run npm start first.`);
    }
    await page.waitForFunction(
      () => window.htmlToImage && window.JsBarcode && typeof window.JsBarcode === "function",
      { timeout: 20_000 },
    );

    for (const fields of list) {
      const dataUrl = await page.evaluate(
        async (ticketFields) => {
          const { prepareTicketData, buildTicketHtml, STUB_WIDTH, STUB_HEIGHT } = await import(
            "/templates.js"
          );
          const d = prepareTicketData(ticketFields);
          const host = document.createElement("div");
          host.className = "stub-export-host";
          host.innerHTML = buildTicketHtml(d);
          const node = host.querySelector(".tm");
          if (!node) throw new Error("Stub node missing");

          const bc = node.querySelector(".tm-barcode");
          if (bc && window.JsBarcode && d.barcodeScan) {
            try {
              window.JsBarcode(bc, d.barcodeScan, {
                format: "CODE128",
                width: 1.35,
                height: 40,
                displayValue: false,
                margin: 0,
                background: "transparent",
                lineColor: "#000000",
              });
              bc.classList.add("tm-barcode--live");
              bc.style.removeProperty("transform");
              bc.removeAttribute("width");
              bc.removeAttribute("height");
              bc.setAttribute("preserveAspectRatio", "none");
            } catch {
              /* fallback SVG stripes remain */
            }
          }

          document.body.appendChild(host);
          await document.fonts.ready;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

          const url = await window.htmlToImage.toPng(node, {
            width: STUB_WIDTH,
            height: STUB_HEIGHT,
            pixelRatio: 2,
            backgroundColor: "#ffffff",
            cacheBust: true,
            skipFonts: false,
            skipAutoScale: true,
            includeQueryParams: true,
          });
          host.remove();
          return url;
        },
        fields,
      );

      if (!dataUrl?.startsWith("data:image/png;base64,")) {
        throw new Error("html-to-image did not return a PNG data URL");
      }
      const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      const valid = validateStubPngBuffer(buffer, `Ticket ${buffers.length + 1}`);
      if (!valid.ok) throw new Error(valid.error);
      buffers.push(buffer);
    }
  } finally {
    await browser.close();
  }

  return buffers;
}
