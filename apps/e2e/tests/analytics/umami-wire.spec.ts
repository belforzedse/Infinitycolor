import http from "node:http";
import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Asserts what the storefront actually sends to Umami, in a real browser,
 * through the deployed 3.3.1 tracker. Run with analytics.playwright.config.ts.
 */

type Recorded = { type: string; payload: Record<string, any> };

const COLLECTOR_PORT = Number(process.env.E2E_UMAMI_PORT || 18093);
const tracker = readFileSync(new URL("../../fixtures/umami-telemetry-3.3.1.js", import.meta.url));
const recorded: Recorded[] = [];
let collector: http.Server;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type, x-umami-website-id, x-umami-hostname, x-umami-cache",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

test.beforeAll(async () => {
  collector = http.createServer((req, res) => {
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    if (req.url === "/telemetry.js") {
      res.writeHead(200, { ...cors, "content-type": "application/javascript" });
      return void res.end(tracker);
    }
    if (req.url === "/api/telemetry" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        recorded.push(JSON.parse(body));
        res.writeHead(200, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ cache: "wire-test" }));
      });
      return;
    }
    res.writeHead(404, cors).end();
  });
  await new Promise<void>((resolve) => collector.listen(COLLECTOR_PORT, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => collector.close(resolve));
});

test.beforeEach(() => {
  recorded.length = 0;
});

const pageviews = () =>
  recorded.filter((entry) => entry.type === "event" && !entry.payload.name);
const events = (name: string) =>
  recorded.filter((entry) => entry.type === "event" && entry.payload.name === name);

