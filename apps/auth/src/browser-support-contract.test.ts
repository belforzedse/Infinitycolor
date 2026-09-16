import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The login page is the one screen a customer cannot route around, and it only
 * works once React hydrates: the phone form submits through `onSubmit`, so a
 * chunk that fails to PARSE leaves the button falling back to a native GET
 * (`/auth?phone=...`) that never reaches Better Auth. Nothing reports that —
 * the bundle that would have reported it is the one that did not parse.
 *
 * Without an explicit `browserslist`, Next/Turbopack picks its own modern
 * default. That shipped a class static initialization block (Samsung Internet
 * 17+) into the eagerly-loaded app-router chunk while the storefront was
 * downleveled to Samsung Internet 12, so shoppers on an older Samsung Internet
 * could browse the shop but silently could not log in.
 *
 * This contract keeps the auth floor from drifting above the storefront's.
 * `scripts/check-bundle-syntax.mjs` is the matching post-build check that the
 * emitted chunks actually honour it.
 */

const authPkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { browserslist?: string[] };

const storefrontPkg = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "frontend", "package.json"),
    "utf8",
  ),
) as { browserslist?: string[] };

function floorFor(list: string[] | undefined, prefix: string): number {
  assert.ok(list, "package.json must declare an explicit browserslist");
  const query = list.find((entry) => entry.startsWith(prefix));
  assert.ok(query, `browserslist must pin a \`${prefix}\` floor`);
  const version = Number(query.slice(prefix.length).trim());
  assert.ok(Number.isFinite(version), `\`${query}\` must end in a version`);
  return version;
}

test("auth declares an explicit browserslist floor", () => {
  assert.ok(
    Array.isArray(authPkg.browserslist) && authPkg.browserslist.length > 0,
    "apps/auth/package.json must declare browserslist; without it Next's modern " +
      "default emits syntax that older Samsung Internet cannot parse, which breaks " +
      "login silently",
  );
});

test("auth never demands a newer engine than the storefront it guards", () => {
  for (const prefix of ["chrome >=", "samsung >="]) {
    const auth = floorFor(authPkg.browserslist, prefix);
    const storefront = floorFor(storefrontPkg.browserslist, prefix);
    assert.ok(
      auth <= storefront,
      `auth requires \`${prefix} ${auth}\` but the storefront supports ` +
        `\`${prefix} ${storefront}\`. A customer who can browse the shop must be ` +
        `able to reach the login form that guards it.`,
    );
  }
});

test("auth still supports the Samsung Internet seen in production", () => {
  // SM-T355Y (Android 7.1.1) reached the login form on Samsung Internet 16
  // (Chromium 92) and could not submit it. Class static blocks need Samsung
  // Internet 17, so the floor must stay at or below 16.
  const samsung = floorFor(authPkg.browserslist, "samsung >=");
  assert.ok(
    samsung <= 16,
    `browserslist floor \`samsung >= ${samsung}\` excludes Samsung Internet 16, ` +
      "which real customers use on Android 7.1.1 tablets",
  );
});
