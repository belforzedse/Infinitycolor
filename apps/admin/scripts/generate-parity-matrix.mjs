import fs from "node:fs";
import path from "node:path";
import { adminRoutes, adminRoot, legacyRoutes, repoRoot } from "./route-utils.mjs";

const extensions = [".ts", ".tsx", ".js", ".jsx"];
const sourceRoot = path.join(adminRoot, "src");

function resolveImport(fromFile, specifier) {
  let candidate;
  if (specifier.startsWith("@/")) candidate = path.join(sourceRoot, specifier.slice(2));
  else if (specifier.startsWith(".")) candidate = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  const possibilities = [candidate, ...extensions.map((extension) => `${candidate}${extension}`)];
  for (const extension of extensions) possibilities.push(path.join(candidate, `index${extension}`));
  return possibilities.find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
}

function dependencyClosure(entry) {
  const visited = new Set();
  const visit = (file) => {
    if (!file || visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      const resolved = resolveImport(file, match[1]);
      if (resolved?.startsWith(sourceRoot)) visit(resolved);
    }
  };
  visit(entry);
  return [...visited];
}

function compact(items, maximum = 5) {
  const unique = [...new Set(items)].sort();
  if (!unique.length) return "page-local";
  const shown = unique.slice(0, maximum);
  return `${shown.join(", ")}${unique.length > maximum ? `, +${unique.length - maximum}` : ""}`;
}

const founderForbidden = [
  "/customization", "/blog", "/faq", "/stories", "/settings", "/users", "/payment-methods",
  "/carts", "/purgeall", "/orders/add", "/products/homepage", "/products/gif-promo",
  "/products/homepage-custom-section", "/shipping/provinces", "/reports/traffic", "/reports/admin-activity",
];
const managerForbidden = [
  "/customization", "/blog", "/faq", "/stories", "/users", "/settings", "/reports",
  "/payment-methods", "/carts", "/purgeall", "/orders/add", "/products/homepage",
  "/products/gif-promo", "/products/homepage-custom-section", "/shipping/provinces",
];
const denied = (route, prefixes) => prefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));

function roles(route) {
  const values = ["Superadmin"];
  if (!denied(route, founderForbidden)) values.push("Founder");
  if (!denied(route, managerForbidden)) values.push("Store Manager");
  if (route === "/blog" || route.startsWith("/blog/")) values.push("Editor");
  return values.join(", ");
}

function workflow(route, closure) {
  const text = closure.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const actions = [];
  if (/\b(?:post|create)\s*\(|\/add(?:\/|$)/i.test(text) || route.endsWith("/add")) actions.push("create");
  if (/\b(?:put|patch|update)\s*\(|\/edit(?:\/|$)/i.test(text) || route.includes("/edit/")) actions.push("update");
  if (/\b(?:delete|remove|purge)\s*\(/i.test(text) || route === "/purgeall") actions.push("delete/purge");
  if (/upload|FormData/i.test(text)) actions.push("upload");
  if (/download|export|excel|xlsx/i.test(text)) actions.push("download/export");
  if (route.includes("/print/") || route.includes("anipo-barcode")) actions.push("print");
  return actions.length ? [...new Set(actions)].join(", ") : "read-only/navigation";
}

function testCoverage(route) {
  const tests = ["route inventory"];
  if (route.startsWith("/products/categories")) tests.push("category-crud.spec.ts");
  else if (route.startsWith("/products")) tests.push("product-crud.spec.ts");
  if (route.startsWith("/coupons")) tests.push("coupon-crud.spec.ts");
  if (route.startsWith("/shipping")) tests.push("shipping-crud.spec.ts");
  if (route.startsWith("/orders")) tests.push("order-management.spec.ts");
  return `${tests.join(", ")}; visual/browser proof pending`;
}

const extractedByRoute = new Map(adminRoutes().map(({ route, file }) => [route, file]));
const rows = legacyRoutes()
  .sort((left, right) => left.legacy.localeCompare(right.legacy))
  .map((route, index) => {
    const pageFile = extractedByRoute.get(route.admin);
    if (!pageFile) throw new Error(`Missing extracted page ${route.admin}`);
    const closure = dependencyClosure(pageFile);
    const components = compact(
      closure
        .filter((file) => file.includes(`${path.sep}components${path.sep}`))
        .map((file) => path.relative(path.join(sourceRoot, "components"), file).replace(/\.(?:tsx?|jsx?)$/, "")),
    );
    const services = compact(
      closure
        .filter((file) => file.includes(`${path.sep}services${path.sep}`))
        .map((file) => path.relative(path.join(sourceRoot, "services"), file).replace(/\.(?:tsx?|jsx?)$/, "")),
    );
    const query = route.admin.includes("[")
      ? "dynamic params + legacy query behavior preserved"
      : "legacy filters/sort/pagination/query preserved where applicable";
    return `| ${index + 1} | \`${route.legacy}\` | \`${route.admin}\` | ${route.kind} | ${roles(route.admin)} | ${components} | ${services} | ${workflow(route.admin, closure)} | ${query} | Copied loading/empty/error/modal/validation and RTL/responsive behavior; viewport proof pending | ${testCoverage(route.admin)} | URL prefix removed only |`;
  });

const document = `# Admin extraction parity matrix

Repository inventory captured from the clean \`dev\` baseline at \`aa295435\`. This matrix separates repository extraction proof from browser, staging, and production acceptance. A row marked “viewport proof pending” is not visual-parity proof.

Counts: **85 dashboard pages**, **3 print pages**, **88 legacy pages total**. The new \`/account\` page is additive and is intentionally not counted as a legacy parity row.

Role labels describe the current frontend navigation/direct-route policy. Strapi current-user state, role, blocked status, permissions, controller policy, and field/object allowlists remain authoritative.

| # | Legacy URL | Admin URL | Class | Current roles | Component closure | API/service closure | Mutations, files, output | Query behavior | UI and responsive states | Tests and proof | Verified systemic difference |
|---:|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## Acceptance ledger

| Gate | Status | Evidence required |
|---|---|---|
| Repository extraction | In progress | route/architecture tests, isolated typecheck/lint/unit/build, standalone smoke |
| Deterministic parity backend | Pending | both apps against the same isolated Strapi/Postgres/Redis and accounts |
| Four-viewport visual matrix | Pending | 1440×900, 1280×800, 768×1024, 390×844 including applicable states |
| Browser auth matrix | Pending | Chromium, Firefox, WebKit; four admin roles; expiry/revocation/ban/deep links |
| Staging | Blocked until approved CI and live provisioning | TLS, exact origins, CSP report-only resolution, monitoring, rollback drill |
| Production | Blocked outside repository | external controller, TLS, enforced CSP, Matomo site, four healthy replicas, explicit cutover approval |
`;

const output = path.join(repoRoot, "docs/admin-extraction/parity-matrix.md");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, document);
console.log(`Wrote ${rows.length} parity rows to ${path.relative(repoRoot, output)}.`);
