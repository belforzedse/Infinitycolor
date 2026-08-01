import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("Peyda Fanum remains owned by next/font instead of a fallback override", () => {
  const globals = fs.readFileSync(
    path.join(appRoot, "src/app/globals.css"),
    "utf8",
  );

  assert.doesNotMatch(globals, /--font-peyda-fanum\s*:/);
  assert.match(
    globals,
    /font-family:\s*var\(--font-peyda-fanum\),\s*sans-serif/,
  );
});

test("phone collection exposes browser autofill and an associated label", () => {
  const forms = fs.readFileSync(
    path.join(appRoot, "src/components/auth/forms.tsx"),
    "utf8",
  );

  assert.match(forms, /<FieldLabel htmlFor="phone"/);
  assert.match(forms, /id="phone"[\s\S]*name="phone"[\s\S]*type="tel"/);
  assert.match(forms, /inputMode="tel"[\s\S]*autoComplete="tel"/);
  assert.match(forms, /<form[\s\S]*autoComplete="on"/);
  assert.match(
    forms,
    /id="reset-phone"[\s\S]*name="phone"[\s\S]*type="tel"[\s\S]*autoComplete="tel"/,
  );
  assert.match(
    forms,
    /id="login-phone"[\s\S]*name="username"[\s\S]*autoComplete="username"/,
  );
});
