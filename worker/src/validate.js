/**
 * Demo-request validation shared by the marketing page and the Worker.
 * Keep this file free of secrets, inbox addresses, and deployment hosts.
 */

export const REQUEST_TYPE_DEMO = "Demo request";

export const ORGANIZATION_TYPES = ["Pharma/biotech", "CRO", "Academic", "Other"];

export const MIN_SUBMIT_MS = 2500;
export const MAX_FORM_AGE_MS = 48 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 10 * 60 * 1000;

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const LIMITS = {
  fullName: 120,
  jobTitle: 120,
  organization: 160,
  workEmail: 254,
  phone: 32,
  country: 80,
  interest: 1000,
  heardAbout: 160,
};

function hasLetter(value) {
  return /\p{L}/u.test(value);
}

function hasLetterOrNumber(value) {
  return /[\p{L}\p{N}]/u.test(value);
}

function cleanSingleLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function invalidChars(value) {
  return /[<>\u0000-\u001F\u007F]/.test(value);
}

/**
 * @param {unknown} raw
 * @param {number} [now]
 */
export function validateDemoRequest(raw, now = Date.now()) {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fields = {};

  const honeypot = firstFilled(body.faxNumber, body.fax_number);
  if (honeypot) {
    return {
      ok: false,
      code: "honeypot",
      error: "Unable to submit this request. Please try again.",
      fields: {},
    };
  }

  const requestType = typeof body.requestType === "string" ? body.requestType.trim() : "";
  if (requestType !== REQUEST_TYPE_DEMO) {
    fields.requestType = "This form only accepts a demo request.";
  }

  const fullName = readLine(body.fullName, LIMITS.fullName, fields, "fullName", {
    label: "Full name",
    missing: "Enter your full name.",
    requireLetter: true,
  });
  const jobTitle = readLine(body.jobTitle, LIMITS.jobTitle, fields, "jobTitle", {
    label: "Job title",
    missing: "Enter your job title.",
    requireLetter: true,
  });
  const organization = readLine(body.organization, LIMITS.organization, fields, "organization", {
    label: "Organization",
    missing: "Enter your organization.",
    requireLetter: true,
  });

  let workEmail = "";
  if (typeof body.workEmail !== "string" || !body.workEmail.trim()) {
    fields.workEmail = "Enter a valid work email address.";
  } else {
    workEmail = body.workEmail.trim();
    if (!isValidEmail(workEmail)) {
      fields.workEmail = "Enter a valid work email address.";
    }
  }

  let phone = "";
  if (typeof body.phone !== "string" || !body.phone.trim()) {
    fields.phone = "Enter a phone number, including a country code if needed.";
  } else {
    phone = body.phone.trim();
    if (!isValidPhone(phone)) {
      fields.phone = "Enter a phone number, including a country code if needed.";
    }
  }

  const country = readOptionalLine(body.country, LIMITS.country, fields, "country", "Country or region");
  const interest = readOptionalText(body.interest, LIMITS.interest, fields, "interest", "What you are interested in");
  const heardAbout = readOptionalLine(
    body.heardAbout,
    LIMITS.heardAbout,
    fields,
    "heardAbout",
    "How you heard about SPHERE"
  );

  let organizationType = "";
  if (body.organizationType !== undefined && body.organizationType !== null && body.organizationType !== "") {
    if (typeof body.organizationType !== "string" || !ORGANIZATION_TYPES.includes(body.organizationType)) {
      fields.organizationType = "Choose a listed organization type, or leave it blank.";
    } else {
      organizationType = body.organizationType;
    }
  }

  const consent = readConsent(body.consentToContact, fields);

  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      code: "validation",
      error: "Please check the highlighted fields and try again.",
      fields,
    };
  }

  const timing = checkSubmitTiming(body.formLoadedAt, now);
  if (!timing.ok) {
    return {
      ok: false,
      code: "timing",
      error: timing.error,
      fields: {},
    };
  }

  return {
    ok: true,
    value: {
      requestType: REQUEST_TYPE_DEMO,
      fullName,
      jobTitle,
      organization,
      workEmail,
      phone,
      country,
      organizationType,
      interest,
      heardAbout,
      consentToContact: consent,
    },
  };
}

