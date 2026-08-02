import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../../..");
const sourceRoots = [
  "apps/frontend/src",
  "apps/auth/src",
  "packages/api/src",
  "packages/auth-core/src",
];
const credentialKeys =
  "accessToken|refreshToken|otpToken|pendingNewPassword|pendingPhone|password|authorization";

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const absolute = path.join(root, name);
    if (name === "__tests__" || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) return [];
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return /\.[cm]?[jt]sx?$/.test(name) ? [absolute] : [];
  });
}

describe("reusable browser credential storage guard", () => {
  test("production source cannot write credential-shaped keys to browser persistence", () => {
    const violations: string[] = [];
    const storageWrite = new RegExp(
      String.raw`(?:localStorage|sessionStorage)\.setItem\s*\(\s*["'\x60](?:${credentialKeys})["'\x60]`,
      "i",
    );
    const readableCookieWrite = new RegExp(
      String.raw`document\.cookie\s*=.*(?:${credentialKeys})`,
      "i",
    );
    const indexedCredential = new RegExp(
      String.raw`indexedDB[\s\S]{0,240}(?:${credentialKeys})`,
      "i",
    );

    for (const relativeRoot of sourceRoots) {
      for (const file of sourceFiles(path.join(repoRoot, relativeRoot))) {
        const source = readFileSync(file, "utf8");
        if (
          storageWrite.test(source) ||
          readableCookieWrite.test(source) ||
          indexedCredential.test(source)
        ) {
          violations.push(path.relative(repoRoot, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the service worker bypasses every auth/account/commerce path before caching", () => {
    const serviceWorker = readFileSync(path.join(repoRoot, "apps/frontend/public/sw.js"), "utf8");
    for (const prefix of [
      "/api",
      "/auth",
      "/account",
      "/cart",
      "/checkout",
      "/orders",
      "/payment",
      "/wallet",
      "/super-admin",
    ]) {
      expect(serviceWorker).toContain(`"${prefix}"`);
    }
    expect(serviceWorker).toMatch(/request\.headers\.has\("Authorization"\)/);
    expect(serviceWorker.indexOf("isSensitivePath(url.pathname)")).toBeLessThan(
      serviceWorker.indexOf("cache.put(request"),
    );
  });
});
