#!/usr/bin/env node
/* eslint-disable no-console -- reporting script; stdout is the product */
/**
 * Storefront client-bundle guard and report.
 *
 * Reads `.next/diagnostics/route-bundle-stats.json` (emitted by `next build`)
 * and, for the storefront routes we care about, reports first-load JS and
 * checks that code which has no business in a storefront bundle stays out of
 * the first-load set.
 *
 * The markers are minification-proof string literals, not identifiers: a
 * mangled build still contains `createDiffieHellman`, `INSPECT_MAX_BYTES`,
 * `rrweb`, `getCoreRowModel`, `arrayLimit`.
 *
 *   node scripts/check-client-bundle.mjs                 # report + guard
 *   node scripts/check-client-bundle.mjs --json          # machine-readable
 *   node scripts/check-client-bundle.mjs --baseline p.json  # diff a baseline
 *
 * Exits non-zero when a forbidden marker is present or a route exceeds its
 * budget, so it can gate CI once the budgets in docs/perf are adopted.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statsPath = join(appRoot, ".next/diagnostics/route-bundle-stats.json");

/** Routes whose first-load cost the storefront actually pays. */
const ROUTES = ["/", "/plp/category/[slug]", "/plp", "/pdp/[slug]", "/about"];

/**
 * Per-route first-load budgets in raw (uncompressed) bytes. Deliberately set
 * just above the current measured value so unrelated growth is caught, and
 * meant to be ratcheted down as the remediation plan lands.
 */
const BUDGETS = {
  "/": 1_445_000,
  "/plp/category/[slug]": 1_368_000,
  "/plp": 1_368_000,
  "/pdp/[slug]": 1_550_000,
  "/about": 1_238_000,
};

/**
 * Code that must not appear in any storefront first-load chunk, with the
 * import boundary that put it there last time.
 */
const FORBIDDEN = [
  {
    id: "crypto-browserify",
    needles: ["createDiffieHellman", "pbkdf2", "createHmac"],
    minHits: 2,
    why: "a client module imported the @repo/auth-core package root (use a subpath such as @repo/auth-core/iran-phone)",
  },
  {
    id: "buffer-polyfill",
    needles: ["INSPECT_MAX_BYTES", "toByteArray", "fromByteArray"],
    minHits: 2,
    why: "a client module used a bare `Buffer` identifier (reach it via globalThis.Buffer, or prefer atob)",
  },
  {
    id: "tanstack-table",
    needles: ["getCoreRowModel", "_getAllVisibleCells"],
    minHits: 2,
    why: "storefront code imported @/components/SuperAdmin/** (shared state belongs in src/atoms/)",
  },
  {
    id: "qs",
    needles: ["arrayLimit", "allowSparse", "strictNullHandling"],
    minHits: 2,
    why: "qs is admin-only; storefront query state uses nuqs",
  },
  {
    id: "sentry-replay",
    needles: ["rrweb", "_experiments.captureExceptions"],
    minHits: 2,
    why: "Session Replay must load lazily, not in the first-load set (see src/lib/sentry-replay.ts)",
  },
];

/**
 * Markers that are reported but not fatal. Empty: everything in FORBIDDEN is
 * currently absent from the storefront first-load set, so any reappearance is a
 * regression rather than a known state.
 */
const WATCH = new Set();

function loadStats(p) {
  if (!existsSync(p)) {
    console.error(`missing ${p} — run \`pnpm build\` first`);
    process.exit(2);
  }
  const stats = JSON.parse(readFileSync(p, "utf8"));
  return new Map(stats.map((e) => [e.route, e]));
}

