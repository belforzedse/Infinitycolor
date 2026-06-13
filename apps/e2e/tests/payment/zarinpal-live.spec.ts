import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { clearCart, getPaymentStatus, getProductVariationStock } from "../../helpers/api";
import { clickCancel, clickPay, finalizeToZarinpalRedirect } from "../../helpers/payment";

test.describe("Zarinpal live sandbox payment", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      !String(process.env.E2E_BASE_URL || "").includes("staging.infinitycolor.co"),
      "@payment-live must point E2E_BASE_URL/E2E_API_URL at staging.",
    );
    testInfo.skip(
      process.env.E2E_AUTH_MODE !== "login" || process.env.E2E_SEED_MODE !== "skip",
      "@payment-live must run with E2E_AUTH_MODE=login and E2E_SEED_MODE=skip for staging auth.",
    );
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Live payment sandbox coverage is desktop-only.",
    );
    await clearCart(request, "customer");
  });

  test("@payment-live sandbox pay marks the order paid and decrements stock", async ({
    page,
    request,
  }) => {
    const payment = await finalizeToZarinpalRedirect(page, request, { mockGateway: false });
    const stockBeforePay = await getProductVariationStock(request, payment.variationId);

    await clickPay(page);

    await expect(page).toHaveURL(/\/payment\/success/, { timeout: 90_000 });
    await expect(page.getByTestId("live-payment-success")).toBeVisible({ timeout: 30_000 });

    const paymentStatus = await getPaymentStatus(request, "customer", payment.orderId);
    expect(paymentStatus?.isPaid).toBe(true);
    expect(paymentStatus?.paymentGateway).toBe("ZarinPal");

    const stockAfterPay = await getProductVariationStock(request, payment.variationId);
    expect(stockAfterPay).toBe(stockBeforePay - 1);
  });

  test("@payment-live sandbox cancel leaves the order unpaid and stock intact", async ({
    page,
    request,
  }) => {
    const payment = await finalizeToZarinpalRedirect(page, request, { mockGateway: false });
    const stockBeforeCancel = await getProductVariationStock(request, payment.variationId);

    await clickCancel(page);

    await expect(page).toHaveURL(/\/payment\/cancelled|\/payment\/failure/, {
      timeout: 90_000,
    });
    await expect(
      page.getByTestId("live-payment-cancelled").or(page.getByTestId("live-payment-failure")),
    ).toBeVisible({ timeout: 30_000 });

    const paymentStatus = await getPaymentStatus(request, "customer", payment.orderId);
    expect(paymentStatus?.isPaid).toBe(false);

    const stockAfterCancel = await getProductVariationStock(request, payment.variationId);
    expect(stockAfterCancel).toBe(stockBeforeCancel);
  });
});
