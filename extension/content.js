// content.js
// Runs inside the actual web page. Two jobs only:
//   1. Extract a structured, privacy-aware description of visible interactive elements.
//   2. Execute a single UI action (click / scroll / type) handed back from the server.
// No network calls happen here - this file never talks to anything outside the page.

const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [onclick], [tabindex]';

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
    return false;
  }
  // must be at least partially inside the viewport
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CARD_PATTERN = /^(?:\d[ -]*?){13,19}$/;
const SENSITIVE_KEYWORDS = [
  "password", "passwd", "ssn", "aadhar", "aadhaar", "email", "e-mail",
  "phone", "mobile", "card", "cvv", "cvc", "otp", "pin", "account", "iban", "routing"
];

function getAssociatedLabelText(el) {
  let text = "";
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) text += " " + label.innerText;
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) text += " " + wrappingLabel.innerText;

  const ariaLabelledBy = el.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    for (const id of ariaLabelledBy.split(/\s+/)) {
      const labelEl = document.getElementById(id);
      if (labelEl) text += " " + labelEl.innerText;
    }
  }
  return text.toLowerCase();
}

function valueLooksLikePII(value) {
  if (!value) return false;
  const v = value.trim();
  if (EMAIL_PATTERN.test(v)) return true;
  if (CARD_PATTERN.test(v.replace(/[ -]/g, "")) && v.replace(/\D/g, "").length >= 13) return true;
  return false;
}

function isSensitiveField(el) {
  const type = (el.getAttribute("type") || "").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  const name = (el.getAttribute("name") || "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
  const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();

  const sensitiveTypes = ["password", "email", "tel"];
  const sensitiveAutocomplete = [
    "cc-number", "cc-csc", "cc-exp", "cc-name",
    "current-password", "new-password",
    "email", "tel", "street-address", "postal-code"
  ];

  // 1. Explicit HTML signals (fast, exact when present)
  if (sensitiveTypes.includes(type)) return true;
  if (sensitiveAutocomplete.some((a) => autocomplete.includes(a))) return true;
  if (SENSITIVE_KEYWORDS.some((k) => name.includes(k) || id.includes(k) || placeholder.includes(k) || ariaLabel.includes(k))) {
    return true;
  }

  // 2. Associated <label> text - catches fields with no semantic attributes,
  //    which is common in component-library-generated forms (React/MUI/etc).
  const labelText = getAssociatedLabelText(el);
  if (SENSITIVE_KEYWORDS.some((k) => labelText.includes(k))) return true;

  // 3. Content-based: the actual typed/prefilled value looks like an email
  //    or a card number, regardless of how the field itself is named.
  if (valueLooksLikePII(el.value)) return true;

  return false;
}

function extractDomStructure(maxElements = 150) {
  const elements = [];
  const nodes = document.querySelectorAll(INTERACTIVE_SELECTOR);
  let idCounter = 0;

  for (const el of nodes) {
    if (elements.length >= maxElements) break;
    if (!isVisible(el)) continue;

    const rect = el.getBoundingClientRect();
    const sensitive = isSensitiveField(el);
    const agentId = `agent-el-${idCounter++}`;
    el.setAttribute("data-agent-id", agentId);

    const rawText =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      el.value ||
      "";

    elements.push({
      agentId,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      type: el.getAttribute("type") || null,
      text: sensitive ? null : rawText.trim().slice(0, 80),
      bbox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      },
      sensitive
    });
  }
  return elements;
}

function getSensitiveBoxes(elements) {
  return elements.filter((e) => e.sensitive).map((e) => e.bbox);
}

function executeAction(action) {
  try {
    if (action.type === "click") {
      const el = document.querySelector(`[data-agent-id="${action.targetId}"]`);
      if (!el) return { ok: false, error: "target not found" };
      el.click();
      return { ok: true };
    }
    if (action.type === "scroll") {
      window.scrollBy({ top: action.deltaY || 400, behavior: "smooth" });
      return { ok: true };
    }
    if (action.type === "type") {
      const el = document.querySelector(`[data-agent-id="${action.targetId}"]`);
      if (!el) return { ok: false, error: "target not found" };
      el.focus();
      el.value = action.value || "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    }
    if (action.type === "none") {
      return { ok: true, note: "no action requested" };
    }
    return { ok: false, error: `unknown action type: ${action.type}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

console.log("[content.js] loaded and listening on this page");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "EXTRACT_DOM") {
    console.log("[content.js] received EXTRACT_DOM");
    const elements = extractDomStructure();
    sendResponse({
      elements,
      sensitiveBoxes: getSensitiveBoxes(elements),
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      }
    });
    return true;
  }
  if (msg.type === "EXECUTE_ACTION") {
    sendResponse(executeAction(msg.action));
    return true;
  }
});
