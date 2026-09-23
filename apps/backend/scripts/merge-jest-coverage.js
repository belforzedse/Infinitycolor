#!/usr/bin/env node
// Merges the coverage of a sharded Jest run and applies jest.config.js's
// coverageThreshold to the whole, the way a single unsharded run would.
//
// Each CI shard runs `jest --shard=i/n --coverageThreshold={}` and keeps only
// its coverage-final.json. The thresholds cannot be checked per shard: a shard
// that does not load src/api/payment-gateway/services/zarinpal.ts reports it at
// 0% and fails its 75% floor. This job is where the floor is enforced.
//
// Statements, lines and functions merge to exactly the unsharded numbers.
// Branches can differ by under a point, because each shard's V8 reports its own
// block ranges (2026-09-24, 3 shards: 62.23% merged vs 61.42% unsharded).
//
//   node scripts/merge-jest-coverage.js coverage/shard-*/coverage-final.json
//
// Writes text, json-summary and cobertura reports to coverage/ and exits 1
// when a threshold is not met, with Jest's own wording.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const libCoverage = require("istanbul-lib-coverage");
const libReport = require("istanbul-lib-report");
const reports = require("istanbul-reports");

const backendDir = path.resolve(__dirname, "..");
const METRICS = ["statements", "branches", "lines", "functions"];

// Shards ran in their own checkouts. Re-root every path at this checkout so the
// same source file from two shards merges into one entry.
function rebase(coverageJson) {
  const marker = `${path.sep}apps${path.sep}backend${path.sep}`;
  const rebased = {};
  for (const [file, data] of Object.entries(coverageJson)) {
    const at = file.lastIndexOf(marker);
    const local = at === -1 ? file : path.join(backendDir, file.slice(at + marker.length));
    rebased[local] = { ...data, path: local };
  }
  return rebased;
}

function mergeShards(files) {
  const map = libCoverage.createCoverageMap({});
  for (const file of files) {
    map.merge(rebase(JSON.parse(fs.readFileSync(file, "utf8"))));
  }
  return map;
}

function summarize(map, files) {
  const summary = libCoverage.createCoverageSummary();
  for (const file of files) summary.merge(map.fileCoverageFor(file).toSummary());
  return summary;
}

// Same rules as @jest/reporters CoverageReporter#_checkThreshold: a non-global
// key claims every file whose absolute path starts with it, "global" covers the
// files no other key claimed, and a negative threshold caps the uncovered count.
function checkThresholds(map, coverageThreshold, rootDir) {
  const groups = Object.keys(coverageThreshold);
  const files = map.files();
  const claimed = new Map(groups.filter((group) => group !== "global").map((group) => [group, []]));
  const unclaimed = [];

  for (const group of claimed.keys()) {
    if (/[*?[\]{}]/.test(group)) {
      throw new Error(`coverageThreshold glob "${group}" is not supported by merge-jest-coverage.js; extend it before using globs`);
    }
  }

  for (const file of files) {
    let matched = false;
    for (const [group, members] of claimed) {
      if (file.startsWith(path.resolve(rootDir, group))) {
        members.push(file);
        matched = true;
      }
    }
    if (!matched) unclaimed.push(file);
  }

  const errors = [];
  const check = (name, thresholds, actuals) => {
    for (const metric of METRICS) {
      const threshold = thresholds[metric];
      if (threshold === undefined) continue;
      const { pct, total, covered } = actuals[metric];
      if (threshold < 0) {
        if (-threshold < total - covered) {
          errors.push(`Jest: Uncovered count for ${metric} (${total - covered}) exceeds ${name === "global" ? "global" : `"${name}"`} threshold (${-threshold})`);
        }
      } else if (pct < threshold) {
        errors.push(`Jest: "${name}" coverage threshold for ${metric} (${threshold}%) not met: ${pct}%`);
      }
    }
  };

  for (const [group, members] of claimed) {
    if (members.length === 0) {
      errors.push(`Jest: Coverage data for ${group} was not found.`);
      continue;
    }
    check(group, coverageThreshold[group], summarize(map, members).data);
  }
  if (coverageThreshold.global && unclaimed.length > 0) {
    check("global", coverageThreshold.global, summarize(map, unclaimed).data);
  }
  return errors;
}

function main(argv) {
  const inputs = argv.filter((file) => fs.existsSync(file));
  if (inputs.length === 0 || inputs.length !== argv.length) {
    console.error(`Expected every shard's coverage-final.json, found ${inputs.length} of ${argv.length}: ${argv.join(" ")}`);
    return 2;
  }
  const expected = Number(process.env.EXPECTED_SHARDS || inputs.length);
  if (inputs.length !== expected) {
    console.error(`Expected ${expected} shard reports, got ${inputs.length}`);
    return 2;
  }

  const map = mergeShards(inputs);
  const context = libReport.createContext({
    dir: path.join(backendDir, "coverage"),
    coverageMap: map,
    defaultSummarizer: "nested",
  });
  for (const reporter of ["text", "json-summary", "cobertura"]) {
    reports.create(reporter).execute(context);
  }

  const { coverageThreshold = {} } = require(path.join(backendDir, "jest.config.js"));
  const errors = checkThresholds(map, coverageThreshold, backendDir);
  for (const error of errors) console.error(error);
  console.log(`Merged ${inputs.length} shard reports covering ${map.files().length} files.`);
  return errors.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { checkThresholds, mergeShards };
