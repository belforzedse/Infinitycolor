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
  assert.match(forms, /"\/infinity\/otp\/start"/);
  assert.doesNotMatch(forms, /"\/infinity\/phone-status"/);
  assert.match(forms, /"در حال ارسال\.\.\."\s*:\s*"دریافت کد تأیید"/);
});

test("OTP destinations isolate phone numbers from surrounding RTL copy", () => {
  const forms = fs.readFileSync(
    path.join(appRoot, "src/components/auth/forms.tsx"),
    "utf8",
  );

  const isolatedPhone = /<bdi dir="ltr">\{phone\}<\/bdi>/g;
  assert.equal(forms.match(isolatedPhone)?.length, 2);
  assert.doesNotMatch(forms, /subtitle=\{`[^`]*\$\{phone\}[^`]*`\}/);
});

test("central auth uses the canonical Infinity favicon", () => {
  const authFavicon = fs.readFileSync(
    path.join(appRoot, "src/app/favicon.ico"),
  );
  const storefrontFavicon = fs.readFileSync(
    path.resolve(appRoot, "../frontend/src/app/favicon.ico"),
  );

  assert.deepEqual(authFavicon, storefrontFavicon);
});

test("OTP onboarding routing uses durable profile completion instead of pre-auth state", () => {
  const plugin = fs.readFileSync(
    path.join(appRoot, "src/server/infinity-plugin.ts"),
    "utf8",
  );
  const flowState = fs.readFileSync(
    path.join(appRoot, "src/server/flow-state.ts"),
    "utf8",
  );
  const forms = fs.readFileSync(
    path.join(appRoot, "src/components/auth/forms.tsx"),
    "utf8",
  );
  const registrationForm = forms.slice(
    forms.indexOf("export function RegistrationInfoForm"),
  );

  assert.match(plugin, /if \(verified\.needsProfileCompletion === true\)/);
  assert.doesNotMatch(plugin, /flow\.hasUser/);
  assert.doesNotMatch(flowState, /hasUser\??:/);
  assert.match(registrationForm, /authGet<[\s\S]*?>\("\/infinity\/profile"\)/);
  assert.doesNotMatch(
    registrationForm,
    /if \(flowReady && !phone\) go\("\/auth"\)/,
  );
});
