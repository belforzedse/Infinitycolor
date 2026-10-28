/**
 * Real browser + Strapi + disposable PostgreSQL ownership journey.
 *
 * The only browser response fixture is /api/auth/token: a fresh EdDSA JWT from
 * this test's loopback JWKS authority. Strapi verifies it and resolves users,
 * roles, capabilities and sid itself. Central Better Auth login is not covered.
 * No saved apps/e2e/.auth state, production target, or catalog HTTP mock is used.
 * Requires the workspace's installed Playwright Chromium and admin dependencies.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { makeFactories, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

const root = path.resolve(__dirname, "../../../../../..");
const adminDir = path.join(root, "apps/admin");
const e2eRequire = createRequire(path.join(root, "apps/e2e/package.json"));
const adminRequire = createRequire(path.join(adminDir, "package.json"));
const { chromium, expect: browserExpect } = e2eRequire("@playwright/test");
const adminOrigin = "http://127.0.0.1:4391";
const evidenceDir = process.env.PRODUCT_EDIT_BROWSER_EVIDENCE_DIR;
const kid = `local-ownership-${randomUUID()}`;

type Staff = { id: number; sid: string; label: string };
type Proof = { token: string; editorInstanceId: string; generation: number };
let strapi: any;
let f: Factories | undefined;
let browser: any;
let adminProcess: ChildProcess | undefined;
let backendServer: Server | undefined;
let jwksServer: Server | undefined;
let backendOrigin: string;
let issuer: string;
let privateKey: KeyLike;
let productId: number;
let roleId: number;
let settingsId: number;
const permissionIds: number[] = [];
let staff: Staff[];
let adminOutput = "";
let originalEval: unknown;
let redis: any;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server?: Server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function token(user: Staff) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ strapi_user_id: user.id, sid: user.sid })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer(issuer)
    .setAudience(backendOrigin)
    .setSubject(`test-staff-${user.id}`)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 60)
    .setJti(randomUUID())
    .sign(privateKey);
}

async function staffContext(user: Staff) {
  const context = await browser.newContext({ baseURL: adminOrigin, serviceWorkers: "block" });
  context.setDefaultTimeout(20_000);
  await context.addCookies([
    {
      name: "infinity_admin_route_hint",
      value: "1",
      url: adminOrigin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  // Only the signed-token boundary is replaced. /auth/self, catalog reads,
  // presence, claims and every mutation go directly to the real Strapi server.
  await context.route(`${issuer}/api/auth/token`, async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": adminOrigin,
        "access-control-allow-credentials": "true",
      },
      body: JSON.stringify({ token: await token(user) }),
    });
  });
  return context;
}

async function authenticated(user: Staff, pathname: string, init: RequestInit = {}) {
  return fetch(`${backendOrigin}/api${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token(user)}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

async function waitUntil(check: () => Promise<boolean>, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the real fixture state");
}

beforeAll(async () => {
  if ((process.env.INTEGRATION_DB_MODE || "testcontainers") !== "testcontainers") {
    throw new Error(
      "Browser ownership fixture requires its own disposable Testcontainers database",
    );
  }
  if (process.env.NODE_ENV !== "test" || process.env.DATABASE_NAME !== "infinity_test") {
    throw new Error("Browser ownership fixture refused a non-disposable database");
  }
  backendServer = createServer();
  backendOrigin = await listen(backendServer);
  const keys = await generateKeyPair("EdDSA");
  privateKey = keys.privateKey;
  const publicKey = { ...(await exportJWK(keys.publicKey)), alg: "EdDSA", use: "sig", kid };
  jwksServer = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/auth/jwks") response.end(JSON.stringify({ keys: [publicKey] }));
    else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  issuer = await listen(jwksServer);
  Object.assign(process.env, {
    STRAPI_ENABLE_DOCUMENTATION: "false",
    BETTER_AUTH_BRIDGE_ENABLED: "true",
    BETTER_AUTH_ENVIRONMENT: "development",
    BETTER_AUTH_JWKS_URL: `${issuer}/api/auth/jwks`,
    BETTER_AUTH_JWT_ISSUER: issuer,
    BETTER_AUTH_JWT_AUDIENCE: backendOrigin,
    ADMIN_URL: adminOrigin,
    FRONTEND_URL: "http://127.0.0.1:4392",
    IS_PROXIED: "false",
  });
  strapi = await setupStrapi();
  strapi.server.mount();
  backendServer.on("request", strapi.server.app.callback());
  // The standard integration provider fixture has no Lua evaluator. Allow only
  // the external Redis rate-limit boundary; all lease/guard code remains real.
  const compiledEntry = require(path.join(process.env.INTEGRATION_DIST_DIR!, "src/index.js"));
  redis = await compiledEntry.RedisClient;
  originalEval = redis.eval;
  redis.eval = jest.fn(async () => [1, 0]);

  f = makeFactories(strapi);
  // SKIP_BOOTSTRAP_SEED omits the ordinary settings singleton. Seed it before
  // any authenticated HTTP request, so homepage reads do not need to create it.
  settingsId = (await strapi.db.query("api::settings.settings").create({ data: {} })).id;
  const category = await f.createCategory({ title: "دسته آزمایشی مرورگر" });
  const product = await f.createProduct({
    title: "محصول آزمایشی مرورگر",
    mainCategoryId: category.id,
    status: "InActive",
  });
  productId = product.id;
  await f.createVariation({ productId, stockCount: 5 });
  const role = await strapi.db.query("plugin::users-permissions.role").create({
    data: {
      name: "Store Manager",
      type: "store-manager",
      description: "Disposable browser ownership staff",
    },
  });
  roleId = role.id;
  for (const action of [
    "api::auth.auth.self",
    "api::product.product.find",
    "api::product.product.findOne",
    "api::product.product.editLease",
    "api::product.product.editSnapshot",
    "api::product.product.editAcquire",
    "api::product.product.editRenew",
    "api::product.product.editTakeover",
    "api::product.product.editRelease",
    "api::product.product.editor",
    "api::product-category.product-category.find",
    "api::product-tag.product-tag.find",
    "api::product-variation.product-variation.find",
    "api::product-stock.product-stock.find",
    "api::settings.settings.getHomepageProducts",
    "api::admin-product-list.admin-product-list.query",
    "api::admin-product-list.admin-product-list.counts",
  ]) {
    const permission = await strapi.db
      .query("plugin::users-permissions.permission")
      .create({ data: { action, role: roleId } });
    permissionIds.push(permission.id);
  }
  staff = [];
  for (const label of ["شیوا", "مریم"]) {
    const user = await f.createUser();
    await strapi.db
      .query("plugin::users-permissions.user")
      .update({ where: { id: user.id }, data: { role: roleId } });
    await f.createUserInfo({ userId: user.id, firstName: label, lastName: "آزمایشی" });
    staff.push({ id: user.id, sid: randomUUID(), label });
  }

  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    ADMIN_URL: adminOrigin,
    NEXT_PUBLIC_ADMIN_URL: adminOrigin,
    NEXT_PUBLIC_ADMIN_ENVIRONMENT: "development",
    NEXT_PUBLIC_AUTH_ENVIRONMENT: "development",
    NEXT_PUBLIC_AUTH_URL: issuer,
    NEXT_PUBLIC_AUTH_ORIGIN: issuer,
    NEXT_PUBLIC_API_URL: `${backendOrigin}/api`,
    NEXT_PUBLIC_API_BASE_URL: `${backendOrigin}/api`,
    STRAPI_INTERNAL_URL: `${backendOrigin}/api`,
    STRAPI_BUILD_TIME_URL: `${backendOrigin}/api`,
    NEXT_PUBLIC_IMAGE_BASE_URL: backendOrigin,
    NEXT_PUBLIC_STOREFRONT_URL: "http://127.0.0.1:4392",
    NEXT_PUBLIC_STRAPI_TOKEN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
    SENTRY_DSN: "",
    NEXT_PUBLIC_MEDIA_CDN_URL: "",
    NEXT_PUBLIC_ADMIN_UMAMI_URL: "",
    NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID: "",
    E2E_API_PROXY_TARGET: "",
    AUTH_INTERNAL_URL: issuer,
  };
  adminProcess = spawn(
    process.execPath,
    [
      adminRequire.resolve("next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4391",
    ],
    {
      cwd: adminDir,
      env: childEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [adminProcess.stdout, adminProcess.stderr])
    stream?.on("data", (data) => {
      adminOutput = (adminOutput + String(data)).slice(-20_000);
    });
  await waitUntil(async () => {
    if (adminProcess?.exitCode !== null) throw new Error(`Local admin exited: ${adminOutput}`);
    try {
      return (await fetch(`${adminOrigin}/api/health/live`)).ok;
    } catch {
      return false;
    }
  }, 120_000);
  browser = await chromium.launch({ headless: true });
  // `next dev` compiles a route on its first request. On a loaded CI runner the
  // product page's first compile outlasted the test's 120 s wait for the lease
  // acquire, so compile it here, signed out: no token means no lease is taken.
  const warm = await browser.newContext({ baseURL: adminOrigin, serviceWorkers: "block" });
  await warm.addCookies([
    { name: "infinity_admin_route_hint", value: "1", url: adminOrigin, httpOnly: true, sameSite: "Lax" },
  ]);
  await (await warm.newPage())
    .goto(`/products/${productId}`, { timeout: 240_000, waitUntil: "load" })
    .catch(() => undefined);
  await warm.close();
}, 480_000);

afterAll(async () => {
  // Close contexts first so their best-effort releases still have a live API.
  await browser?.close();
  if (adminProcess?.pid && adminProcess.exitCode === null) {
    const stopped = new Promise<void>((resolve) => adminProcess!.once("exit", () => resolve()));
    process.kill(-adminProcess.pid, "SIGTERM");
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (adminProcess.exitCode === null) {
      process.kill(-adminProcess.pid, "SIGKILL");
      await stopped;
    }
  }
  await close(backendServer);
  await close(jwksServer);
  if (redis) {
    if (originalEval === undefined) delete redis.eval;
    else redis.eval = originalEval;
  }
  try {
    if (strapi) {
      if (productId)
        await strapi.db.connection("product_edit_leases").where({ product_id: productId }).delete();
      await f?.cleanup();
      if (settingsId)
        await strapi.db.query("api::settings.settings").delete({ where: { id: settingsId } });
      if (roleId) {
        for (const id of permissionIds)
          await strapi.db.query("plugin::users-permissions.permission").delete({ where: { id } });
        await strapi.db.query("plugin::users-permissions.role").delete({ where: { id: roleId } });
      }
    }
  } finally {
    await teardownStrapi();
  }
}, 60_000);

it("fences a real authenticated stale browser, keeps its draft, observes on refresh and releases on navigation", async () => {
  expect(staff[0].id).not.toBe(staff[1].id);
  expect(staff[0].sid).not.toBe(staff[1].sid);
  for (const user of staff) {
    const identity = await authenticated(user, "/auth/self");
    const body: any = await identity.json();
    expect({ status: identity.status, error: body.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(body.id ?? body.data?.id).toBe(user.id);
    expect(body.capabilities ?? body.data?.capabilities).toContain("product.update");
  }
  expect([401, 403]).toContain(
    (await fetch(`${backendOrigin}/api/products/${productId}/edit-lease`)).status,
  );
  const first = await staffContext(staff[0]);
  const second = await staffContext(staff[1]);
  const a = await first.newPage();
  const b = await second.newPage();
  let acquireCalls = 0;
  for (const context of [first, second])
    context.on("request", (request: any) => {
      if (
        request.url() === `${backendOrigin}/api/products/${productId}/edit-lease/acquire` &&
        request.method() === "POST"
      )
        acquireCalls++;
    });
  try {
    const acquisition = a.waitForResponse(
      (r: any) => r.url().endsWith(`/products/${productId}/edit-lease/acquire`) && r.ok(),
      { timeout: 120_000 },
    );
    const [, acquiredResponse] = await Promise.all([
      a.goto(`/products/${productId}`, { timeout: 120_000 }).then((response: any) => {
        if (!response?.ok())
          throw new Error(
            `Local admin product page failed (${response?.status()}): ${adminOutput}`,
          );
      }),
      acquisition,
    ]);
    const original = (await acquiredResponse.json()).data;
    const proof: Proof = original.lease;
    const persisted = await strapi.db
      .connection("product_edit_leases")
      .where({ product_id: productId })
      .first();
    expect(persisted.owner_id).toBe(staff[0].id);
    expect(persisted.session_id).toBe(staff[0].sid);
    await browserExpect(a.getByTestId("admin-product-save")).toBeEnabled();
    await a.locator('input[name="name"]').fill("تغییرات محفوظ همکار اول");

    await b.goto(`/products/${productId}`, { timeout: 120_000 });
    await browserExpect(b.getByRole("dialog")).toContainText("این محصول در حال ویرایش است");
    await browserExpect(b.getByRole("dialog")).toContainText(staff[0].label);
    await b.getByRole("button", { name: "مشاهده بدون ویرایش", exact: true }).click();
    await browserExpect(b.getByTestId("admin-product-save")).toBeDisabled();
    await b.getByRole("button", { name: "شروع ویرایش", exact: true }).click();
    const takeover = b.waitForResponse(
      (r: any) => r.url().endsWith(`/products/${productId}/edit-lease/takeover`) && r.ok(),
    );
    await b.getByRole("button", { name: "گرفتن دسترسی ویرایش", exact: true }).click();
    const fresh = (await (await takeover).json()).data;
    expect(fresh.lease.generation).toBeGreaterThan(proof.generation);
    await browserExpect(b.getByTestId("admin-product-save")).toBeEnabled();
    await b.locator('input[name="name"]').fill("عنوان ذخیره‌شده همکار دوم");
    const committed = b.waitForResponse(
      (r: any) =>
        r.url().endsWith(`/products/${productId}/editor`) && r.request().method() === "PUT",
    );
    await b.getByTestId("admin-product-save").click();
    const saveResponse = await committed;
    const saveBody = await saveResponse.json();
    expect({ status: saveResponse.status(), error: saveBody.error }).toEqual({
      status: 200,
      error: undefined,
    });
    const current = await strapi.db
      .query("api::product.product")
      .findOne({ where: { id: productId } });
    expect(current.Title).toBe("عنوان ذخیره‌شده همکار دوم");

    // Send the obsolete proof from A's browser with A's valid signed session.
    // The browser's route hint is never used as backend authorization.
    const stale = await a.evaluate(
      async ({ url, bearer, lease, revision }: any) => {
        const response = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
            "X-Product-Edit-Token": lease.token,
            "X-Product-Edit-Instance": lease.editorInstanceId,
            "X-Product-Edit-Generation": String(lease.generation),
            "X-Product-Expected-Revision": String(revision),
          },
          body: JSON.stringify({ data: { Title: "stale authenticated overwrite" } }),
        });
        return { status: response.status, body: await response.json() };
      },
      {
        url: `${backendOrigin}/api/products/${productId}/editor`,
        bearer: await token(staff[0]),
        lease: proof,
        revision: original.snapshot.revision,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error?.details?.code).toBe("EDIT_LEASE_LOST");
    const afterStale = await strapi.db
      .query("api::product.product")
      .findOne({ where: { id: productId } });
    expect(afterStale.Title).toBe(current.Title);
    expect(afterStale.EditRevision).toBe(current.EditRevision);
    await browserExpect(a.getByTestId("admin-product-save")).toBeDisabled({ timeout: 20_000 });
    await browserExpect(a.locator('input[name="name"]')).toHaveValue("تغییرات محفوظ همکار اول");
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      await a.screenshot({
        path: path.join(evidenceDir, "product-edit-real-frozen.png"),
        fullPage: true,
      });
    }

    const acquisitionsBeforeReload = acquireCalls;
    a.on("dialog", (dialog: any) => void dialog.accept());
    await a.reload();
    await browserExpect(a.getByRole("dialog")).toContainText(staff[1].label);
    await browserExpect(a.getByTestId("admin-product-save")).toBeDisabled();
    expect(acquireCalls).toBe(acquisitionsBeforeReload);
    const refreshedLease = await strapi.db
      .connection("product_edit_leases")
      .where({ product_id: productId })
      .first();
    expect(refreshedLease.owner_id).toBe(staff[1].id);
    expect(refreshedLease.session_id).toBe(staff[1].sid);

    await b.locator('input[name="name"]').fill("پیش‌نویس محفوظ آفلاین");
    await second.setOffline(true);
    await b.getByTestId("admin-product-save").click();
    await browserExpect(b.getByTestId("admin-product-save")).toBeDisabled();
    await browserExpect(b.locator('input[name="name"]')).toHaveValue("پیش‌نویس محفوظ آفلاین");
    expect(
      (await strapi.db.query("api::product.product").findOne({ where: { id: productId } })).Title,
    ).toBe(current.Title);
    await second.setOffline(false);
    // Normal in-app navigation leaves the document alive for the release.
    // Full document unload/close remains best-effort and falls back to expiry.
    await b.getByTestId("admin-product-cancel").click();
    const release = b.waitForResponse(
      (r: any) =>
        r.url().endsWith(`/products/${productId}/edit-lease/release`) &&
        r.request().method() === "POST",
    );
    await b.getByRole("button", { name: "خروج بدون ذخیره", exact: true }).click();
    expect((await release).status()).toBe(200);
    // The products list is a cold Next dev route in the integration job.
    // Keep the destination assertion while allowing its compilation to finish.
    await browserExpect(b).toHaveURL(`${adminOrigin}/products`, { timeout: 120_000 });
    await waitUntil(async () => {
      const row = await strapi.db
        .connection("product_edit_leases")
        .where({ product_id: productId })
        .first();
      return !row?.owner_id;
    });
    for (const page of [a, b]) {
      const storage = await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      );
      expect(storage).not.toContain(proof.token);
      expect(storage).not.toContain(fresh.lease.token);
    }
  } catch (error) {
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, "product-edit-admin-dev.log"), adminOutput);
      await a
        .screenshot({
          path: path.join(evidenceDir, "product-edit-real-failure.png"),
          fullPage: true,
        })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await first.close();
    await second.close();
  }
}, 240_000);
