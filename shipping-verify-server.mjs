/**
 * Server-only shipping verification (MX + postal API).
 * @see TODO.md
 */
import dns from "node:dns/promises";
import {
  validateShippingFormat,
  verifyPostalWithZippopotam,
} from "./shipping-validation.js";

// TODO(production): Google Address Validation API — set GOOGLE_ADDRESS_VALIDATION_API_KEY;
//   call https://addressvalidation.googleapis.com/v1:validateAddress for deliverability.
// TODO(production): USPS Web Tools — set USPS_USER_ID; verify US street addresses via USPS API.

/** Confirm the email domain exists and can receive mail (MX lookup). */
export async function verifyEmailMx(email) {
  const domain = String(email || "").split("@")[1]?.toLowerCase();
  if (!domain) return "Invalid email domain.";

  try {
    const mx = await dns.resolveMx(domain);
    if (!mx?.length) {
      return `“${domain}” does not appear to accept email. Check for typos.`;
    }
    return null;
  } catch (e) {
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") {
      return `“${domain}” was not found. Check your email for typos.`;
    }
    console.warn("MX lookup inconclusive for", domain, e.message);
    return null;
  }
}

/** Full server-side validation: format, email MX, postal code API. */
export async function validateShippingComplete(data) {
  const format = validateShippingFormat(data);
  if (!format.valid) {
    return { valid: false, errors: format.errors };
  }

  const mxErr = await verifyEmailMx(format.normalized.email);
  if (mxErr) {
    return { valid: false, errors: { email: mxErr } };
  }

  const postal = await verifyPostalWithZippopotam(format.normalized);
  if (!postal.ok) {
    return { valid: false, errors: postal.errors };
  }

  return { valid: true, normalized: postal.normalized };
}
