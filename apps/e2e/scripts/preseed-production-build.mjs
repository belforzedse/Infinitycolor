import { spawn } from "node:child_process";

const apiBaseUrl = process.env.E2E_API_URL?.trim().replace(/\/$/, "");
if (!apiBaseUrl) {
  throw new Error("E2E_API_URL is required to pre-seed the production-mode storefront build");
}

const healthUrl = `${apiBaseUrl}/_health`;
const timeoutMs = Number(process.env.E2E_SERVICE_TIMEOUT_MS || 240_000);
const deadline = Date.now() + timeoutMs;
let lastFailure = "no response";

while (Date.now() < deadline) {
  try {
    const response = await fetch(healthUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      lastFailure = "";
      break;
    }
    lastFailure = `${response.status} ${response.statusText}`;
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}

if (lastFailure) {
  throw new Error(`E2E backend did not become ready at ${healthUrl}: ${lastFailure}`);
}

console.log("[e2e:preseed] Backend is ready; seeding before the production Next.js build.");

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn("pnpm", ["--filter", "@repo/backend", "seed:e2e"], {
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`E2E pre-seed terminated by ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

if (exitCode !== 0) {
  throw new Error(`E2E pre-seed failed with exit code ${exitCode}`);
}
