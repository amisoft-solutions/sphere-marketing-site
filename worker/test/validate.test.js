import assert from "node:assert/strict";
import test from "node:test";
import { isValidEmail, isValidPhone, validateDemoRequest } from "../src/validate.js";

const NOW = 1_700_000_000_000;

function payload(overrides = {}) {
  return {
    requestType: "Demo request",
    fullName: "José Álvarez",
    jobTitle: "Lead Statistical Programmer",
    organization: "Northwind Biometrics",
    workEmail: "jose.alvarez@northwindbio.example",
    phone: "+1 202 555 0143",
    country: "",
    organizationType: "",
    interest: "",
    heardAbout: "",
    consentToContact: false,
    faxNumber: "",
    formLoadedAt: NOW - 10_000,
    ...overrides,
  };
}

test("accepts a complete demo request and normalizes strings", () => {
  const result = validateDemoRequest(
    payload({
      fullName: "  Anne-Marie   O'Neill ",
      country: " United Kingdom ",
      organizationType: "Pharma/biotech",
      interest: "Shells and the tracker.\nAudit trail.",
      heardAbout: "Colleague",
      consentToContact: true,
    }),
    NOW
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.fullName, "Anne-Marie O'Neill");
  assert.equal(result.value.country, "United Kingdom");
  assert.equal(result.value.organizationType, "Pharma/biotech");
  assert.equal(result.value.consentToContact, true);
  assert.equal(result.value.requestType, "Demo request");
  assert.equal("faxNumber" in result.value, false);
});

test("accepts optional fields when they are omitted", () => {
  const body = payload();
  delete body.country;
  delete body.organizationType;
  delete body.interest;
  delete body.heardAbout;
  delete body.consentToContact;
  const result = validateDemoRequest(body, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.value.country, "");
  assert.equal(result.value.consentToContact, false);
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

test("rejects unknown organization types and over-long optional text", () => {
  const badType = validateDemoRequest(payload({ organizationType: "Hospital" }), NOW);
  assert.equal(badType.ok, false);
  assert.ok(badType.fields.organizationType);

  const longInterest = validateDemoRequest(payload({ interest: "a".repeat(1001) }), NOW);
  assert.equal(longInterest.fields.interest.includes("1000"), true);

  const longHeard = validateDemoRequest(payload({ heardAbout: "a".repeat(161) }), NOW);
  assert.ok(longHeard.fields.heardAbout);
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