function b64(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A structurally valid, unsigned token: only the storefront's client reads it. */
const fakeToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({
  sub: "1",
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.signature`;

/**
 * Browser traffic never reaches a real backend: the central-auth token and the
 * payment-status endpoints are stubbed, and everything else off this machine
 * gets an empty 404. Registered on the context so every tab shares it.
 */
async function stubBackend(context: BrowserContext, status?: Record<string, unknown>) {
  const storefront = new URL(test.info().project.use.baseURL || "http://localhost:2888");
  await context.route(
    (url) => url.host !== storefront.host && url.host !== `127.0.0.1:${COLLECTOR_PORT}`,
    (route) => {
      const url = route.request().url();
      if (/\/api\/auth\/token/.test(url)) {
        return route.fulfill({ json: { token: fakeToken } });
      }
      if (status && /\/orders\/\d+\/payment-(status|reconcile)/.test(url)) {
        return route.fulfill({ json: { data: status } });
      }
      return route.fulfill({ status: 404, json: {} });
    },
  );
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  // The tracker posts with keepalive after a double rAF; give it a beat.
  await page.waitForTimeout(1_500);
}

const paidAt = () => new Date(Date.now() - 60_000).toISOString();
const baseStatus = { success: true, attemptId: "attempt-1", authoritative: true, canRetry: false };

test("sends exactly one pageview per route change, including back", async ({ page, context }) => {
  await stubBackend(context);
  await page.goto("/");
  await settle(page);
  expect(pageviews().map((entry) => entry.payload.url)).toEqual(["/"]);
  // The tracker's own auto-pageview is off: every pageview is the storefront's.
  expect(recorded.filter((entry) => entry.type === "event")[0].payload.website).toBe(
    "123e4567-e89b-42d3-a456-426614174000",
  );

  const link = page.locator('a[href^="/plp"]:visible, a[href^="/pdp"]:visible').first();
  const href = (await link.getAttribute("href")) || "";
  await link.click();
  await page.waitForURL((url) => url.pathname !== "/");
  await settle(page);
  await page.goBack();
  await settle(page);

  expect(pageviews().map((entry) => entry.payload.url)).toEqual([
    "/",
    href.split("?")[0],
    "/",
  ]);
});

test("emits one IRR purchase per order across reloads and tabs, only once verified", async ({
  page,
  context,
}) => {
  await stubBackend(context, {
    ...baseStatus,
    orderId: 910001,
    status: "Started",
    paymentStatus: "Succeeded",
    isPaid: true,
    paymentGateway: "SamanKish",
    paidAmountIrr: 21_490_000,
    paidAt: paidAt(),
  });
  await page.goto("/payment/result?orderId=910001&resultHint=success");
  await expect(page.getByText("پرداخت با موفقیت ثبت شد").first()).toBeVisible();
  await settle(page);
  await page.reload();
  await settle(page);
  const secondTab = await context.newPage();
  await secondTab.goto("/payment/result?orderId=910001");
  await expect(secondTab.getByText("پرداخت با موفقیت ثبت شد").first()).toBeVisible();
  await settle(secondTab);

  expect(pageviews()).toHaveLength(3);
  const purchases = events("purchase");
  expect(purchases).toHaveLength(1);
  expect(purchases[0].payload.data).toMatchObject({
    transaction_id: "910001",
    revenue: 21_490_000,
    currency: "IRR",
    gateway: "samankish",
  });
});

test("a gateway return without backend verification never emits purchase", async ({
  page,
  context,
}) => {
  await stubBackend(context, {
    ...baseStatus,
    orderId: 910002,
    status: "Paying",
    paymentStatus: "Pending",
    isPaid: false,
    paymentGateway: "Mellat",
  });
  await page.goto("/payment/result?orderId=910002&resultHint=success&transactionId=bank-ref");
  await expect(page.getByText("در حال بررسی نتیجه پرداخت").first()).toBeVisible();
  await settle(page);
  expect(events("purchase")).toHaveLength(0);
});

test("tells a shopper's cancellation apart from a failed payment", async ({ browser }) => {
  const cancelled = await browser.newContext();
  await stubBackend(cancelled, {
    ...baseStatus,
    orderId: 910003,
    status: "Cancelled",
    paymentStatus: "Failed",
    isPaid: false,
    paymentGateway: "Mellat",
    canRetry: true,
  });
  const cancelledPage = await cancelled.newPage();
  await cancelledPage.goto("/payment/result?orderId=910003&resultHint=cancelled&reason=user-cancelled");
  await expect(cancelledPage.getByText("پرداخت تکمیل نشد").first()).toBeVisible();
  await settle(cancelledPage);

  const failed = await browser.newContext();
  await stubBackend(failed, {
    ...baseStatus,
    orderId: 910004,
    status: "Cancelled",
    paymentStatus: "Failed",
    isPaid: false,
    paymentGateway: "SamanKish",
    canRetry: true,
  });
  const failedPage = await failed.newPage();
  await failedPage.goto("/payment/result?orderId=910004&resultHint=failure");
  await expect(failedPage.getByText("پرداخت تکمیل نشد").first()).toBeVisible();
  await settle(failedPage);

  expect(events("payment_cancelled").map((entry) => entry.payload.data)).toEqual([
    expect.objectContaining({ transaction_id: "910003", gateway: "mellat" }),
  ]);
  expect(events("payment_failed").map((entry) => entry.payload.data)).toEqual([
    expect.objectContaining({
      transaction_id: "910004",
      gateway: "samankish",
      failure_category: "gateway_failed",
    }),
  ]);
  expect(events("purchase")).toHaveLength(0);
  await cancelled.close();
  await failed.close();
});

test("a blocked collector never affects the payment result", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await stubBackend(context, {
    ...baseStatus,
    orderId: 910005,
    status: "Started",
    paymentStatus: "Succeeded",
    isPaid: true,
    paymentGateway: "SnappPay",
    paidAmountIrr: 35_000_000,
    paidAt: paidAt(),
  });
  // An ad blocker: the tracker script and collector are unreachable.
  await context.route(`http://127.0.0.1:${COLLECTOR_PORT}/**`, (route) => route.abort());
  await page.goto("/payment/result?orderId=910005");
  await expect(page.getByText("پرداخت با موفقیت ثبت شد").first()).toBeVisible();
  await settle(page);
  expect(recorded).toHaveLength(0);
  expect(errors).toEqual([]);
});
