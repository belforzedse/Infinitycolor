import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const environment = process.env.ADMIN_VERIFY_ENVIRONMENT;
const expectedRelease = process.env.ADMIN_VERIFY_RELEASE;
const outputFile = process.env.ADMIN_VERIFY_REPORT || "reports/admin-deployment-verification.json";
const authorities = {
  staging: {
    admin: "https://admin.staging.infinitycolor.co",
    auth: "https://auth.staging.infinitycolor.co",
    manifestId: "/infinity-admin-staging",
    cspHeader: "content-security-policy-report-only",
  },
  production: {
    admin: "https://admin.infinitycolor.co",
    auth: "https://auth.infinitycolor.co",
    manifestId: "/infinity-admin",
    cspHeader: "content-security-policy",
  },
};

if (!(environment in authorities)) throw new Error("ADMIN_VERIFY_ENVIRONMENT must be staging or production");
if (!/^[0-9a-f]{40}$/.test(expectedRelease || "")) throw new Error("ADMIN_VERIFY_RELEASE must be a full commit SHA");

const expected = authorities[environment];
const checks = [];

async function get(pathname, { expectedStatus = 200, json = true } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL(pathname, expected.admin), {
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: json ? "application/json" : "text/html" },
    });
    if (response.status !== expectedStatus) throw new Error(`${pathname} returned ${response.status}`);
    return { response, body: json ? await response.json() : await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

const live = await get("/api/health/live");
if (live.body?.service !== "infinity-admin" || live.body?.release !== expectedRelease) {
  throw new Error("Liveness identity does not match the expected admin release");
}
checks.push("liveness-release");

const ready = await get("/api/health/ready");
if (ready.body?.status !== "ready" || !ready.body?.dependencies?.every((item) => item.ok === true)) {
  throw new Error("Admin readiness dependencies are not healthy");
}
checks.push("readiness-dependencies");

const manifest = await get("/manifest.webmanifest");
if (manifest.body?.id !== expected.manifestId || manifest.body?.scope !== "/" || manifest.body?.start_url !== "/") {
  throw new Error("Admin manifest identity does not match its environment");
}
if (!/no-store/i.test(manifest.response.headers.get("cache-control") || "")) {
  throw new Error("Admin manifest is not no-store");
}
checks.push("manifest-identity-cache");

const root = await get("/", { expectedStatus: 307, json: false });
const location = new URL(root.response.headers.get("location") || "", expected.admin);
if (location.origin !== expected.auth || !location.pathname.startsWith("/auth")) {
  throw new Error("Admin login redirect does not use the fixed central-auth authority");
}
if (!root.response.headers.get(expected.cspHeader)) {
  throw new Error(`Missing expected ${environment} CSP header`);
}
if (!/no-store/i.test(root.response.headers.get("cache-control") || "")) {
  throw new Error("Admin HTML redirect is not no-store");
}
checks.push("fixed-auth-csp-cache");

const report = {
  verifiedAt: new Date().toISOString(),
  service: "infinity-admin",
  environment,
  origin: expected.admin,
  release: expectedRelease,
  checks,
};
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
console.info(`Verified infinity-admin ${environment} release ${expectedRelease}.`);
