#!/usr/bin/env node
"use strict";

const path = require("path");
const { CatalogRunStore } = require("./catalog/lib/runStore");

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[key.slice(2)] = true;
    else { options[key.slice(2)] = next; index += 1; }
  }
  return options;
}

const options = parse(process.argv.slice(2));
if (!options.run || !options["tracking-dir"]) {
  throw new Error("Usage: catalog-convert.js --run <id> --tracking-dir <dir> --dry-run | --confirm CatalogStateV2");
}
if (options["dry-run"] && options.confirm) throw new Error("Choose either --dry-run or --confirm, not both");
if (!options["dry-run"] && !options.confirm) throw new Error("Conversion requires --dry-run or --confirm CatalogStateV2");
const store = new CatalogRunStore(path.resolve(options["tracking-dir"]));
const result = store.convertLegacy(options.run, {
  dryRun: Boolean(options["dry-run"]),
  confirm: options.confirm || "",
});
console.log(JSON.stringify(result, null, 2));
