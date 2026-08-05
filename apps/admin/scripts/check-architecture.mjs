import fs from "node:fs";
import path from "node:path";
import { adminRoot, walkFiles } from "./route-utils.mjs";

const sourceRoot = path.join(adminRoot, "src");
const candidates = walkFiles(sourceRoot, (file) => /\.(?:[cm]?[jt]sx?|css)$/.test(file));
const violations = [];

for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (/['"]@repo\/frontend(?:\/|['"])/.test(source)) {
    violations.push(`${path.relative(adminRoot, file)} imports @repo/frontend`);
  }
  for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const resolved = path.resolve(path.dirname(file), specifier);
    if (resolved.startsWith(path.resolve(adminRoot, "../frontend"))) {
      violations.push(`${path.relative(adminRoot, file)} reaches apps/frontend through ${specifier}`);
    }
  }
  if (/(?:localStorage|sessionStorage)\.setItem\(\s*["'](?:accessToken|token|tempPreInvoiceOrder|offline-queue|pendingOrderId|pendingPaymentAttemptId)/.test(source)) {
    violations.push(`${path.relative(adminRoot, file)} persists protected admin state in browser storage`);
  }
  if (/indexedDB\.open\(/.test(source)) {
    violations.push(`${path.relative(adminRoot, file)} opens IndexedDB from the admin application`);
  }
}

if (violations.length) {
  console.error("Admin architecture boundary failed:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log(`Admin architecture boundary passed for ${candidates.length} source files.`);
