import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  apiGet,
  apiPost,
  expectApiOk,
  findProductVariationBySku,
  getCart,
  getCustomerOrderDetail,
  getPaymentStatus,
  getProductVariationStock,
  getWalletBalance,
  resetCartToVariation,
} from "../../helpers/api";
import { fillCheckoutWithWallet } from "../../helpers/checkout";
import { E2E_PAYMENT_VARIATION_SKU, E2E_PRODUCT_TITLE } from "../../fixtures/storefront";
import { prepareStorefrontPage } from "../../helpers/page";

type WalletPurchase = {
  orderId: number;
  variationId: number;
  stockBefore: number;
  walletBefore: number;
};

async function completeWalletPurchase(
  page: Page,
  request: APIRequestContext,
): Promise<WalletPurchase> {
  const variation = await findProductVariationBySku(request);
  const stockBefore = await getProductVariationStock(request, variation.id);
  const walletBefore = await getWalletBalance(request);
  await resetCartToVariation(request, variation.id, 1, "customer");

  await page.goto("/checkout", { waitUntil: "domcontentloaded" });
  await fillCheckoutWithWallet(page);

  const finalizeResponsePromise = page.waitForResponse(
    (response) =>
      /\/api\/carts\/finalize(?:\?.*)?$/i.test(response.url()) &&
      response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.getByTestId("checkout-submit").click();
  const finalizeResponse = await finalizeResponsePromise;
  expect(
    finalizeResponse.ok(),
    `wallet checkout failed with ${finalizeResponse.status()}: ${await finalizeResponse.text()}`,
  ).toBe(true);
  const payload = (await finalizeResponse.json()) as {
    data?: { orderId?: number };
    orderId?: number;
  };
  const orderId = Number(payload.data?.orderId ?? payload.orderId);
  expect(orderId).toBeGreaterThan(0);

  await expect(page).toHaveURL(new RegExp(`/payment/result\\?orderId=${orderId}$`), {
    timeout: 45_000,
  });
  await expect(page.getByRole("heading", { name: "پرداخت با موفقیت ثبت شد" })).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pendingOrderId"))).toBeNull();

  const payment = await getPaymentStatus(request, "customer", orderId);
  expect(payment).toMatchObject({
    orderId,
    status: "Started",
    paymentStatus: "Succeeded",
    isPaid: true,
    paymentGateway: "Wallet",
  });

  const cart = await getCart(request, "customer");
  expect(cart.data?.cart_items ?? []).toHaveLength(0);
  await expect
    .poll(() => getProductVariationStock(request, variation.id))
    .toBe(stockBefore - 1);

  return { orderId, variationId: variation.id, stockBefore, walletBefore };
}

test.describe("real wallet payment lifecycle", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test("@payment @smoke pays atomically, persists the result, and exposes admin fulfilment", async ({
    page,
    request,
  }) => {
    const runtime = await prepareStorefrontPage(page);
    const purchase = await completeWalletPurchase(page, request);

    const adminOrder = await apiGet(request, "admin", `/orders/${purchase.orderId}`);
    await expectApiOk(adminOrder, `admin read order ${purchase.orderId}`);

    const transition = await apiPost(
      request,
      "admin",
      `/orders/${purchase.orderId}/admin/transition`,
      { status: "Shipment" },
    );
    await expectApiOk(transition, `ship order ${purchase.orderId}`);

    const persisted = await getCustomerOrderDetail(request, purchase.orderId);
    expect(persisted).toMatchObject({ id: purchase.orderId, Status: "Shipment" });
    expect(persisted?.order_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ProductTitle: E2E_PRODUCT_TITLE,
          ProductSKU: E2E_PAYMENT_VARIATION_SKU,
          Count: 1,
        }),
      ]),
    );

    await page.goto(`/orders/${purchase.orderId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("order-current-status")).toContainText("ارسال شده", {
      timeout: 30_000,
    });
    await expect(page.getByText("سفارش ارسال شد", { exact: true })).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("order-current-status")).toContainText("ارسال شده", {
      timeout: 30_000,
    });
    runtime.assertClean();
  });

  test("@payment @regression cancellation restores stock and credits the wallet exactly once", async ({
    page,
    request,
  }) => {
    const runtime = await prepareStorefrontPage(page);
    const purchase = await completeWalletPurchase(page, request);
    const walletAfterPurchase = await getWalletBalance(request);
    expect(walletAfterPurchase).toBeLessThan(purchase.walletBefore);

    const cancellation = await apiPost(
      request,
      "admin",
      `/orders/${purchase.orderId}/admin/cancel`,
      { reason: "E2E cancellation recovery" },
    );
    await expectApiOk(cancellation, `cancel order ${purchase.orderId}`);
    const cancellationPayload = (await cancellation.json()) as {
      data?: { refundMethod?: string; walletCreditToman?: number };
    };
    expect(cancellationPayload.data?.refundMethod).toBe("WalletCredit");
    expect(Number(cancellationPayload.data?.walletCreditToman)).toBeGreaterThan(0);

    await expect.poll(() => getWalletBalance(request)).toBe(purchase.walletBefore);
    await expect
      .poll(() => getProductVariationStock(request, purchase.variationId))
      .toBe(purchase.stockBefore);

    const persisted = await getCustomerOrderDetail(request, purchase.orderId);
    expect(persisted).toMatchObject({ id: purchase.orderId, Status: "Cancelled" });
    expect(persisted?.contract_transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Type: "Return",
          Status: "Success",
          external_source: "WalletCredit",
        }),
      ]),
    );

    const replay = await apiPost(
      request,
      "admin",
      `/orders/${purchase.orderId}/admin/cancel`,
      { reason: "duplicate cancellation" },
    );
    expect([400, 409]).toContain(replay.status());
    expect(await getWalletBalance(request)).toBe(purchase.walletBefore);
    expect(await getProductVariationStock(request, purchase.variationId)).toBe(
      purchase.stockBefore,
    );

    await page.goto(`/orders/${purchase.orderId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("order-current-status")).toContainText("لغو شده", {
      timeout: 30_000,
    });
    runtime.assertClean();
  });
});
