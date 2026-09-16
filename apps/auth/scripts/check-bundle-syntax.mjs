#!/usr/bin/env node
/* eslint-disable no-console -- reporting script; stdout is the product */
/**
 * Client-bundle syntax floor guard for the central auth app.
 *
 * The login page is the one screen a customer cannot route around, and it is
 * useless without hydration: the phone form submits through `onSubmit`, so if
 * any eagerly-loaded chunk fails to PARSE, React never attaches the handler and
 * the button falls back to a native GET (`/auth?phone=...`) that never reaches
 * Better Auth. That is a silent failure — no console error reaches Sentry,
 * because the bundle that would report it is the one that did not parse.
 *
 * This happened: a class static initialization block (Chromium 94 / Samsung
 * Internet 17) reached production while the storefront was downleveled to
 * Samsung Internet 12, so shoppers could browse but not log in.
 *
 * Parses every emitted client chunk and fails when one needs a newer engine
 * than `browserslist` in package.json promises.
 *
 *   node scripts/check-bundle-syntax.mjs           # guard (exit 1 on regression)
 *   node scripts/check-bundle-syntax.mjs --json    # machine-readable
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chunkDir = join(appRoot, ".next/static/chunks");

/**
 * Minimum engine per syntax construct, taken from @babel/compat-data's
 * `plugins.json` (the same table browserslist-driven lowering consults), so
 * these numbers move with the toolchain rather than with folklore.
 */
const FEATURES = {
  StaticBlock: { label: "class static block", chrome: 94, samsung: 17 },
  ChainExpression: { label: "optional chaining (?.)", chrome: 91, samsung: 16 },
  Nullish: { label: "nullish coalescing (??)", chrome: 80, samsung: 13 },
  LogicalAssign: { label: "logical assignment (??=)", chrome: 85, samsung: 14 },
  PrivateIdentifier: { label: "private class member (#x)", chrome: 84, samsung: 14 },
  PropertyDefinition: { label: "class fields", chrome: 74, samsung: 11 },
};

/** The floor package.json promises. Parsed so the guard cannot drift from it. */
function declaredFloor() {
  const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
  const list = pkg.browserslist ?? [];
  const read = (prefix) => {
    const hit = list.find((q) => q.startsWith(prefix));
    return hit ? Number(hit.slice(prefix.length).trim()) : null;
  };
  return { chrome: read("chrome >="), samsung: read("samsung >=") };
}

function featureKey(node) {
  if (node.type === "LogicalExpression" && node.operator === "??") return "Nullish";
  if (node.type === "AssignmentExpression" && ["??=", "||=", "&&="].includes(node.operator))
    return "LogicalAssign";
  return node.type;
}

function scan(source) {
  const hits = new Map();
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    const key = featureKey(node);
    if (FEATURES[key]) hits.set(key, (hits.get(key) ?? 0) + 1);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object" && typeof child.type === "string") visit(child);
    }
  };
  // Turbopack emits classic scripts today; if that ever changes this throws loudly
  // rather than silently passing, which is the failure mode we want.
  visit(parse(source, { ecmaVersion: "latest", sourceType: "script" }));
  return hits;
}

const floor = declaredFloor();
if (floor.chrome === null || floor.samsung === null) {
  console.error(
    "no `chrome >=` / `samsung >=` entry in package.json browserslist — " +
      "the auth bundle would inherit Next's modern default and silently drop old Samsung Internet.",
  );
  process.exit(1);
}
if (!existsSync(chunkDir)) {
  console.error(`no client chunks at ${chunkDir} — run \`next build\` first.`);
  process.exit(1);
}

const violations = [];
let worst = { chrome: 0, samsung: 0, why: "none" };

for (const file of readdirSync(chunkDir).filter((n) => n.endsWith(".js")).sort()) {
  let hits;
  try {
    hits = scan(readFileSync(join(chunkDir, file), "utf8"));
  } catch (error) {
    violations.push({ file, feature: "unparseable", detail: error.message });
    continue;
  }
  for (const [key, count] of hits) {
    const f = FEATURES[key];
    if (f.chrome > worst.chrome) worst = { chrome: f.chrome, samsung: f.samsung, why: `${f.label} in ${file}` };
    if (f.chrome > floor.chrome || f.samsung > floor.samsung) {
      violations.push({
        file,
        feature: f.label,
        count,
        needs: `Chrome >= ${f.chrome} / Samsung Internet >= ${f.samsung}`,
      });
    }
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ floor, worst, violations }, null, 2));
} else {
  console.log(`declared floor : Chrome >= ${floor.chrome} / Samsung Internet >= ${floor.samsung}`);
  console.log(`actual bundle  : Chrome >= ${worst.chrome} / Samsung Internet >= ${worst.samsung} (${worst.why})`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.feature}${v.count ? ` ×${v.count}` : ""} needs ${v.needs ?? v.detail}`);
  }
}

if (violations.length) {
  console.error(
    `\n${violations.length} chunk/feature pair(s) exceed the declared floor. ` +
      `On a browser below it the chunk fails to parse, hydration never runs, and the login form silently stops working.`,
  );
  process.exit(1);
}
console.log("OK — every client chunk parses within the declared browserslist floor.");
