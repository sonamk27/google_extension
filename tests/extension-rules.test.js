import test from "node:test";
import assert from "node:assert/strict";

import {
  isSensitiveFieldAttributes,
  valueLooksLikePII,
  EMAIL_PATTERN,
  CARD_PATTERN
} from "../extension/lib/privacyRules.js";

import {
  computeScaleFactors,
  transformBoxToCanvas,
  calculateRedactionRects
} from "../extension/lib/redactionMath.js";

test("Privacy Rules - Email Detection", () => {
  assert.equal(EMAIL_PATTERN.test("user@example.com"), true);
  assert.equal(EMAIL_PATTERN.test("invalid-email"), false);
  assert.equal(valueLooksLikePII("test.user@company.org"), true);
  assert.equal(valueLooksLikePII("regular text content"), false);
});

test("Privacy Rules - Credit Card Detection", () => {
  assert.equal(CARD_PATTERN.test("4532 0150 1234 5678"), true);
  assert.equal(CARD_PATTERN.test("1234"), false);
  assert.equal(valueLooksLikePII("4532-0150-1234-5678"), true);
});

test("Privacy Rules - Sensitive Field Attributes Detection", () => {
  // Password input type
  assert.equal(
    isSensitiveFieldAttributes({ type: "password", name: "pwd" }),
    true
  );

  // Sensitive autocomplete attribute
  assert.equal(
    isSensitiveFieldAttributes({ type: "text", autocomplete: "cc-number" }),
    true
  );

  // Keyword in name or id
  assert.equal(
    isSensitiveFieldAttributes({ type: "text", name: "user_ssn_field" }),
    true
  );

  // Keyword in associated label
  assert.equal(
    isSensitiveFieldAttributes({ type: "text", name: "fld1", labelText: "Enter your OTP code" }),
    true
  );

  // Prefilled value looks like PII
  assert.equal(
    isSensitiveFieldAttributes({ type: "text", name: "customInput", value: "secret@domain.com" }),
    true
  );

  // Safe non-sensitive input
  assert.equal(
    isSensitiveFieldAttributes({ type: "text", name: "searchQuery", placeholder: "Search docs...", labelText: "Search" }),
    false
  );
});

test("Redaction Math - Viewport and DPR Scaling", () => {
  // Windows 125% or 150% display scaling simulation
  // Natural image width = 1920, CSS viewport width = 1280 (1.5x)
  const { scaleX, scaleY } = computeScaleFactors(1920, 1080, { w: 1280, h: 720 });
  assert.equal(scaleX, 1.5);
  assert.equal(scaleY, 1.5);

  const domBox = { x: 100, y: 50, w: 200, h: 30 };
  const margin = 3;
  const transformed = transformBoxToCanvas(domBox, scaleX, scaleY, margin);

  // x = 100 * 1.5 - 3 = 147
  // y = 50 * 1.5 - 3 = 72
  // w = 200 * 1.5 + 6 = 306
  // h = 30 * 1.5 + 6 = 51
  assert.deepEqual(transformed, {
    x: 147,
    y: 72,
    w: 306,
    h: 51
  });
});

test("Redaction Math - Boundary clipping & safety margin", () => {
  const domBoxNearZero = { x: 1, y: 1, w: 10, h: 10 };
  const rects = calculateRedactionRects(1000, 1000, { w: 1000, h: 1000 }, [domBoxNearZero], 5);
  assert.equal(rects.length, 1);
  // Math.max(0, 1 * 1 - 5) => 0
  assert.equal(rects[0].x, 0);
  assert.equal(rects[0].y, 0);
});
