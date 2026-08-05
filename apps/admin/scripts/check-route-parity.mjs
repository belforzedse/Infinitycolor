import fs from "node:fs";
import path from "node:path";
import { adminRoutes, legacyRoutes, repoRoot } from "./route-utils.mjs";

const legacy = legacyRoutes();
const extracted = new Set(adminRoutes().map(({ route }) => route));
const matrixPath = path.join(repoRoot, "docs/admin-extraction/parity-matrix.md");
const matrix = fs.readFileSync(matrixPath, "utf8");
const matrixPairs = new Set(
  [...matrix.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm)].map(
    ([, oldRoute, newRoute]) => `${oldRoute}\u0000${newRoute}`,
  ),
);

const failures = [];
if (legacy.length !== 88) failures.push(`expected 88 legacy routes, found ${legacy.length}`);
if (legacy.filter(({ kind }) => kind === "dashboard").length !== 85) {
  failures.push("legacy dashboard inventory is no longer 85 routes");
}
if (legacy.filter(({ kind }) => kind === "print").length !== 3) {
  failures.push("legacy print inventory is no longer 3 routes");
}

for (const route of legacy) {
  if (!extracted.has(route.admin)) failures.push(`missing extracted route ${route.admin}`);
  if (!matrixPairs.has(`${route.legacy}\u0000${route.admin}`)) {
    failures.push(`parity matrix is missing ${route.legacy} -> ${route.admin}`);
  }
}

const expected = new Set(legacy.map(({ admin }) => admin));
for (const route of extracted) {
  if (route === "/account") continue;
  if (!expected.has(route)) failures.push(`unexpected extracted legacy route ${route}`);
}

if (matrixPairs.size !== 88) failures.push(`expected 88 matrix rows, found ${matrixPairs.size}`);

if (failures.length) {
  console.error("Admin route parity failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Admin route parity passed: 85 dashboard routes + 3 print routes; /account is additive.");
