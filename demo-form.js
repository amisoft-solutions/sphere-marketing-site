import { validateDemoRequest } from "./shared/demo-request-validate.js";

var FIELD_IDS = {
  fullName: "full-name",
  jobTitle: "job-title",
  organization: "organization",
  workEmail: "work-email",
  phone: "phone",
  country: "country",
  organizationType: "organization-type",
  interest: "interest",
  heardAbout: "heard-about",
  consentToContact: "consent",
  requestType: "request-type",
};

var RETRY = "Something went wrong while sending your request. Please try again.";
var submitting = false;

function reducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function typeTokenFromLocation() {
  var params = new URLSearchParams(window.location.search);
  if (params.get("type")) return params.get("type");
  var hash = window.location.hash || "";
  var query = hash.indexOf("?");
  if (query === -1) return "";
  return new URLSearchParams(hash.slice(query + 1)).get("type") || "";
}

function presetRequestType() {
  var input = document.getElementById("request-type");
  if (!input) return;
  var token = typeTokenFromLocation();
  if (!token || token === "demo") input.value = "Demo request";
}

function scrollToContact() {
  var section = document.getElementById("contact");
  if (!section) return;
  section.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
}

function focusHeading() {
  var title = document.getElementById("cta-title");
  if (!title) return;
  title.focus({ preventScroll: true });
}

function closeNav() {
  var nav = document.getElementById("site-nav");
  var toggle = document.querySelector(".nav-toggle");
  if (nav) nav.classList.remove("open");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function bindDemoLinks() {
  document.querySelectorAll('a[href="#contact"], a[href="#contact?type=demo"]').forEach(function (link) {
    link.addEventListener("click", function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var href = link.getAttribute("href") || "";
      if (href !== "#contact" && href !== "#contact?type=demo") return;
      presetRequestType();
      closeNav();
      if (href === "#contact") return;
      event.preventDefault();
      if (window.history && window.history.pushState) {
        window.history.pushState({ demoRequest: true }, "", href);
      }
      scrollToContact();
      focusHeading();
    });
  });
}

function applyLocationPreset() {
  presetRequestType();
  var hash = window.location.hash || "";
  var type = new URLSearchParams(window.location.search).get("type");
  if (hash.indexOf("#contact?") === 0) scrollToContact();
  else if (!hash && type === "demo") scrollToContact();
}

function init() {
  bindDemoLinks();
  applyLocationPreset();
  window.addEventListener("hashchange", applyLocationPreset);

  var form = document.getElementById("demo-request-form");
  if (!form) return;
  var status = document.getElementById("demo-form-status");
  var submit = document.getElementById("demo-submit");
  var loaded = document.getElementById("form-loaded-at");
  if (loaded && !loaded.value) loaded.value = String(Date.now());
  if (submit) submit.disabled = false;

  form.addEventListener("input", function (event) {
    var target = event.target;
    if (!target || !target.id) return;
    clearField(target.id);
    if (status && status.classList.contains("is-error")) {
      status.hidden = true;
      status.textContent = "";
      status.className = "form-status";
    }
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    submitForm(form, status, submit);
  });
}

async function submitForm(form, status, submit) {
  if (submitting) return;
  clearAll();
  var body = readBody(form);
  var result;
  try {
    result = validateDemoRequest(body, Date.now());
  } catch (err) {
    showStatus(status, RETRY, true);
    return;
  }
  if (!result.ok) {
    presentInvalid(status, result);
    return;
  }

  var config = window.SPHERE_DEMO_CONFIG || {};
  var endpoint = typeof config.endpoint === "string" ? config.endpoint.trim() : "";
  if (!endpoint || endpoint.indexOf("<account>") !== -1) {
    showStatus(status, "This form is not available yet. Please try again later.", true);
    if (status) status.focus();
    return;
  }

  submitting = true;
  form.setAttribute("aria-busy", "true");
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Sending…";
  }

  try {
    var response = await fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    var payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }
    if (response.ok && payload && payload.ok) {
      showSuccess(form, status);
      return;
    }
    if (payload && payload.fields && Object.keys(payload.fields).length) {
      presentInvalid(status, { error: payload.error, fields: payload.fields });
      return;
    }
    showStatus(status, (payload && payload.error) || RETRY, true);
    if (status) status.focus();
  } catch (err) {
    showStatus(status, RETRY, true);
    if (status) status.focus();
  } finally {
    submitting = false;
    form.removeAttribute("aria-busy");
    if (submit && !form.hidden) {
      submit.disabled = false;
      submit.textContent = "Request a demo";
    }
  }
}

function readBody(form) {
  return {
    requestType: valueOf(form, "requestType"),
    fullName: valueOf(form, "fullName"),
    jobTitle: valueOf(form, "jobTitle"),
    organization: valueOf(form, "organization"),
    workEmail: valueOf(form, "workEmail"),
    phone: valueOf(form, "phone"),
    country: valueOf(form, "country"),
    organizationType: valueOf(form, "organizationType"),
    interest: valueOf(form, "interest"),
    heardAbout: valueOf(form, "heardAbout"),
    consentToContact: checked(form, "consentToContact"),
    faxNumber: valueOf(form, "fax_number"),
    formLoadedAt: Number(valueOf(form, "formLoadedAt")),
  };
}

function valueOf(form, name) {
  var el = form.elements[name];
  if (!el || typeof el.value !== "string") return "";
  return el.value;
}

function checked(form, name) {
  var el = form.elements[name];
  return Boolean(el && el.checked);
}

function clearField(id) {
  var input = document.getElementById(id);
  var error = document.getElementById(id + "-error");
  if (input) input.setAttribute("aria-invalid", "false");
  if (error) error.textContent = "";
}

function clearAll() {
  Object.keys(FIELD_IDS).forEach(function (key) {
    clearField(FIELD_IDS[key]);
  });
}

function presentInvalid(status, result) {
  var fields = result.fields || {};
  var first = null;
  Object.keys(FIELD_IDS).forEach(function (key) {
    var id = FIELD_IDS[key];
    var message = fields[key] || "";
    var input = document.getElementById(id);
    var error = document.getElementById(id + "-error");
    if (!message || !input || !error) return;
    input.setAttribute("aria-invalid", "true");
    error.textContent = message;
    if (!first && input.type !== "hidden") first = input;
  });
  var summary = result.error || "Please check the highlighted fields and try again.";
  if (!first && fields.requestType) summary = fields.requestType;
  showStatus(status, summary, true);
  if (first) first.focus();
  else if (status) status.focus();
}

function showStatus(status, message, isError) {
  if (!status) return;
  status.hidden = false;
  status.className = "form-status " + (isError ? "is-error" : "is-success");
  status.textContent = message;
}

function showSuccess(form, status) {
  form.hidden = true;
  showStatus(status, "Thank you. The SPHERE team will review the request and follow up.", false);
  if (status) status.focus();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
