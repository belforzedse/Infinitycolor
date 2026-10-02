const { readdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, basename } = require("node:path");

// Turbopack escapes brackets in local map references; the installed Sentry CLI
// injects the JS ID but misses those maps. Normalize only an existing sibling.
function prepareServerMapReferences(directory) {
  let changed = 0;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) changed += prepareServerMapReferences(file);
    else if (item.name.endsWith(".js")) {
      const original = readFileSync(file, "utf8");
      const prepared = original.replace(
        /(\/\/[#@] sourceMappingURL=)([^\r\n]+)/g,
        (match, prefix, encoded) => {
          let decoded;
          try {
            decoded = decodeURIComponent(encoded);
          } catch {
            return match;
          }
          if (decoded !== `${basename(file)}.map` || !existsSync(`${file}.map`)) return match;
          return prefix + decoded;
        },
      );
      if (prepared !== original) {
        writeFileSync(file, prepared);
        changed += 1;
      }
    }
  }
  return changed;
}

module.exports = { prepareServerMapReferences };
