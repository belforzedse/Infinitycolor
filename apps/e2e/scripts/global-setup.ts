import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  authCredentials,
  authStateDir,
  authStorageStatePath,
  authUserIdEnvName,
  E2E_AUTH_ROLES,
  type E2EAuthRole,
} from "../helpers/auth";
import { storefrontBaseURL, strapiApiURL, strapiOrigin } from "../helpers/env";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  timeoutMs = 15_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForEndpoint(url: string, timeoutMs: number) {
  const started = Date.now();
  let lastError = "";

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: { Accept: "application/json" },
      }, 10_000);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

type SeedSummary = {
  productSlug?: string;
  homepageNewestProductIds?: number[];
  customerUserId?: number;
  customerBUserId?: number;
  adminUserId?: number;
  founderUserId?: number;
  storeManagerUserId?: number;
  editorUserId?: number;
};

const AUTH_ROUTE_HINT_COOKIE = "infinity_route_hint";
const AUTH_ROUTE_HINT_COOKIE_VALUE = "1";
const AUTH_ROUTE_HINT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function authRouteHintCookie() {
  const storefrontUrl = new URL(storefrontBaseURL());

  return {
    name: AUTH_ROUTE_HINT_COOKIE,
    value: AUTH_ROUTE_HINT_COOKIE_VALUE,
    domain: storefrontUrl.hostname,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + AUTH_ROUTE_HINT_MAX_AGE_SECONDS,
    httpOnly: false,
    secure: storefrontUrl.protocol === "https:",
    sameSite: "Lax" as const,
  };
}

const SEED_SUMMARY_USER_KEY: Record<E2EAuthRole, keyof SeedSummary> = {
  customer: "customerUserId",
  "customer-b": "customerBUserId",
  admin: "adminUserId",
  founder: "founderUserId",
  "store-manager": "storeManagerUserId",
  editor: "editorUserId",
};

function runCommand(command: string, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, {
      cwd: repoRoot,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed (${code}): ${command}`));
      }
    });
  });
}

function parseSeedSummary(output: string): SeedSummary {
  const jsonStart = output.lastIndexOf("\n{");
  const jsonText = jsonStart >= 0 ? output.slice(jsonStart + 1).trim() : output.trim();
  if (!jsonText.startsWith("{")) {
    throw new Error("E2E seed command did not print a JSON summary");
  }

  return JSON.parse(jsonText) as SeedSummary;
}

async function assertSeededHomepageSection(seedSummary?: SeedSummary) {
  if (process.env.E2E_SKIP_HOMEPAGE_CONTRACT_CHECK === "1") return;

  const productSlug = seedSummary?.productSlug;
  if (!productSlug) return;

  const url = new URL(`${strapiApiURL()}/products/homepage-sections`);
  url.searchParams.set("_e2e", `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const response = await fetchWithTimeout(url.toString(), {
    headers: { Accept: "application/json" },
  }, 15_000);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `E2E homepage sections check failed (${response.status} ${response.statusText}): ${body}`,
    );
  }

  const payload = (await response.json()) as {
    data?: {
      sections?: Array<{
        id?: string;
        products?: Array<{ attributes?: { Slug?: string }; Slug?: string }>;
      }>;
    };
  };
  const sections = payload?.data?.sections ?? [];
  const newest = sections.find((section) => section.id === "newest");
  const newestProducts = newest?.products ?? [];
  const newestSlugs = newestProducts
    .map((product) => product.attributes?.Slug ?? product.Slug)
    .filter(Boolean);

  if (!newestSlugs.includes(productSlug)) {
    const ids = seedSummary.homepageNewestProductIds?.join(",") || "none";
    throw new Error(
      `E2E homepage newest section is missing seeded product "${productSlug}". ` +
        `Seed summary homepageNewestProductIds=[${ids}], newestCount=${newestProducts.length}, ` +
        `newestSlugs=[${newestSlugs.join(",")}].`,
    );
  }
}

async function revalidateSeededStorefront(seedSummary?: SeedSummary) {
  if (process.env.E2E_REVALIDATE_FRONTEND_AFTER_SEED !== "1") return;

  const secret =
    process.env.E2E_REVALIDATION_SECRET?.trim() ||
    process.env.REVALIDATION_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "E2E_REVALIDATE_FRONTEND_AFTER_SEED requires E2E_REVALIDATION_SECRET or REVALIDATION_SECRET",
    );
  }

  const productSlug = seedSummary?.productSlug?.trim();
  const postRevalidation = async (body: Record<string, string>) => {
    const response = await fetchWithTimeout(
      new URL("/api/revalidate", storefrontBaseURL()).toString(),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      15_000,
    );

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(
        `E2E storefront revalidation failed (${response.status} ${response.statusText}): ${responseBody}`,
      );
    }
  };

  await postRevalidation({ path: "/", type: "site-settings" });
  await postRevalidation(
    productSlug
      ? { path: `/pdp/${productSlug}`, type: "product" }
      : { path: "/", type: "home-products" },
  );

  if (!productSlug) return;

  const deadline = Date.now() + 45_000;
  let lastProbe = "no response";
  while (Date.now() < deadline) {
    const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const [homeResponse, productResponse] = await Promise.all([
        fetchWithTimeout(
          new URL(`/?_e2e_revalidated=${cacheBust}`, storefrontBaseURL()).toString(),
          { headers: { Accept: "text/html" }, cache: "no-store" },
          15_000,
        ),
        fetchWithTimeout(
          new URL(
            `/pdp/${encodeURIComponent(productSlug)}?_e2e_revalidated=${cacheBust}`,
            storefrontBaseURL(),
          ).toString(),
          { headers: { Accept: "text/html" }, cache: "no-store" },
          15_000,
        ),
      ]);
      const [homeHtml, productHtml] = await Promise.all([
        homeResponse.text(),
        productResponse.text(),
      ]);
      const homeReady =
        homeResponse.ok &&
        homeHtml.includes(`data-product-slug="${productSlug}"`) &&
        homeHtml.includes('data-home-full-bleed="discounted"');
      const productReady =
        productResponse.ok &&
        productHtml.includes("e2e-storefront-cover") &&
        productHtml.includes("e2e-storefront-detail");

      if (homeReady && productReady) return;
      lastProbe =
        `home=${homeResponse.status}/${homeReady ? "ready" : "stale"}, ` +
        `product=${productResponse.status}/${productReady ? "ready" : "stale"}`;
    } catch (error) {
      lastProbe = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `E2E storefront did not expose the seeded home/PDP fixtures after revalidation: ${lastProbe}`,
  );
}

