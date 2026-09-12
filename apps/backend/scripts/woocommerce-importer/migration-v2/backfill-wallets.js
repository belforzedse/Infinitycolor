#!/usr/bin/env node
"use strict";

/**
 * Targeted recovery of legacy TeraWallet holders that the migration left behind.
 *
 * Every id acted on must be named explicitly in --ids-file; nothing is discovered
 * at runtime. Modes:
 *   create      — no Infinity account owns this phone; upsert the user, then the wallet.
 *   merge       — the phone belongs to another WordPress-sourced account. Sends
 *                 allowPhoneMerge so the overlay adopts that account and records the
 *                 legacy id in customer_identity_mappings. Server still refuses if the
 *                 owner is claimed/verified or already holds a balance.
 *   wallet-only — the user row is already correct; only the wallet is missing or zero.
 *
 * WooCommerce is read-only here. --dry-run performs every read and builds every
 * payload but issues no writes.
 */

const fs = require("node:fs");
const { configureEnvironment } = require("./lib/env");
const { WordPressSource } = require("./lib/source");
const { Destination } = require("./lib/destination");
const { wooSourceTimestamps } = require("../utils/sourceTimestamps");
const T = require("./lib/transforms");

const MODES = new Set(["create", "merge", "wallet-only"]);

const cleanText = (value, max) => String(value ?? "").trim().slice(0, max);

/**
 * Deliberately self-contained rather than calling T.customerPayload: a deployed
 * sync image may predate the username fallback, and this runner must not depend
 * on — or force an overwrite of — the shared transforms the nightly service uses.
 * Same shape and same precedence, login-first (username before billing/shipping).
 *
 * This precedence MUST match T.customerPayload. It resolves which account a
 * wallet balance is credited to, so any divergence pays a customer's balance
 * into a different user than the importer created.
 */
function customerPayload(customer) {
  const phone = T.canonicalPhone(customer?.username)
    || T.canonicalPhone(customer?.billing?.phone)
    || T.canonicalPhone(customer?.shipping?.phone);
  if (!phone) throw new Error("USER_PHONE_INVALID");
  const timestamps = wooSourceTimestamps(customer);
  return {
    sourceId: String(customer.id),
    phone,
    email: cleanText(customer.email, 255) || null,
    firstName: cleanText(customer.first_name, 255),
    lastName: cleanText(customer.last_name, 255),
    ...(timestamps ? { sourceCreatedAt: timestamps.createdAt, sourceUpdatedAt: timestamps.updatedAt } : {}),
  };
}

function parseArgs(argv) {
  const args = { concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--apply") args.apply = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--ids-file") args.idsFile = argv[++i];
    else if (token === "--json-out") args.jsonOut = argv[++i];
    else if (token === "--concurrency") args.concurrency = Number.parseInt(argv[++i], 10);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: backfill-wallets.js (--dry-run | --apply) --ids-file <path> [options]",
    "",
    "  --ids-file <path>   JSON: { merge: [...], create: [...], walletOnly: [...] }",
    "  --json-out <path>   write the per-id outcome report here",
    "  --concurrency N     parallel ids (default 4)",
  ].join("\n");
}

function loadTargets(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const targets = [];
  const seen = new Set();
  for (const [key, mode] of [["create", "create"], ["merge", "merge"], ["walletOnly", "wallet-only"]]) {
    for (const id of raw[key] || []) {
      const wpId = String(id);
      if (!/^\d+$/.test(wpId)) throw new Error(`Invalid id in ${key}: ${id}`);
      if (seen.has(wpId)) throw new Error(`Id ${wpId} appears in more than one mode`);
      seen.add(wpId);
      targets.push({ wpId, mode });
    }
  }
  if (targets.length === 0) throw new Error("ids-file selected nothing");
  for (const t of targets) if (!MODES.has(t.mode)) throw new Error(`Bad mode ${t.mode}`);
  return targets;
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

const errorCode = (error) => error?.payload?.error || error?.message || "UNKNOWN";

async function syncUser(source, destination, target, dryRun) {
  const customer = await source.getCustomer(target.wpId);
  const payload = customerPayload(customer);
  if (target.mode === "merge") payload.allowPhoneMerge = true;
  if (dryRun) return { status: "would-write", phone: payload.phone };
  const result = await destination.upsertUser(payload);
  return { status: result.mode, phone: payload.phone, destinationId: result.id, matchReason: result.matchReason };
}

async function syncWallet(source, destination, wpId, dryRun) {
  const response = await source.getWalletBalance(wpId);
  const payload = T.walletPayload({ id: wpId, balance: T.walletBalanceValue(response) });
  if (dryRun) return { status: "would-write", balanceRial: payload.balanceRial };
  const result = await destination.upsertWallet(payload);
  return { status: result.mode, balanceRial: payload.balanceRial, destinationId: result.id };
}

async function processTarget(source, destination, target, dryRun) {
  const row = { wpId: target.wpId, mode: target.mode };
  if (target.mode !== "wallet-only") {
    try {
      row.user = await syncUser(source, destination, target, dryRun);
    } catch (error) {
      row.user = { status: "refused", error: errorCode(error) };
      // Without the user row the wallet has nowhere to land; do not try.
      row.wallet = { status: "skipped", error: "USER_STEP_FAILED" };
      return row;
    }
  }
  try {
    row.wallet = await syncWallet(source, destination, target.wpId, dryRun);
  } catch (error) {
    row.wallet = { status: "refused", error: errorCode(error) };
  }
  return row;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.dryRun === args.apply) throw new Error("Pass exactly one of --dry-run or --apply");
  if (!args.idsFile) throw new Error("--ids-file is required");

  const targets = loadTargets(args.idsFile);
  const config = configureEnvironment();
  const source = new WordPressSource(config);
  const destination = new Destination(config);

  console.error(`${args.dryRun ? "DRY-RUN" : "APPLY"} over ${targets.length} ids from ${args.idsFile}`);
  let done = 0;
  const rows = await mapPool(targets, args.concurrency, async (target) => {
    const row = await processTarget(source, destination, target, Boolean(args.dryRun));
    done += 1;
    if (done % 25 === 0) console.error(`... ${done}/${targets.length}`);
    return row;
  });

  const tally = {};
  const bump = (key) => { tally[key] = (tally[key] || 0) + 1; };
  for (const row of rows) {
    bump(`user:${row.user ? row.user.status : "n/a"}`);
    bump(`wallet:${row.wallet.status}`);
    if (row.user?.error) bump(`userError:${row.user.error}`);
    if (row.wallet?.error) bump(`walletError:${row.wallet.error}`);
  }

  const report = {
    mode: args.dryRun ? "dry-run" : "apply",
    ranAt: new Date().toISOString(),
    idsFile: args.idsFile,
    targetCount: targets.length,
    tally,
    rows,
  };
  if (args.jsonOut) fs.writeFileSync(args.jsonOut, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode: report.mode, targetCount: report.targetCount, tally }, null, 2));

  const failed = rows.filter((row) => row.user?.status === "refused" || row.wallet.status === "refused");
  return failed.length > 0 ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`FATAL ${error.message}`);
    process.exit(1);
  });
