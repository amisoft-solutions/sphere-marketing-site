(function () {
  var header = document.getElementById("site-header");
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");

  function onScroll() {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 12 || header.classList.contains("scrolled-lock"));
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = !nav.classList.contains("open");
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var INTERESTS = { Demo: true, Pilot: true, Pricing: true, Other: true };
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function setFieldError(form, name, message) {
    var input = form.elements[name];
    var err = form.querySelector('[data-error-for="' + name + '"]');
    if (input) {
      if (message) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
    if (err) {
      err.hidden = !message;
      err.textContent = message || "";
    }
  }

  function clearErrors(form) {
    ["name", "email", "company", "phone", "title"].forEach(function (name) {
      setFieldError(form, name, "");
    });
    var status = form.querySelector(".form-status");
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
  }

  function showStatus(form, message) {
    var status = form.querySelector(".form-status");
    if (!status) return;
    status.hidden = !message;
    status.textContent = message || "";
    if (message) {
      var submit = form.querySelector(".form-submit") || status;
      if (submit && submit.scrollIntoView) submit.scrollIntoView({ block: "nearest" });
    }
  }

  function validate(form) {
    clearErrors(form);
    var values = {
      name: String(form.elements.name && form.elements.name.value || "").trim(),
      email: String(form.elements.email && form.elements.email.value || "").trim(),
      company: String(form.elements.company && form.elements.company.value || "").trim(),
      phone: String(form.elements.phone && form.elements.phone.value || "").trim(),
      title: String(form.elements.title && form.elements.title.value || "").trim(),
      interest: String(form.elements.interest && form.elements.interest.value || "").trim(),
      message: String(form.elements.message && form.elements.message.value || "").trim(),
      company_url: String(form.elements.company_url && form.elements.company_url.value || "").trim()
    };
    var ok = true;
    if (!values.name) { setFieldError(form, "name", "Enter your name."); ok = false; }
    if (!values.email) { setFieldError(form, "email", "Enter your work email."); ok = false; }
    else if (!EMAIL_RE.test(values.email)) { setFieldError(form, "email", "Enter a valid work email address."); ok = false; }
    if (!values.company) { setFieldError(form, "company", "Enter your company."); ok = false; }
    if (!values.phone) { setFieldError(form, "phone", "Enter your phone number."); ok = false; }
    else if (values.phone.replace(/\D/g, "").length < 7) { setFieldError(form, "phone", "Enter a valid phone number."); ok = false; }
    if (!values.title) { setFieldError(form, "title", "Enter your job title."); ok = false; }
    if (values.interest && !INTERESTS[values.interest]) { values.interest = ""; }
    return { ok: ok, values: values };
  }

  function turnstileToken(form) {
    var input = form.querySelector('[name="cf-turnstile-response"]');
    if (input && input.value) return input.value;
    if (window.turnstile && typeof window.turnstile.getResponse === "function") {
      try { return window.turnstile.getResponse() || ""; } catch (e) { return ""; }
    }
    return "";
  }

  function resetTurnstile() {
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      try { window.turnstile.reset(); } catch (e) { /* ignore */ }
    }
  }

  function showSuccess(root) {
    var formPanel = root.querySelector('[data-contact-panel="form"]');
    var successPanel = root.querySelector('[data-contact-panel="success"]');
    if (formPanel) formPanel.hidden = true;
    if (successPanel) {
      successPanel.hidden = false;
      var heading = successPanel.querySelector("h1, h2");
      if (heading) heading.focus && heading.setAttribute("tabindex", "-1");
      if (heading) heading.focus();
    }
  }

  function resetPanels(root) {
    var formPanel = root.querySelector('[data-contact-panel="form"]');
    var successPanel = root.querySelector('[data-contact-panel="success"]');
    var form = root.querySelector(".contact-form");
    if (formPanel) formPanel.hidden = false;
    if (successPanel) successPanel.hidden = true;
    if (form) {
      form.reset();
      clearErrors(form);
      form.classList.remove("is-submitting");
    }
    resetTurnstile();
  }

  function bindForm(form, root) {
    if (!form || form.__sphereBound) return;
    form.__sphereBound = true;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var result = validate(form);
      if (!result.ok) {
        var firstInvalid = form.querySelector('[aria-invalid="true"]');
        if (firstInvalid) firstInvalid.focus();
        return;
      }
      var token = turnstileToken(form);
      if (!token) {
        showStatus(form, "Please complete the verification check, then try again.");
        return;
      }
      form.classList.add("is-submitting");
      showStatus(form, "");
      var payload = {
        name: result.values.name,
        email: result.values.email,
        company: result.values.company,
        phone: result.values.phone,
        title: result.values.title,
        interest: result.values.interest,
        message: result.values.message,
        company_url: result.values.company_url,
        "cf-turnstile-response": token
      };
      fetch(form.getAttribute("action") || "/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            return { res: res, body: body };
          });
        })
        .then(function (out) {
          if (out.res.ok && out.body && out.body.ok) {
            showSuccess(root);
            return;
          }
          var message = (out.body && out.body.error) || "We couldn’t send your message. Please try again in a moment.";
          showStatus(form, message);
          resetTurnstile();
        })
        .catch(function () {
          showStatus(form, "We couldn’t send your message. Check your connection and try again.");
          resetTurnstile();
        })
        .then(function () {
          form.classList.remove("is-submitting");
        });
    });
  }

  var modal = document.getElementById("contact-modal");
  var lastFocus = null;

  function trapKey(event) {
    if (!modal || modal.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab") return;
    var nodes = $all(FOCUSABLE, modal).filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
    if (!nodes.length) return;
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openModal() {
    if (!modal) return;
    lastFocus = document.activeElement;
    resetPanels(modal);
    modal.hidden = false;
    document.body.classList.add("contact-open");
    document.addEventListener("keydown", trapKey);
    var dialog = modal.querySelector(".contact-dialog");
    var firstField = modal.querySelector("#name");
    (firstField || dialog).focus();
    if (window.turnstile && typeof window.turnstile.render === "function") {
      var widget = modal.querySelector(".cf-turnstile");
      if (widget && !widget.getAttribute("data-widget-id")) {
        try { window.turnstile.render(widget); } catch (e) { /* already rendered */ }
      }
    }
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("contact-open");
    document.removeEventListener("keydown", trapKey);
    resetPanels(modal);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  if (modal) {
    bindForm($(".contact-form", modal), modal);
    $all("[data-close-contact]", modal).forEach(function (el) {
      el.addEventListener("click", function (event) {
        event.preventDefault();
        closeModal();
      });
    });
  }

  var pageRoot = document.querySelector("[data-contact-root]");
  if (pageRoot) bindForm($(".contact-form", pageRoot), pageRoot);

  document.addEventListener("click", function (event) {
    var link = event.target.closest("[data-open-contact]");
    if (!link) return;
    if (!modal) return;
    event.preventDefault();
    if (nav && toggle) {
      nav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
    openModal();
  });

  if (modal && (location.hash === "#contact" || /[?&]contact=1(?:&|$)/.test(location.search))) {
    openModal();
  }
})();
