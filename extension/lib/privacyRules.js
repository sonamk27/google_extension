// extension/lib/privacyRules.js
// Pure functions for detecting PII and sensitive inputs.
// Compatible with both Node.js (ESM test runner) and browser content scripts.

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CARD_PATTERN = /^(?:\d[ -]*?){13,19}$/;
export const SENSITIVE_KEYWORDS = [
  "password", "passwd", "ssn", "aadhar", "aadhaar", "email", "e-mail",
  "phone", "mobile", "card", "cvv", "cvc", "otp", "pin", "account", "iban", "routing"
];

export const SENSITIVE_TYPES = ["password", "email", "tel"];
export const SENSITIVE_AUTOCOMPLETE = [
  "cc-number", "cc-csc", "cc-exp", "cc-name",
  "current-password", "new-password",
  "email", "tel", "street-address", "postal-code"
];

export function valueLooksLikePII(value) {
  if (!value || typeof value !== "string") return false;
  const v = value.trim();
  if (EMAIL_PATTERN.test(v)) return true;
  if (CARD_PATTERN.test(v.replace(/[ -]/g, "")) && v.replace(/\D/g, "").length >= 13) return true;
  return false;
}

export function isSensitiveFieldAttributes({ type = "", autocomplete = "", name = "", id = "", placeholder = "", ariaLabel = "", labelText = "", value = "" } = {}) {
  const t = type.toLowerCase();
  const ac = autocomplete.toLowerCase();
  const n = name.toLowerCase();
  const i = id.toLowerCase();
  const p = placeholder.toLowerCase();
  const al = ariaLabel.toLowerCase();
  const lbl = labelText.toLowerCase();

  // 1. Explicit HTML types
  if (SENSITIVE_TYPES.includes(t)) return true;

  // 2. Autocomplete attributes
  if (SENSITIVE_AUTOCOMPLETE.some((a) => ac.includes(a))) return true;

  // 3. Keywords in id, name, placeholder, or aria-label
  if (SENSITIVE_KEYWORDS.some((k) => n.includes(k) || i.includes(k) || p.includes(k) || al.includes(k))) {
    return true;
  }

  // 4. Associated label text
  if (SENSITIVE_KEYWORDS.some((k) => lbl.includes(k))) return true;

  // 5. Value looks like PII
  if (valueLooksLikePII(value)) return true;

  return false;
}

// Global attachment for browser scripts
if (typeof globalThis !== "undefined") {
  globalThis.PrivacyRules = {
    EMAIL_PATTERN,
    CARD_PATTERN,
    SENSITIVE_KEYWORDS,
    SENSITIVE_TYPES,
    SENSITIVE_AUTOCOMPLETE,
    valueLooksLikePII,
    isSensitiveFieldAttributes
  };
}
