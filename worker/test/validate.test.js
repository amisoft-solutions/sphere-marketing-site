import assert from "node:assert/strict";
import test from "node:test";
import { isValidEmail, isValidPhone, validateDemoRequest } from "../../shared/demo-request-validate.js";

const NOW = 1_700_000_000_000;

function payload(overrides = {}) {
  return {
    requestType: "Demo request",
    fullName: "José Álvarez",
    jobTitle: "Lead Statistical Programmer",
    organization: "Northwind Biometrics",
    workEmail: "jose.alvarez@northwindbio.example",
    phone: "+1 202 555 0143",
    faxNumber: "",
    formLoadedAt: NOW - 10_000,
    ...overrides,
  };
}

test("accepts a short demo request and normalizes strings", () => {
  const result = validateDemoRequest(
    payload({
      fullName: "  Anne-Marie   O'Neill ",
    }),
    NOW
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.fullName, "Anne-Marie O'Neill");
  assert.equal(result.value.jobTitle, "Lead Statistical Programmer");
  assert.equal(result.value.organization, "Northwind Biometrics");
  assert.equal(result.value.workEmail, "jose.alvarez@northwindbio.example");
  assert.equal(result.value.phone, "+1 202 555 0143");
  assert.equal(result.value.requestType, "Demo request");
  assert.equal("faxNumber" in result.value, false);
  for (const key of ["country", "organizationType", "interest", "heardAbout", "consentToContact"]) {
    assert.equal(key in result.value, false, key);
  }
});

test("accepts a short payload and ignores removed fields", () => {
  const result = validateDemoRequest(
    payload({
      country: " United Kingdom ",
      organizationType: "Hospital",
      interest: "x".repeat(5000),
      heardAbout: "<script>",
      consentToContact: "maybe",
    }),
    NOW
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.fullName, "José Álvarez");
  assert.equal("country" in result.value, false);
  assert.equal("organizationType" in result.value, false);
  assert.equal("interest" in result.value, false);
  assert.equal("heardAbout" in result.value, false);
  assert.equal("consentToContact" in result.value, false);
});

test("reports every missing required field", () => {
  const result = validateDemoRequest({ formLoadedAt: NOW - 10_000 }, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.code, "validation");
  assert.ok(result.fields.fullName);
  assert.ok(result.fields.jobTitle);
  assert.ok(result.fields.organization);
  assert.ok(result.fields.workEmail);
  assert.ok(result.fields.phone);
  assert.ok(result.fields.requestType);
});

test("rejects malformed email and phone but accepts permissive international numbers", () => {
  for (const email of ["not-an-email", "a@b", "jordan@", "jordan@company", "jordan lee@company.com", "a..b@company.com"]) {
    const result = validateDemoRequest(payload({ workEmail: email }), NOW);
    assert.equal(result.ok, false, email);
    assert.ok(result.fields.workEmail, email);
  }
  assert.equal(isValidEmail("jordan.lee@northwindbio.example"), true);

  for (const phone of ["123", "abcdefg", "++1 202 555 0143", "+0123456789", "123-abc-7890"]) {
    const result = validateDemoRequest(payload({ phone }), NOW);
    assert.equal(result.ok, false, phone);
    assert.ok(result.fields.phone, phone);
  }
  for (const phone of ["+44 20 7946 0958", "(415) 555-2671", "+91-98765-43210", "202.555.0199"]) {
    assert.equal(isValidPhone(phone), true, phone);
    assert.equal(validateDemoRequest(payload({ phone }), NOW).ok, true, phone);
  }
});

test("rejects a filled honeypot without field hints", () => {
  const result = validateDemoRequest(payload({ faxNumber: "https://spam.example" }), NOW);
  assert.equal(result.ok, false);
  assert.equal(result.code, "honeypot");
  assert.deepEqual(result.fields, {});
  assert.equal(result.error.toLowerCase().includes("fax"), false);
  assert.equal(result.error.toLowerCase().includes("honeypot"), false);
});

test("rejects a too-fast submit only after the other fields are valid", () => {
  const fast = validateDemoRequest(payload({ formLoadedAt: NOW - 500 }), NOW);
  assert.equal(fast.ok, false);
  assert.equal(fast.code, "timing");

  const emptyFast = validateDemoRequest({ formLoadedAt: NOW }, NOW);
  assert.equal(emptyFast.code, "validation");
});

test("allows modest clock skew and rejects a stale or far-future timestamp", () => {
  assert.equal(validateDemoRequest(payload({ formLoadedAt: NOW + 60_000 }), NOW).ok, true);
  assert.equal(validateDemoRequest(payload({ formLoadedAt: NOW + 11 * 60_000 }), NOW).ok, false);
  assert.equal(validateDemoRequest(payload({ formLoadedAt: NOW - 49 * 60 * 60 * 1000 }), NOW).ok, false);
  assert.equal(validateDemoRequest(payload({ formLoadedAt: "not-a-time" }), NOW).ok, false);
});

test("rejects markup in names", () => {
  const result = validateDemoRequest(payload({ fullName: "Ann <script>" }), NOW);
  assert.equal(result.ok, false);
  assert.ok(result.fields.fullName);
});
