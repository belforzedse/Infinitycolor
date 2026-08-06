#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { CatalogRunStore } = require("./catalog/lib/runStore");
const { buildCatalogExceptionManifest } = require("./catalog/lib/exceptionAudit");
const { configureSourceEnvironment, migrationStateDir } = require("./migration-v2/lib/env");
const { WordPressSource } = require("./migration-v2/lib/source");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) options[token.slice(2)] = true;
    else {
      options[token.slice(2)] = value;
      index += 1;
    }
  }
  return options;
}

function atomicWrite(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const fd = fs.openSync(temporary, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(temporary, resolved);
  return resolved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.run) throw new Error("catalog-exception-audit requires --run <catalog-run-id>");
  const trackingDir = path.resolve(options["tracking-dir"] || path.join(migrationStateDir(), "catalog"));
  const source = new WordPressSource(configureSourceEnvironment());
  const previousAudit = options["previous-audit"]
    ? JSON.parse(fs.readFileSync(path.resolve(options["previous-audit"]), "utf8"))
    : null;
  const result = await buildCatalogExceptionManifest({
    store: new CatalogRunStore(trackingDir),
    runId: options.run,
    source,
    approvedBy: options["approved-by"] || "",
    approvalReference: options["approval-reference"] || "",
    previousAudit,
  });
  if (options.output) {
    const outputPath = atomicWrite(options.output, result);
    console.log(JSON.stringify({ ...result.audit, outputPath }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.audit.allAcceptEligible) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`catalog exception audit failed: ${error.message}`);
  process.exitCode = 1;
});