async function readBackendEnvValue(name: string, aliases: string[] = []) {
  for (const envName of [...aliases, name]) {
    const existing = process.env[envName]?.trim();
    if (existing) return existing;
  }

  const envPath = path.join(repoRoot, "apps/backend/.env");
  const content = await readFile(envPath, "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    if (key !== name) continue;
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    return rawValue.replace(/^['"]|['"]$/g, "");
  }

  const envNames = [...aliases, name].join(" or ");
  throw new Error(`Missing ${envNames}; set it in the environment or apps/backend/.env`);
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function issueJwt(userId: number, secret: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlJson({
    id: userId,
    iat: issuedAt,
    exp: issuedAt + 7 * 24 * 60 * 60,
  });
  const unsignedToken = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(unsignedToken).digest("base64url");
  return `${unsignedToken}.${signature}`;
}

function resolveSeededUserId(role: E2EAuthRole, seedSummary?: SeedSummary) {
  const envName = authUserIdEnvName(role);
  const envValue = Number(process.env[envName]);
  const seedValue = seedSummary?.[SEED_SUMMARY_USER_KEY[role]] as number | undefined;
  const userId = Number.isFinite(envValue) && envValue > 0 ? envValue : seedValue;

  if (!Number.isFinite(userId) || !userId) {
    throw new Error(
      `Missing E2E ${role} user id; run the E2E seed or set ${envName} when E2E_SEED_MODE=skip`,
    );
  }

  return Number(userId);
}

async function writeAuthStorageStateFromToken(role: E2EAuthRole, token: string) {
  const authCheck = await fetchWithTimeout(`${strapiApiURL()}/auth/self`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  }, 15_000);
  if (!authCheck.ok) {
    const body = await authCheck.text().catch(() => "");
    throw new Error(
      `E2E ${role} token validation failed (${authCheck.status} ${authCheck.statusText}): ${body}`,
    );
  }

  await mkdir(authStateDir, { recursive: true });
  await writeFile(
    authStorageStatePath(role),
    JSON.stringify(
      {
        cookies: [authRouteHintCookie()],
        origins: [
          {
            origin: storefrontBaseURL(),
            localStorage: [
              { name: "accessToken", value: token },
              { name: "analytics-consent", value: "denied" },
              { name: "pdp_debug", value: "0" },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}

async function writeAuthStorageStateViaLogin(role: E2EAuthRole) {
  const credentials = authCredentials(role);
  const response = await fetchWithTimeout(`${strapiApiURL()}/auth/login-with-password`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(credentials),
  }, 15_000);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `E2E ${role} login failed (${response.status} ${response.statusText}): ${body}`,
    );
  }

  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error(`E2E ${role} login did not return a token`);
  }

  await mkdir(authStateDir, { recursive: true });
  await writeFile(
    authStorageStatePath(role),
    JSON.stringify(
      {
        cookies: [authRouteHintCookie()],
        origins: [
          {
            origin: storefrontBaseURL(),
            localStorage: [
              { name: "accessToken", value: payload.token },
              { name: "analytics-consent", value: "denied" },
              { name: "pdp_debug", value: "0" },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
}

async function writeAuthStorageState(role: E2EAuthRole, seedSummary?: SeedSummary) {
  if (process.env.E2E_AUTH_MODE === "login") {
    await writeAuthStorageStateViaLogin(role);
    return;
  }

  const userId = resolveSeededUserId(role, seedSummary);
  const jwtSecret = await readBackendEnvValue("JWT_SECRET", ["E2E_JWT_SECRET"]);
  await writeAuthStorageStateFromToken(role, issueJwt(userId, jwtSecret));
}

export default async function globalSetup() {
  if (process.env.E2E_SKIP_SERVICE_WAIT !== "1") {
    const healthUrl = process.env.E2E_API_HEALTH_URL || `${strapiOrigin()}/_health`;
    await waitForEndpoint(healthUrl, Number(process.env.E2E_SERVICE_TIMEOUT_MS || 120_000));
  }

  const seedMode = process.env.E2E_SEED_MODE || "auto";
  let seedSummary: SeedSummary | undefined;
  if (seedMode !== "skip") {
    const command =
      process.env.E2E_AUTO_SEED_COMMAND || "pnpm --filter @repo/backend seed:e2e";
    const result = await runCommand(command, {
      ...process.env,
      E2E_CLEAR_REDIS_CACHE: process.env.E2E_CLEAR_REDIS_CACHE ?? "1",
    });
    seedSummary = parseSeedSummary(result.stdout);
    await assertSeededHomepageSection(seedSummary);
    await revalidateSeededStorefront(seedSummary);
  }

  if (process.env.E2E_AUTH_MODE !== "skip") {
    for (const role of E2E_AUTH_ROLES) {
      await writeAuthStorageState(role, seedSummary);
    }
  }
}
