import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  cleanupRuntimeOrders,
  createRuntimeOrder,
  updateOrderStatus,
} from "../../helpers/admin";
import { apiGet, expectApiOk } from "../../helpers/api";
import { prepareStorefrontPage } from "../../helpers/page";

test.describe("super-admin order management", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin order management coverage is desktop-only.",
    );
    await cleanupRuntimeOrders(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeOrders(request);
  });

  test("@admin super-admin can read and adjust a runtime order", async ({ page, request }) => {
    await prepareStorefrontPage(page);
    const order = await createRuntimeOrder(request);

    await page.goto("/super-admin/orders?pageSize=100", { waitUntil: "domcontentloaded" });
    await expect(
      page.locator(`[data-testid="admin-order-row"][data-order-id="${order.orderId}"]:visible`).first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.locator(`[data-testid="admin-order-view"][data-id="${order.orderId}"]:visible`).first().click();
    await expect(page).toHaveURL(new RegExp(`/super-admin/orders/edit/${order.orderId}$`));

    await updateOrderStatus(request, order.orderId, "Started");

    const response = await apiGet(request, "admin", `/orders/${order.orderId}`);
    await expectApiOk(response, "read updated runtime order");
    const payload = (await response.json()) as {
      data?: { Status?: string; attributes?: { Status?: string } };
    };
    expect(payload.data?.attributes?.Status ?? payload.data?.Status).toBe("Started");
  });
});
