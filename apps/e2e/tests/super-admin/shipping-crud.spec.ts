import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  assertNonProductionTarget,
  cleanupRuntimeShipping,
  createRuntimeShipping,
} from "../../helpers/admin";
import { apiGet, expectApiOk } from "../../helpers/api";
import { E2E_RUNTIME_PREFIX } from "../../fixtures/storefront";
import { prepareStorefrontPage } from "../../helpers/page";

/**
 * Shipping methods drive checkout cost, so a broken create/edit/delete flow is a
 * revenue risk. This covers the real admin form (UI-driven create + edit) and the
 * list soft-delete, verifying each step against the backend. The dynamic free-
 * shipping rule is exercised via the API fixture (the rule editor's range inputs
 * are covered at the integration layer; here we only assert the rule persists).
 */
test.describe("super-admin shipping CRUD", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin CRUD coverage is desktop-only.",
    );
    assertNonProductionTarget();
    await cleanupRuntimeShipping(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeShipping(request);
  });

  test("@admin super-admin creates a shipping method via the form, then edits and soft-deletes it", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);

    const suffix = `${Date.now()}`;
    const title = `${E2E_RUNTIME_PREFIX}Shipping ${suffix}`;
    const code = `e2e-do-not-use-ship-${suffix}`;

    // --- Create through the real admin form ---
    // The admin ClientLayout renders mobile/tablet/desktop copies of its children,
    // so every form field exists 3x in the DOM. Scope to the one visible at the
    // desktop viewport via `.filter({ visible: true })`.
    await page.goto("/super-admin/shipping/add", { waitUntil: "domcontentloaded" });
    await page.getByLabel("نام نمایشی فارسی").filter({ visible: true }).fill(title);
    await page.getByLabel("کد داخلی").filter({ visible: true }).fill(code);
    await page.getByLabel("هزینه پایه تومان").filter({ visible: true }).fill("45000");
    await page.getByRole("button", { name: "ذخیره", exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/super-admin\/shipping$/, { timeout: 30_000 });

    // Verify it persisted with the values we typed.
    const created = await apiGet(request, "admin", "/shippings", {
      "filters[Code][$eq]": code,
    });
    await expectApiOk(created, "read created shipping");
    const createdPayload = (await created.json()) as {
      data?: Array<{ id: number; attributes?: { Title?: string; Price?: number } }>;
    };
    const createdRow = createdPayload.data?.[0];
    expect(createdRow, "created shipping row").toBeTruthy();
    const shippingId = Number(createdRow?.id);
    expect(createdRow?.attributes?.Title).toBe(title);
    expect(Number(createdRow?.attributes?.Price)).toBe(45000);

    // --- Edit through the form ---
    await page.goto(`/super-admin/shipping/edit/${shippingId}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByLabel("نام نمایشی فارسی").filter({ visible: true })).toHaveValue(title, {
      timeout: 30_000,
    });
    await page.getByLabel("زمان تخمینی تحویل").filter({ visible: true }).fill("۲ تا ۳ روز کاری");
    await page.getByRole("button", { name: "ذخیره", exact: true }).filter({ visible: true }).click();

    // The edit form navigates back to the list on save; the API poll below is the
    // authoritative check that the edit persisted, so we don't assert the URL here
    // (the post-save client navigation can lag a dev-mode route recompile).
    await expect
      .poll(async () => {
        const response = await apiGet(request, "admin", `/shippings/${shippingId}`);
        await expectApiOk(response, "read edited shipping");
        const payload = (await response.json()) as {
          data?: { attributes?: { EstimatedDeliveryText?: string } };
        };
        return payload.data?.attributes?.EstimatedDeliveryText ?? null;
      })
      .toBe("۲ تا ۳ روز کاری");

    // --- Soft-delete from the list ---
    await page.goto("/super-admin/shipping", { waitUntil: "domcontentloaded" });
    await page
      .locator(`[data-testid="admin-shipping-soft-delete"][data-id="${shippingId}"]:visible`)
      .first()
      .click();

    await expect
      .poll(async () => {
        const response = await apiGet(request, "admin", `/shippings/${shippingId}`);
        await expectApiOk(response, "read soft-deleted shipping");
        const payload = (await response.json()) as {
          data?: { attributes?: { removedAt?: string | null } };
        };
        return payload.data?.attributes?.removedAt ?? null;
      })
      .not.toBeNull();
  });

  test("@admin super-admin can create a shipping method carrying a dynamic free-shipping rule", async ({
    request,
  }) => {
    const fixture = await createRuntimeShipping(request, { withRule: true });

    const response = await apiGet(request, "admin", `/shippings/${fixture.shippingId}`);
    await expectApiOk(response, "read shipping with rule");
    const payload = (await response.json()) as {
      data?: { attributes?: { Rules?: Array<{ freeShippingThreshold?: number }> } };
    };
    const rules = payload.data?.attributes?.Rules ?? [];
    expect(rules.length, "shipping retains its dynamic rule").toBeGreaterThan(0);
    expect(Number(rules[0]?.freeShippingThreshold)).toBe(1_000_000);
  });
});