export function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const value = email.trim();
  if (value.length < 6 || value.length > LIMITS.workEmail) return false;
  if (value.includes("..") || !EMAIL_RE.test(value)) return false;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || !domain) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  const tld = domain.split(".").pop();
  return Boolean(tld && /^[A-Za-z]{2,63}$/.test(tld));
}

export function isValidPhone(phone) {
  if (typeof phone !== "string") return false;
  const value = phone.trim();
  if (!value || value.length > LIMITS.phone) return false;
  if (!/^[+().\-\s0-9]+$/.test(value)) return false;
  const plusCount = (value.match(/\+/g) || []).length;
  if (plusCount > 1) return false;
  if (plusCount === 1 && !value.startsWith("+")) return false;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  if (value.startsWith("+") && digits.startsWith("0")) return false;
  return true;
}

export function checkSubmitTiming(formLoadedAt, now) {
  const loaded = typeof formLoadedAt === "number" ? formLoadedAt : Number(formLoadedAt);
  if (!Number.isFinite(loaded)) {
    return { ok: false, error: "Please refresh the page and try again." };
  }
  const dwell = now - loaded;
  if (dwell > MAX_FORM_AGE_MS) {
    return { ok: false, error: "This form has expired. Please refresh the page and try again." };
  }
  if (dwell >= 0 && dwell < MIN_SUBMIT_MS) {
    return { ok: false, error: "Please take a moment to complete the form before submitting." };
  }
  if (dwell < -CLOCK_SKEW_MS) {
    return { ok: false, error: "Please refresh the page and try again." };
  }
  return { ok: true };
}

function firstFilled(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readLine(value, max, fields, key, { label, missing, requireLetter }) {
  if (typeof value !== "string") {
    fields[key] = missing;
    return "";
  }
  const cleaned = cleanSingleLine(value);
  if (!cleaned || (requireLetter && !hasLetter(cleaned))) {
    fields[key] = missing;
    return "";
  }
  if (cleaned.length > max) {
    fields[key] = `${label} must be ${max} characters or fewer.`;
    return "";
  }
  if (invalidChars(cleaned)) {
    fields[key] = `${label} cannot include those characters.`;
    return "";
  }
  return cleaned;
}

function readOptionalLine(value, max, fields, key, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    fields[key] = `${label} cannot include those characters.`;
    return "";
  }
  const cleaned = cleanSingleLine(value);
  if (!cleaned) return "";
  if (cleaned.length > max) {
    fields[key] = `${label} must be ${max} characters or fewer.`;
    return "";
  }
  if (invalidChars(cleaned) || !hasLetterOrNumber(cleaned)) {
    fields[key] = `${label} cannot include those characters.`;
    return "";
  }
  return cleaned;
}

function readOptionalText(value, max, fields, key, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    fields[key] = `${label} must be ${max} characters or fewer.`;
    return "";
  }
  const cleaned = value.replace(/\r\n/g, "\n").replace(/\t/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length > max) {
    fields[key] = `${label} must be ${max} characters or fewer.`;
    return "";
  }
  if (/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned) || !hasLetterOrNumber(cleaned)) {
    fields[key] = `${label} cannot include those characters.`;
    return "";
  }
  return cleaned;
}

function readConsent(value, fields) {
  if (value === undefined || value === null || value === "" || value === false) return false;
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (token === "true" || token === "on" || token === "yes" || token === "1") return true;
    if (token === "false" || token === "off" || token === "no" || token === "0") return false;
  }
  if (value === 0) return false;
  fields.consentToContact = "Choose whether the SPHERE team may contact you, or leave the box unchecked.";
  return false;
}
