import { expect, test } from "@playwright/test";

const LAB = "http://127.0.0.1:4352";
const FRONTEND = "http://127.0.0.1:4350";

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
