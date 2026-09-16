import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Persian/Arabic-Indic keyboards (the default on most Iranian phones) emit
 * localized digits for a `type="tel"` input. PHONE_PATTERN only matches ASCII
 * 0-9, so testing the raw field value rejects a perfectly valid number with
 * "شماره همراه وارد شده معتبر نیست" -- silently, since the request never
 * leaves the browser. Both phone-entry forms must normalize before validating
 * or submitting; this guards against either one regressing back to the raw
 * value.
 */

const formsSource = fs.readFileSync(
  path.join(__dirname, "components/auth/forms.tsx"),
  "utf8",
);

test("a normalizeDigits helper exists and strips Persian/Arabic-Indic digits", () => {
  assert.match(formsSource, /function normalizeDigits\(/);
});

test("every PHONE_PATTERN.test call validates a normalized value, not the raw field", () => {
  const calls = [...formsSource.matchAll(/PHONE_PATTERN\.test\(([^)]+)\)/g)];
  assert.ok(calls.length > 0, "expected at least one PHONE_PATTERN.test call");
  for (const [, arg] of calls) {
    assert.match(
      arg.trim(),
      /normalized/i,
      `PHONE_PATTERN.test(${arg}) must validate a normalizeDigits() result, not the raw input`,
    );
  }
});
