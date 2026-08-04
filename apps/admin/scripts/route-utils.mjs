import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(adminRoot, "../..");
export const legacyAppRoot = path.join(repoRoot, "apps/frontend/src/app");
export const adminAppRoot = path.join(adminRoot, "src/app");

export function walkFiles(root, predicate) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (predicate(absolute)) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

export function appRoute(appRoot, pageFile) {
  const segments = path
    .relative(appRoot, path.dirname(pageFile))
    .split(path.sep)
    .filter(Boolean)
    .filter((segment) => !/^\(.*\)$/.test(segment));
  return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

export function legacyRoutes() {
  return walkFiles(
    legacyAppRoot,
    (file) => path.basename(file) === "page.tsx" && file.includes(`${path.sep}super-admin`),
  ).map((file) => ({
    file,
    legacy: appRoute(legacyAppRoot, file),
    admin: appRoute(legacyAppRoot, file).replace(/^\/super-admin(?=\/|$)/, "") || "/",
    kind: file.includes(`${path.sep}(print)${path.sep}`) ? "print" : "dashboard",
  }));
}

export function adminRoutes() {
  return walkFiles(
    adminAppRoot,
    (file) =>
      path.basename(file) === "page.tsx" &&
      (file.includes(`${path.sep}(admin)${path.sep}`) || file.includes(`${path.sep}(print)${path.sep}`)),
  ).map((file) => ({ file, route: appRoute(adminAppRoot, file) }));
}
