import { expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

const LAB = "http://127.0.0.1:4352";
const FRONTEND = "http://127.0.0.1:4350";

type RecoveryBrowser = { page: Page; context: BrowserContext; request: APIRequestContext };

async function recoveryCheckout(
  { page, context, request }: RecoveryBrowser,
  firstLoss: "after_commit" | "before_dispatch",
) {
  const seeded = await request.post(`${LAB}/__lab/seed`, { data: { mode: "normal", wallet: false } });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();
  const { userId } = await seeded.json();
  const traffic = {
    finalizes: [] as Array<Record<string, unknown>>,
    lookups: [] as string[],
    quoteCount: 0,
    handoffCount: 0,
    blocked: [] as string[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => traffic.errors.push(error.message));
  await context.route("**/*", async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    if (url.origin === "http://localhost:2889" && url.pathname === "/api/auth/token") {
      const token = await (await request.get(`${LAB}/__lab/token?userId=${userId}`)).json();
      await route.fulfill({ json: token, headers: { "access-control-allow-origin": FRONTEND, "access-control-allow-credentials": "true" } });
    } else if (url.hostname === "bpm.shaparak.ir" && url.pathname === "/pgwchannel/startpay.mellat") {
      traffic.handoffCount += 1;
      const refId = new URLSearchParams(incoming.postData() || "").get("RefId");
      await route.fulfill({ status: 302, headers: { location: `${LAB}/bank?RefId=${encodeURIComponent(refId || "")}` } });
    } else if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      if (url.origin === "http://127.0.0.1:4351" && incoming.method() === "POST" && url.pathname === "/api/carts/finalize") {
        traffic.finalizes.push(incoming.postDataJSON());
        if (traffic.finalizes.length === 1) {
          if (firstLoss === "after_commit") {
            // Execute exactly once on the disposable server, then lose only the
            // browser response after successful creation and provider initiation.
            const committed = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
            expect(committed.ok(), await committed.text()).toBeTruthy();
            const body = await committed.json();
            expect(body.data || body).toMatchObject({ success: true, orderId: expect.any(Number) });
            const state = await (await request.get(`${LAB}/__lab/state?userId=${userId}`)).json();
            expect(state).toMatchObject({ orderCount: 1, attemptCount: 1, contractCount: 1, reservationCount: 1, providerInitiationCount: 1 });
          }
          await route.abort("connectionreset");
          return;
        }
      }
      if (url.origin === "http://127.0.0.1:4351" && url.pathname === "/api/carts/quote" && incoming.method() === "POST") traffic.quoteCount += 1;
      if (url.origin === "http://127.0.0.1:4351" && url.pathname === "/api/carts/checkout-attempt" && incoming.method() === "GET") traffic.lookups.push(url.searchParams.get("attemptId") || "");
      await route.continue();
    } else {
      traffic.blocked.push(incoming.url());
      await route.abort("blockedbyclient");
    }
  });
  await context.addCookies([{ name: "infinity_route_hint", value: "1", url: FRONTEND, httpOnly: true, sameSite: "Lax" }]);
  await page.addInitScript(() => {
    if (location.origin === "http://127.0.0.1:4350") localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
  });
  return { userId, traffic };
}

async function fillRecoveryCheckout(page: Page) {
  await expect(page.getByTestId("checkout-submit")).toBeVisible({ timeout: 30_000 });
  await page.locator('input[name="fullName"]').fill("مریم آزمایشی");
  await page.getByTestId("payment-gateway-mellat").click();
  await page.getByTestId("checkout-shipping-option").first().click();
  await page.getByTestId("checkout-accept-terms").check();
}

