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

/**
 * Verify real deliverability via the Google Address Validation API.
 * Docs: https://developers.google.com/maps/documentation/address-validation
 *
 * @param {{line1?:string,line2?:string,city?:string,state?:string,postalCode?:string,country?:string}} addr
 * @returns {Promise<{configured:boolean, ok?:boolean, deliverable?:boolean,
 *   granularity?:string, hasUnconfirmedComponents?:boolean,
 *   hasInferredComponents?:boolean, formatted?:string, error?:string}>}
 */
export async function validateAddressWithGoogle(addr) {
  const key = process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY;
  if (!key) return { configured: false };

  // Stripe returns ISO country codes (US, CA). Default to US if absent.
  const regionCode = String(addr.country || "US").trim().toUpperCase().slice(0, 2) || "US";

  const body = {
    address: {
      regionCode,
      postalCode: addr.postalCode || "",
      administrativeArea: addr.state || "",
      locality: addr.city || "",
      addressLines: [addr.line1, addr.line2].filter(Boolean),
    },
    // USPS CASS gives richer US deliverability data.
    enableUspsCass: regionCode === "US",
  };

  let res;
  try {
    res = await fetch(
      `https://addressvalidation.googleapis.com/v1:validateAddress?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (e) {
    return { configured: true, ok: false, error: `Network error: ${e.message}` };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { configured: true, ok: false, error: `Google API ${res.status} ${txt.slice(0, 120)}` };
  }

  const data = await res.json();
  const result = data.result || {};
  const verdict = result.verdict || {};
  const granularity = verdict.validationGranularity || "OTHER";

  // Treat an exact building/unit match with no unconfirmed parts as deliverable.
  const deliverable =
    (granularity === "PREMISE" || granularity === "SUB_PREMISE") &&
    !verdict.hasUnconfirmedComponents;

  return {
    configured: true,
    ok: true,
    deliverable,
    granularity,
    hasUnconfirmedComponents: !!verdict.hasUnconfirmedComponents,
    hasInferredComponents: !!verdict.hasInferredComponents,
    formatted: result.address?.formattedAddress || "",
  };
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
