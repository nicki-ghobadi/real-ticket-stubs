/**
 * Shared validation for print-ready ticket PNGs (checkout, storage, fulfillment).
 */
import {
  STUB_EXPORT_WIDTH,
  STUB_EXPORT_HEIGHT,
  MIN_STUB_PNG_BYTES,
} from "./public/templates.js";

export { STUB_EXPORT_WIDTH, STUB_EXPORT_HEIGHT, MIN_STUB_PNG_BYTES };

export function pngDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Reject blank placeholders or wrong-size images before orders are saved or emailed. */
export function validateStubPngBuffer(buffer, label = "Ticket") {
  if (!buffer?.length) {
    return { ok: false, error: `${label}: missing print image.` };
  }
  const dim = pngDimensions(buffer);
  if (!dim) {
    return { ok: false, error: `${label}: not a valid PNG file.` };
  }
  if (dim.width !== STUB_EXPORT_WIDTH || dim.height !== STUB_EXPORT_HEIGHT) {
    return {
      ok: false,
      error: `${label}: image is ${dim.width}×${dim.height}px; expected ${STUB_EXPORT_WIDTH}×${STUB_EXPORT_HEIGHT}px print export.`,
    };
  }
  if (buffer.length < MIN_STUB_PNG_BYTES) {
    return {
      ok: false,
      error: `${label}: image is only ${Math.round(buffer.length / 1024)} KB — looks blank or incomplete. Re-render the stub before checkout.`,
    };
  }
  return { ok: true, dimensions: dim, bytes: buffer.length };
}