test("Mellat lost finalized response: owner lookup recovers the committed order without a second payment", async ({ page, context, request }, testInfo) => {
  const { userId, traffic } = await recoveryCheckout({ page, context, request }, "after_commit");
  await page.goto("/checkout");
  await fillRecoveryCheckout(page);
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("checkout-form-error")).toBeVisible({ timeout: 30_000 });
  expect(traffic.finalizes).toHaveLength(1);
  expect(traffic.handoffCount).toBe(0);
  expect(traffic.errors).toEqual([]);
  const attemptId = String(traffic.finalizes[0].attemptId);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pendingCheckoutFinalization") || "null")?.attemptId)).toBe(attemptId);
  await page.getByTestId("checkout-error-retry").click();
  await expect(page).toHaveURL(/\/payment\/result\?orderId=/, { timeout: 30_000 });
  await expect(page.getByTestId("payment-result")).toBeVisible();
  const state = await (await request.get(`${LAB}/__lab/state?userId=${userId}`)).json();
  expect(state).toMatchObject({ orderCount: 1, attemptCount: 1, contractCount: 1, reservationCount: 1, providerInitiationCount: 1, stockCount: 5, stockReserved: 1 });
  expect(new URL(page.url()).searchParams.get("orderId")).toBe(String(state.orderId));
  expect(traffic.lookups).toContain(attemptId);
  expect(traffic.finalizes).toHaveLength(1);
  expect(traffic.quoteCount).toBe(1);
  expect(traffic.handoffCount).toBe(0);
  await testInfo.attach("blocked-external-requests", { body: JSON.stringify(traffic.blocked), contentType: "application/json" });
});

test("Mellat lost request across reload: changed notes block replay, identical request retains the original attempt", async ({ page, context, request }, testInfo) => {
  const { userId, traffic } = await recoveryCheckout({ page, context, request }, "before_dispatch");
  await page.goto("/checkout");
  await fillRecoveryCheckout(page);
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("checkout-form-error")).toBeVisible();
  const original = traffic.finalizes[0];
  expect(original.attemptId).toBeTruthy();
  expect(await (await request.get(`${LAB}/__lab/state?userId=${userId}`)).json()).toMatchObject({ orderCount: 0, attemptCount: 0, contractCount: 0, reservationCount: 0, providerInitiationCount: 0 });
  await page.reload();
  await fillRecoveryCheckout(page);
  await page.locator('textarea[name="notes"]').fill("توضیح تغییرکرده پس از بازیابی");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("checkout-form-error")).toContainText("نتیجه پرداخت قبلی هنوز مشخص نیست");
  expect(traffic.lookups).toContain(String(original.attemptId));
  expect(traffic.finalizes).toHaveLength(1);
  expect(traffic.quoteCount).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("pendingCheckoutAttemptId"))).toBe(original.attemptId);
  expect(await page.evaluate(() => localStorage.getItem("pendingCheckoutQuoteHash"))).toBe(original.quoteHash);
  await page.locator('textarea[name="notes"]').fill("");
  await page.getByTestId("checkout-error-retry").click();
  await expect(page.getByRole("heading", { name: "درگاه آزمایشی محلی ملت" })).toBeVisible({ timeout: 30_000 });
  expect(traffic.finalizes).toHaveLength(2);
  const orderFields = ({ analyticsCorrelationId: _correlation, ...body }: Record<string, unknown>) => body;
  expect(orderFields(traffic.finalizes[1])).toEqual(orderFields(original));
  expect(traffic.quoteCount).toBe(1);
  expect(traffic.handoffCount).toBe(1);
  expect(traffic.errors).toEqual([]);
  expect(await (await request.get(`${LAB}/__lab/state?userId=${userId}`)).json()).toMatchObject({ orderCount: 1, attemptCount: 1, contractCount: 1, reservationCount: 1, providerInitiationCount: 1, stockCount: 5, stockReserved: 1 });
  await testInfo.attach("blocked-external-requests", { body: JSON.stringify(traffic.blocked), contentType: "application/json" });
});

