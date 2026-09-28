import { expect, test, type Request } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  cleanupRuntimeOrders,
  createRuntimeOrder,
  updateOrderStatus,
} from "../../helpers/admin";
import { apiGet, expectApiOk } from "../../helpers/api";
import { prepareStorefrontPage } from "../../helpers/page";

type AdvancedFilter = { field?: string; operator?: string; value?: string };

/** The orders page lists through POST /admin/orders-list/query, filters in the JSON body. */
function ordersQueryFilters(req: Request): AdvancedFilter[] | null {
  if (req.method() !== "POST" || !req.url().includes("/admin/orders-list/query")) {
    return null;
  }
  try {
    const body = req.postDataJSON() as { filters?: unknown } | null;
    return Array.isArray(body?.filters) ? (body.filters as AdvancedFilter[]) : [];
  } catch {
    return null;
  }
}

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

  test("@admin super-admin can read and adjust a runtime order", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);
    const order = await createRuntimeOrder(request);

    await page.goto("/orders?pageSize=100", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page
        .locator(
          `[data-testid="admin-order-row"][data-order-id="${order.orderId}"]:visible`,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    await page
      .locator(
        `[data-testid="admin-order-view"][data-id="${order.orderId}"]:visible`,
      )
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/orders/edit/${order.orderId}$`),
    );

    // Fulfilment order is «تکمیل شده» then «ارسال»; a fresh order is `Started`,
    // so shipping it directly is refused. Walk the chain.
    await updateOrderStatus(request, order.orderId, "Done");
    await updateOrderStatus(request, order.orderId, "Shipment");

    const response = await apiGet(request, "admin", `/orders/${order.orderId}`);
    await expectApiOk(response, "read updated runtime order");
    const payload = (await response.json()) as {
      data?: { Status?: string; attributes?: { Status?: string } };
    };
    expect(payload.data?.attributes?.Status ?? payload.data?.Status).toBe(
      "Shipment",
    );
  });

  test("@admin advanced filter applies, persists, and clears on orders", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);
    const order = await createRuntimeOrder(request);

    await page.goto("/orders?pageSize=100", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page
        .locator(
          `[data-testid="admin-order-row"][data-order-id="${order.orderId}"]:visible`,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: /فیلتر پیشرفته/ }).click();
    const filterDialog = page.getByRole("dialog", { name: "فیلتر پیشرفته" });
    await expect(filterDialog).toBeVisible();
    await filterDialog.getByTestId("advanced-filter-add").click();
    const filterRow = filterDialog.getByTestId("advanced-filter-row");
    await expect(filterRow).toBeVisible({ timeout: 10_000 });
    // The row's selects portal their option lists to document.body.
    const openOption = (label: string) =>
      page.locator("ul button:visible").filter({ hasText: new RegExp(`^${label}$`) });
    await filterRow.locator("button").first().click();
    await openOption("توضیحات").click();
    await filterRow.locator("button").nth(1).click();
    await openOption("شامل").click();
    await filterRow.getByPlaceholder("مقدار").fill("E2E_DO_NOT_USE");

    const filteredRequest = page.waitForRequest((req) =>
      Boolean(
        ordersQueryFilters(req)?.some(
          (item) =>
            item.field === "[Description]" &&
            item.operator === "$containsi" &&
            item.value === "E2E_DO_NOT_USE",
        ),
      ),
    );
    await page.getByTestId("advanced-filter-apply").click();
    await filteredRequest;

    await expect(
      page
        .locator(
          `[data-testid="admin-order-row"][data-order-id="${order.orderId}"]:visible`,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/filter=/);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/filter=/);
    await expect(
      page.getByText("توضیحات: شامل E2E_DO_NOT_USE").filter({ visible: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page
        .locator(
          `[data-testid="admin-order-row"][data-order-id="${order.orderId}"]:visible`,
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: /فیلتر پیشرفته/ }).filter({ visible: true }).click();
    const clearedRequest = page.waitForRequest((req) => {
      const filters = ordersQueryFilters(req);
      return filters !== null && !filters.some((item) => item.field === "[Description]");
    });
    await page.getByRole("button", { name: /پاک کردن فیلترها/ }).filter({ visible: true }).click();
    await clearedRequest;
    await expect(
      page.getByText("توضیحات: شامل E2E_DO_NOT_USE").filter({ visible: true }),
    ).toHaveCount(0);
  });
});
