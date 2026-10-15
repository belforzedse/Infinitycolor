"use strict";
// Run with the supported backend Node version when deliberately updating the
// search contract. The checked-in table keeps JS and PostgreSQL independent of
// the host locale and records the Unicode data version used for generation.
const fs = require("node:fs");
const path = require("node:path");
const pairs = [];
const multiple = [];
for (let point = 0; point <= 0x10ffff; point += 1) {
  const letter = String.fromCodePoint(point);
  const lower = letter.toLowerCase();
  if (!/\p{Script=Latin}/u.test(letter) || lower === letter) continue;
  if ([...lower].length === 1) pairs.push([letter, lower]);
  else multiple.push([letter, lower]);
}
const table = {
  unicodeVersion: process.versions.unicode,
  generatedWithNode: process.version,
  upper: pairs.map(([upper]) => upper).join(""),
  lower: pairs.map(([, lower]) => lower).join(""),
  multiple,
};
fs.writeFileSync(
  path.join(__dirname, "order-search-latin-case.json"),
  JSON.stringify(table, null, 2) + "\n",
);
