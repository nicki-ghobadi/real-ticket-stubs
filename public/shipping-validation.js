/**
 * Shipping + email validation shared by browser (format) and server (format + DNS + postal API).
 * @see TODO.md — Google/USPS APIs, international shipping, address autocomplete.
 */

const US_STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const US_STATE_BY_NAME = Object.fromEntries(
  Object.entries(US_STATE_NAMES).map(([abbr, name]) => [name.toUpperCase(), abbr]),
);

const CA_PROVINCES = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
  NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
  SK: "Saskatchewan", YT: "Yukon",
};

const CA_PROVINCE_BY_NAME = Object.fromEntries(
  Object.entries(CA_PROVINCES).map(([abbr, name]) => [name.toUpperCase(), abbr]),
);

/** Domains that cannot receive real mail — block at checkout. */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "tempmail.com", "10minutemail.com",
  "yopmail.com", "throwaway.email", "getnada.com", "sharklasers.com",
  "trashmail.com", "maildrop.cc", "fakeinbox.com",
]);

const EMAIL_TYPOS = {
  "gmial.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "outlok.com": "outlook.com",
  "outllok.com": "outlook.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "iclod.com": "icloud.com",
};

const FAKE_STREET_RE =
  /\b(test\s+(street|st|ave|road)|asdf|qwerty|fake\s+(street|address)|^\s*(xxx|none|n\/a)\s*$)\b/i;

export function normalizeCountry(raw) {
  const c = String(raw || "").trim().toUpperCase();
  if (!c || c === "US" || c === "USA" || c.includes("UNITED STATES")) return "US";
  if (c === "CA" || c === "CAN" || c.includes("CANADA")) return "CA";
  return c.slice(0, 2) === "US" || c.slice(0, 2) === "CA" ? c.slice(0, 2) : c;
}

export function normalizeState(raw, countryCode) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  if (s.length === 2) return s;
  if (countryCode === "US") return US_STATE_BY_NAME[s] || "";
  if (countryCode === "CA") return CA_PROVINCE_BY_NAME[s] || "";
  return s.slice(0, 2);
}

export function suggestEmailFix(email) {
  const lower = String(email || "").trim().toLowerCase();
  const at = lower.indexOf("@");
  if (at < 1) return null;
  const domain = lower.slice(at + 1);
  const fix = EMAIL_TYPOS[domain];
  if (!fix) return null;
  return `${lower.slice(0, at + 1)}${fix}`;
}

/** RFC-inspired practical email check (not full RFC 5322). */
export function validateEmailFormat(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return "Email is required.";
  if (e.length > 254) return "Email is too long.";
  const re =
    /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!re.test(e)) return "Enter a valid email address (example: name@example.com).";
  const domain = e.split("@")[1];
  if (!domain || !domain.includes(".")) return "Email domain looks incomplete.";
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return "Use a permanent email address so we can send your confirmation.";
  }
  const typo = suggestEmailFix(e);
  if (typo) return `Did you mean ${typo}?`;
  return null;
}

export function validateEmailMatch(email, confirm) {
  const a = String(email || "").trim().toLowerCase();
  const b = String(confirm || "").trim().toLowerCase();
  if (!b) return "Please confirm your email address.";
  if (a !== b) return "Email addresses do not match.";
  return null;
}

export function validateName(name) {
  const n = String(name || "").trim();
  if (!n) return "Full name is required.";
  if (n.length < 2) return "Enter your full name.";
  if (n.length > 80) return "Name is too long.";
  if (/^\d+$/.test(n)) return "Name cannot be only numbers.";
  if (!/[a-zA-Z]/.test(n)) return "Enter a real name using letters.";
  if (/\b(test|asdf|fake)\b/i.test(n)) return "Enter your real name.";
  return null;
}

export function validateStreet(street1, countryCode) {
  const s = String(street1 || "").trim();
  if (!s) return "Street address is required.";
  if (s.length < 5) return "Street address is too short.";
  if (s.length > 120) return "Street address is too long.";
  if (FAKE_STREET_RE.test(s)) return "Enter a real street address where mail can be delivered.";
  if (countryCode === "US" && !/\d/.test(s)) {
    return "US street addresses usually include a building or street number.";
  }
  return null;
}

export function validateCity(city) {
  const c = String(city || "").trim();
  if (!c) return "City is required.";
  if (c.length < 2) return "City name is too short.";
  if (c.length > 60) return "City name is too long.";
  if (/^\d+$/.test(c)) return "Enter a valid city name.";
  if (/\b(test|asdf|fake)\b/i.test(c)) return "Enter a real city name.";
  return null;
}