for (const scenario of ["normal", "timeout", "wallet"] as const) {
  test(`Mellat ${scenario}: actual checkout, POST handoff and recovered result`, async ({ page, context, request }, testInfo) => {
    const seeded = await request.post(`${LAB}/__lab/seed`, { data: { mode: scenario, wallet: scenario === "wallet" } });
    expect(seeded.ok(), await seeded.text()).toBeTruthy();
    const { userId } = await seeded.json();
    const unexpected: string[] = [];
    const handoffs: Array<{ method: string; body: string }> = [];
    await context.route("**/*", async (route) => {
      const incoming = route.request();
      const url = new URL(incoming.url());
      if (url.origin === "http://localhost:2889" && url.pathname === "/api/auth/token") {
        const token = await (await request.get(`${LAB}/__lab/token?userId=${userId}`)).json();
        await route.fulfill({ json: token, headers: { "access-control-allow-origin": FRONTEND, "access-control-allow-credentials": "true" } });
      } else if (url.hostname === "bpm.shaparak.ir" && url.pathname === "/pgwchannel/startpay.mellat") {
        handoffs.push({ method: incoming.method(), body: incoming.postData() || "" });
        const refId = new URLSearchParams(incoming.postData() || "").get("RefId");
        await route.fulfill({ status: 302, headers: { location: `${LAB}/bank?RefId=${encodeURIComponent(refId || "")}` } });
      } else if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        await route.continue();
      } else {
        unexpected.push(incoming.url());
        await route.abort("blockedbyclient");
      }
    });
    await context.addCookies([{ name: "infinity_route_hint", value: "1", url: FRONTEND, httpOnly: true, sameSite: "Lax" }]);
    await page.addInitScript(() => {
      if (location.origin === "http://127.0.0.1:4350") localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/checkout");
    await expect(page.getByTestId("checkout-submit")).toBeVisible({ timeout: 30_000 });
    await page.locator('input[name="fullName"]').fill("مریم آزمایشی");
    await expect(page.getByTestId("payment-gateway-mellat")).toBeVisible();
    await page.getByTestId("payment-gateway-mellat").click();
    await expect(page.getByTestId("checkout-shipping-option").first()).toBeVisible();
    await page.getByTestId("checkout-shipping-option").first().click();
    if (scenario === "wallet") {
      await page.getByTestId("wallet-contribution-toggle").check();
      await expect(page.getByTestId("wallet-contribution-wallet-leg")).toContainText("۳۵۰");
      await expect(page.getByTestId("wallet-contribution-gateway-leg")).toContainText("۸۵۰");
    }
    await page.getByTestId("checkout-accept-terms").check();
    await page.screenshot({ path: testInfo.outputPath(`${scenario}-checkout.png`), fullPage: true });
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByRole("heading", { name: "درگاه آزمایشی محلی ملت" })).toBeVisible({ timeout: 30_000 });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].method).toBe("POST");
    const initial = await (await request.get(`${LAB}/__lab/state?userId=${userId}`)).json();
    expect(new URLSearchParams(handoffs[0].body).get("RefId")).toBe(initial.receipt.refId);
    expect(initial.receipt.amountIrr).toBe(scenario === "wallet" ? 8_500_000 : 12_000_000);
    expect(initial.stockReserved).toBe(1);
    if (scenario === "wallet") expect(initial).toMatchObject({ walletHoldStatus: "Active", walletHeldIrr: 3_500_000 });
    await page.getByRole("button", { name: "بازگشت به فروشگاه" }).click();
    await expect(page).toHaveURL(/\/payment\/result\?/);
    await expect(page.getByTestId("payment-result")).toContainText(
      scenario === "wallet" ? "در انتظار تعیین وضعیت پرداخت" : "نتیجه پرداخت هنوز مشخص نیست",
    );
    const processed = await request.post(`${LAB}/__lab/process?userId=${userId}`, { timeout: 30_000 });
    expect(processed.ok(), await processed.text()).toBeTruthy();
    if (scenario === "timeout") {
      const pending = await processed.json();
      expect(pending.status).toBe("Unknown");
      expect(pending.state.stockProtected).toBe(true);
      expect(pending.stockReserved).toBe(1);
      await page.screenshot({ path: testInfo.outputPath("timeout-pending.png"), fullPage: true });
      expect((await request.post(`${LAB}/__lab/process?userId=${userId}`)).ok()).toBeTruthy();
    }
    await expect(page.getByTestId("payment-result")).toContainText("پرداخت با موفقیت ثبت شد", { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath(`${scenario}-success.png`), fullPage: true });
    const final = await (await request.get(`${LAB}/__lab/state?userId=${userId}`)).json();
    expect(final).toMatchObject({ status: "Succeeded", orderStatus: "Started", reservationStatus: "Consumed", stockCount: 4, stockReserved: 0, walletHeldIrr: 0 });
    expect(final.receipt.calls.filter((method: string) => method === "bpSettleRequest")).toHaveLength(1);
    expect(final.legs).toHaveLength(scenario === "wallet" ? 2 : 1);
    if (scenario === "wallet") expect(final).toMatchObject({ walletHoldStatus: "Captured", walletBalanceIrr: 0 });
    if (scenario === "timeout") expect(final.receipt.calls).toContain("bpInquiryRequest");
    expect(errors).toEqual([]);
    // Any unapproved browser network destination is blocked before it can connect.
    await testInfo.attach("blocked-external-requests", { body: JSON.stringify(unexpected), contentType: "application/json" });
  });
}
