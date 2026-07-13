/**
 * Render print-ready ticket stub PNGs via headless browser.
 * Uses window.__rtsExportStubPngDataUrl — same code path as checkout.
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
      () =>
        typeof window.__rtsExportStubPngDataUrl === "function"
        && window.htmlToImage
        && window.JsBarcode,
      { timeout: 20_000 },
    );

    for (const fields of list) {
      const dataUrl = await page.evaluate(
        (ticketFields) => window.__rtsExportStubPngDataUrl(ticketFields),
        fields,
      );

      if (!dataUrl?.startsWith("data:image/png;base64,")) {
        throw new Error("Checkout export did not return a PNG data URL");
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
