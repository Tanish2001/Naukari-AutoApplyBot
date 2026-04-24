// ============================================================
// filters.js — external-site detection helpers
// ============================================================

const NAUKRI_DOMAINS = [
  "naukri.com",
  "naukri.com/",
  "www.naukri.com",
];

/**
 * Returns true if a job listing should be SKIPPED (external redirect).
 * Checks DOM signals on the job card / apply button.
 */
export function isExternalApplyJob(applyBtn) {
  if (!applyBtn) return true; // no button = skip

  // 1. data attribute flags set by Naukri
  const card = applyBtn.closest("[data-job-id], .jobTuple, .job-tittle-wrap, article");
  if (card) {
    const ext = card.getAttribute("data-is-external");
    const redirect = card.getAttribute("data-redirect");
    if (ext === "true" || redirect === "true" || redirect === "1") return true;
  }

  // 2. The button itself has an href pointing outside naukri
  const href = applyBtn.getAttribute("href") || applyBtn.getAttribute("data-href") || "";
  if (href && !isNaukriUrl(href)) return true;

  // 3. Button text hints ("Apply on company site", "Apply on LinkedIn", etc.)
  const btnText = (applyBtn.textContent || "").toLowerCase();
  const externalPhrases = [
    "apply on company",
    "apply at company",
    "apply on linkedin",
    "apply on indeed",
    "external apply",
    "visit company",
    "company website",
  ];
  if (externalPhrases.some((p) => btnText.includes(p))) return true;

  // 4. onclick opens a new tab to a non-naukri domain
  const onclickAttr = applyBtn.getAttribute("onclick") || "";
  if (onclickAttr.includes("window.open") || onclickAttr.includes("_blank")) {
    // If it opens to an external URL
    const urlMatch = onclickAttr.match(/https?:\/\/[^'"]+/);
    if (urlMatch && !isNaukriUrl(urlMatch[0])) return true;
  }

  return false;
}

function isNaukriUrl(url) {
  try {
    const parsed = new URL(url, "https://www.naukri.com");
    return NAUKRI_DOMAINS.some((d) => parsed.hostname.endsWith(d));
  } catch {
    return url.startsWith("/") || url === ""; // relative = internal
  }
}

// ============================================================
// form-mapper.js — fuzzy label → profile key mapping
// ============================================================

/**
 * Maps form field labels (lowercased, trimmed) to profile keys.
 * Supports partial / fuzzy matches.
 */
const LABEL_MAP = [
  // Full name variants
  { keys: ["full name", "your name", "name", "applicant name", "candidate name"], profile: "fullName" },

  // Email
  { keys: ["email", "email id", "email address", "e-mail", "mail id"], profile: "email" },

  // Phone
  { keys: ["mobile", "phone", "contact number", "mobile number", "phone number", "contact no"], profile: "phone" },

  // Experience
  {
    keys: ["total experience", "years of experience", "experience", "work experience", "total exp", "exp (years)", "experience (yrs)", "experience in years"],
    profile: "totalExpYears",
  },

  // Current CTC
  {
    keys: ["current ctc", "current salary", "present ctc", "current package", "ctc (current)", "existing ctc", "last drawn"],
    profile: "currentCTC",
  },

  // Expected CTC
  {
    keys: ["expected ctc", "expected salary", "desired ctc", "expected package", "ctc (expected)", "salary expectation"],
    profile: "expectedCTC",
  },

  // Notice period
  {
    keys: ["notice period", "notice", "joining period", "availability", "available in", "days notice", "notice (days)"],
    profile: "noticePeriodDays",
  },

  // Location
  {
    keys: ["current location", "present location", "current city", "city", "location"],
    profile: "currentLocation",
  },

  // Preferred location
  {
    keys: ["preferred location", "preferred city", "desired location", "work location preference"],
    profile: "preferredLocations",
  },
];

/**
 * Given a field label string, return the matching profile key or null.
 */
export function labelToProfileKey(labelText) {
  const normalized = labelText.toLowerCase().replace(/[*:]/g, "").trim();

  for (const entry of LABEL_MAP) {
    // Exact match first
    if (entry.keys.includes(normalized)) return entry.profile;
    // Partial match
    if (entry.keys.some((k) => normalized.includes(k) || k.includes(normalized))) {
      return entry.profile;
    }
  }
  return null;
}

/**
 * Given a DOM input/select element, try to find its label and map to profile.
 * Checks: <label for=id>, aria-label, placeholder, name attr, parent label text.
 */
export function getFieldProfileKey(el) {
  const labelSources = [];

  // 1. <label for="...">
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) labelSources.push(label.textContent);
  }

  // 2. aria-label
  if (el.getAttribute("aria-label")) labelSources.push(el.getAttribute("aria-label"));

  // 3. placeholder
  if (el.placeholder) labelSources.push(el.placeholder);

  // 4. name attribute
  if (el.name) labelSources.push(el.name.replace(/[-_]/g, " "));

  // 5. Closest parent label
  const parentLabel = el.closest("label");
  if (parentLabel) labelSources.push(parentLabel.textContent);

  // 6. Preceding sibling / parent div label text
  const wrapper = el.closest("div, li, tr, td");
  if (wrapper) {
    const labelEl = wrapper.querySelector("label, .label, .field-label, span.title, p.label");
    if (labelEl) labelSources.push(labelEl.textContent);
  }

  for (const src of labelSources) {
    const key = labelToProfileKey(src);
    if (key) return key;
  }

  return null;
}

/**
 * Human-like random delay in milliseconds between min and max seconds.
 */
export function randomDelay(minSec = 3, maxSec = 10) {
  const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a DOM element to appear (polling), resolves with element or null on timeout.
 */
export function waitForElement(selector, timeoutMs = 8000, rootEl = document) {
  return new Promise((resolve) => {
    const existing = rootEl.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = rootEl.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(rootEl.body || rootEl, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Simulate a human typing into an input (fires input/change events).
 */
export function humanFill(el, value) {
  el.focus();
  el.value = "";
  // Trigger React's synthetic event system
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value"
  )?.set;

  if (el.tagName === "SELECT") {
    if (nativeSelectValueSetter) nativeSelectValueSetter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    if (nativeInputValueSetter) nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }
  el.blur();
}