export function validateZip(zip, countryCode) {
  const z = String(zip || "").trim();
  if (!z) return "ZIP / postal code is required.";
  if (countryCode === "US") {
    if (!/^\d{5}(-\d{4})?$/.test(z)) {
      return "US ZIP must be 5 digits (or 5+4, e.g. 90210 or 90210-1234).";
    }
    return null;
  }
  if (countryCode === "CA") {
    const compact = z.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) {
      return "Canadian postal code must look like A1A 1A1.";
    }
    return null;
  }
  if (z.length < 3 || z.length > 12) return "Postal code length looks invalid.";
  return null;
}

export function validateState(state, countryCode) {
  const s = String(state || "").trim();
  if (!s) return "State / province is required.";
  if (countryCode === "US") {
    const abbr = normalizeState(s, "US");
    if (!US_STATE_NAMES[abbr]) {
      return "Enter a valid US state (e.g. CA or California).";
    }
    return null;
  }
  if (countryCode === "CA") {
    const abbr = normalizeState(s, "CA");
    if (!CA_PROVINCES[abbr]) {
      return "Enter a valid Canadian province (e.g. ON or Ontario).";
    }
    return null;
  }
  if (s.length < 2) return "State / province is too short.";
  return null;
}

/** Format-only validation — runs in the browser before the server round-trip. */
export function validateShippingFormat(data) {
  const errors = {};
  const country = normalizeCountry(data.country);

  const nameErr = validateName(data.name);
  if (nameErr) errors.name = nameErr;

  const emailErr = validateEmailFormat(data.email);
  if (emailErr) errors.email = emailErr;

  const confirmErr = validateEmailMatch(data.email, data.emailConfirm);
  if (confirmErr) errors.emailConfirm = confirmErr;

  const streetErr = validateStreet(data.street1, country);
  if (streetErr) errors.street1 = streetErr;

  const cityErr = validateCity(data.city);
  if (cityErr) errors.city = cityErr;

  const stateErr = validateState(data.state, country);
  if (stateErr) errors.state = stateErr;

  const zipErr = validateZip(data.zip, country);
  if (zipErr) errors.zip = zipErr;

  if (country !== "US" && country !== "CA") {
    errors.country =
      "We currently ship to the United States and Canada only. Enter US or Canada.";
  }

  const normalized = {
    name: String(data.name || "").trim(),
    email: String(data.email || "").trim().toLowerCase(),
    street1: String(data.street1 || "").trim(),
    street2: String(data.street2 || "").trim(),
    city: String(data.city || "").trim(),
    state: normalizeState(data.state, country),
    zip: String(data.zip || "").trim(),
    country: country === "US" ? "United States" : country === "CA" ? "Canada" : data.country,
    countryCode: country,
  };

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized,
  };
}

/** Verify city/state/ZIP against Zippopotam (free, no API key). Server-side only. */
export async function verifyPostalWithZippopotam(normalized) {
  const country = normalized.countryCode;
  if (country !== "US" && country !== "CA") {
    return { ok: true, normalized };
  }

  const zipRaw = normalized.zip.replace(/\s+/g, "");
  const zipPath =
    country === "US" ? zipRaw.replace(/-\d{4}$/, "").slice(0, 5) : zipRaw.toUpperCase();

  let res;
  try {
    const url = `https://api.zippopotam.us/${country.toLowerCase()}/${encodeURIComponent(zipPath)}`;
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    return {
      ok: false,
      errors: {
        zip: "Could not verify postal code right now. Try again in a moment.",
      },
    };
  }

  if (res.status === 404) {
    return { ok: false, errors: { zip: "This ZIP / postal code was not found." } };
  }
  if (!res.ok) {
    return {
      ok: false,
      errors: { zip: "Could not verify postal code. Check it and try again." },
    };
  }

  const json = await res.json();
  const place = json.places?.[0];
  if (!place) {
    return { ok: false, errors: { zip: "Could not verify this postal code." } };
  }

  const apiState = String(place["state abbreviation"] || "").toUpperCase();
  const apiCity = String(place["place name"] || "").trim();

  const errors = {};
  if (apiState && normalized.state && apiState !== normalized.state) {
    errors.state = `State does not match ${zipPath}. Did you mean ${apiState}?`;
  }

  if (apiCity && normalized.city) {
    const entered = normalized.city.toUpperCase();
    const expected = apiCity.toUpperCase();
    if (
      entered !== expected &&
      !expected.includes(entered) &&
      !entered.includes(expected)
    ) {
      errors.city = `City does not match ${zipPath}. Did you mean ${apiCity}?`;
    }
  }

  if (Object.keys(errors).length) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    normalized: {
      ...normalized,
      state: apiState || normalized.state,
      city: apiCity || normalized.city,
    },
  };
}
