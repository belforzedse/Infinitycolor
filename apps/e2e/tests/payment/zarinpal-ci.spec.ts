import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  clearCart,
  getCart,
  getPaymentStatus,
  getProductVariationStock,
} from "../../helpers/api";
import {
  finalizeToZarinpalRedirect,
  simulateCallbackFailure,
  stubSuccessfulCallback,
} from "../../helpers/payment";

test.describe("Zarinpal CI-safe payment", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Payment redirect coverage is desktop-only; mobile checkout layout is covered separately.",
    );
    await clearCart(request, "customer");
  });

  test("@payment checkout can finalize through Zarinpal and complete a stubbed success callback", async ({
    page,
    request,
  }) => {
    const payment = await finalizeToZarinpalRedirect(page, request);
    await stubSuccessfulCallback(page, payment);

    await page.goto(`/orders/payment-callback?ResNum=${payment.orderId}&RefNum=${payment.refId}`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page).toHaveURL(/\/orders\/success/, { timeout: 30_000 });
    await expect(page.getByTestId("order-payment-success")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("pendingOrderId")))
      .toBeNull();

    const cart = await getCart(request, "customer");
    expect(cart.data?.cart_items ?? []).toHaveLength(0);
  });

  test("@payment cancelled or incomplete Zarinpal callback stays unpaid and preserves stock", async ({
    page,
    request,
  }) => {
    const payment = await finalizeToZarinpalRedirect(page, request);
    const stockBeforeFailure = await getProductVariationStock(request, payment.variationId);

    await simulateCallbackFailure(page, payment);

    const paymentStatus = await getPaymentStatus(request, "customer", payment.orderId);
    expect(paymentStatus?.isPaid).toBe(false);
    expect(paymentStatus?.status).toBe("Paying");

    const stockAfterFailure = await getProductVariationStock(request, payment.variationId);
    expect(stockAfterFailure).toBe(stockBeforeFailure);
  });
});