function chunkBytes(paths) {
  let total = 0;
  for (const p of paths) {
    const fp = join(appRoot, p);
    if (existsSync(fp)) total += statSync(fp).size;
  }
  return total;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const baselineIdx = args.indexOf("--baseline");
const baseline = baselineIdx !== -1 ? loadStats(resolve(args[baselineIdx + 1])) : null;

const byRoute = loadStats(statsPath);
const present = ROUTES.filter((r) => byRoute.has(r));
if (!present.length) {
  console.error("none of the tracked storefront routes are in route-bundle-stats.json");
  process.exit(2);
}

const chunkSets = new Map(present.map((r) => [r, new Set(byRoute.get(r).firstLoadChunkPaths)]));
const shared = present
  .map((r) => chunkSets.get(r))
  .reduce((acc, s) => new Set([...acc].filter((c) => s.has(c))));
const union = new Set(present.flatMap((r) => [...chunkSets.get(r)]));

// Scan the union of storefront first-load chunks once.
const hits = new Map();
for (const rel of [...union].sort()) {
  const fp = join(appRoot, rel);
  if (!existsSync(fp)) continue;
  const body = readFileSync(fp, "utf8");
  for (const rule of FORBIDDEN) {
    const found = rule.needles.filter((n) => body.includes(n));
    if (found.length >= rule.minHits) {
      const routes = present.filter((r) => chunkSets.get(r).has(rel));
      if (!hits.has(rule.id)) hits.set(rule.id, []);
      hits.get(rule.id).push({ chunk: rel.split("/").pop(), bytes: statSync(fp).size, routes });
    }
  }
}

const routeReport = present.map((r) => {
  const e = byRoute.get(r);
  const base = baseline?.get(r);
  return {
    route: r,
    firstLoadRaw: e.firstLoadUncompressedJsBytes,
    chunks: e.firstLoadChunkPaths.length,
    budget: BUDGETS[r] ?? null,
    overBudget: BUDGETS[r] ? e.firstLoadUncompressedJsBytes > BUDGETS[r] : false,
    baselineRaw: base?.firstLoadUncompressedJsBytes ?? null,
    delta: base ? e.firstLoadUncompressedJsBytes - base.firstLoadUncompressedJsBytes : null,
  };
});

const violations = [...hits.keys()].filter((id) => !WATCH.has(id));
const overBudget = routeReport.filter((r) => r.overBudget).map((r) => r.route);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        routes: routeReport,
        sharedChunks: shared.size,
        sharedRawBytes: chunkBytes(shared),
        markers: Object.fromEntries(hits),
        violations,
        overBudget,
      },
      null,
      2,
    ),
  );
} else {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log("storefront first-load JS (raw, uncompressed)\n");
  for (const r of routeReport) {
    const d =
      r.delta === null
        ? ""
        : `  ${r.delta > 0 ? "+" : ""}${(r.delta / 1024).toFixed(1)} KB vs baseline`;
    const flag = r.overBudget ? "  OVER BUDGET" : "";
    console.log(
      `  ${r.route.padEnd(24)} ${kb(r.firstLoadRaw).padStart(11)}  ${String(r.chunks).padStart(2)} chunks${d}${flag}`,
    );
  }
  console.log(
    `\n  shared across ${present.length} routes: ${shared.size} chunks, ${kb(chunkBytes(shared))}\n`,
  );
  console.log("forbidden-code scan (union of storefront first-load chunks)\n");
  for (const rule of FORBIDDEN) {
    const rows = hits.get(rule.id);
    if (!rows) {
      console.log(`  ${rule.id.padEnd(18)} absent`);
      continue;
    }
    for (const row of rows) {
      const tag = WATCH.has(rule.id) ? "PRESENT (watch)" : "PRESENT (fail)";
      console.log(
        `  ${rule.id.padEnd(18)} ${tag}  ${row.chunk} ${kb(row.bytes)}  on ${row.routes.length}/${present.length} routes`,
      );
      console.log(`  ${" ".repeat(18)} cause: ${rule.why}`);
    }
  }
  if (violations.length)
    console.log(`\nFAIL: forbidden code in storefront first-load: ${violations.join(", ")}`);
  if (overBudget.length) console.log(`FAIL: over first-load budget: ${overBudget.join(", ")}`);
  if (!violations.length && !overBudget.length)
    console.log("\nOK: no forbidden code, all routes within budget");
}

process.exit(violations.length || overBudget.length ? 1 : 0);
