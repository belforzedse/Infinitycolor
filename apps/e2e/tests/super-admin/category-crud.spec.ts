import { expect, type Page, test } from "@playwright/test";
import {
  E2E_ADMIN_CATEGORY_SLUG,
  E2E_ADMIN_CATEGORY_TITLE,
  E2E_ADMIN_CATEGORY_UPDATED_SLUG,
  E2E_ADMIN_CATEGORY_UPDATED_TITLE,
  E2E_CATEGORY_TITLE,
} from "../../fixtures/storefront";
import { authStorageStatePath } from "../../helpers/auth";

const categoriesPath = "/products/categories";
const addCategoryPath = `${categoriesPath}/add`;
const expandedCategoriesPath = `${categoriesPath}?pageSize=100`;
const categoriesURLPattern = new RegExp(`${categoriesPath}(?:\\?.*)?$`);

function categoryCard(page: Page, slug: string) {
  return page.locator(`[data-testid="admin-category-card"][data-category-slug="${slug}"]`).first();
}

function visibleCategoryCard(page: Page, slug: string) {
  return page
    .locator(`[data-testid="admin-category-card"][data-category-slug="${slug}"]:visible`)
    .first();
}

function visibleAddCategoryLink(page: Page) {
  return page.locator(`a[data-testid="super-admin-add-link"][href="${addCategoryPath}"]:visible`).first();
}

async function fillCategoryForm(page: Page, title: string, slug: string) {
  await page.locator('[data-testid="admin-field-Title"]:visible').first().fill(title);
  await page.locator('[data-testid="admin-field-Slug"]:visible').first().fill(slug);
  await page.locator('[data-testid="admin-category-save"]:visible').first().click();
}

async function gotoExpandedCategoriesList(page: Page) {
  await page.goto(expandedCategoriesPath, { waitUntil: "domcontentloaded" });
  await expect(visibleAddCategoryLink(page)).toBeVisible({ timeout: 30_000 });
}

async function waitForCategoriesListNavigation(page: Page) {
  await expect(page).toHaveURL(categoriesURLPattern);
  await page.waitForLoadState("domcontentloaded");
}

test.describe("super-admin category CRUD smoke", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test("@smoke @admin super-admin can create, edit, and delete a product category", async ({ page }) => {
    test.skip(
      test.info().project.name.includes("mobile"),
      "Super-admin CRUD smoke is desktop-only in Phase 1.5",
    );

    const testInfo = test.info();
    const projectSlug = testInfo.project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const fixtureSuffix = `${projectSlug}-${testInfo.retry}`;
    const categoryTitle = `${E2E_ADMIN_CATEGORY_TITLE} ${fixtureSuffix}`;
    const categorySlug = `${E2E_ADMIN_CATEGORY_SLUG}-${fixtureSuffix}`;
    const updatedCategoryTitle = `${E2E_ADMIN_CATEGORY_UPDATED_TITLE} ${fixtureSuffix}`;
    const updatedCategorySlug = `${E2E_ADMIN_CATEGORY_UPDATED_SLUG}-${fixtureSuffix}`;

    await page.goto(categoriesPath, { waitUntil: "domcontentloaded" });
    await expect(visibleAddCategoryLink(page)).toBeVisible({ timeout: 30_000 });

    await page.goto(addCategoryPath, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`${addCategoryPath}$`));
    await fillCategoryForm(page, categoryTitle, categorySlug);

    await waitForCategoriesListNavigation(page);
    await gotoExpandedCategoriesList(page);
    const createdCard = visibleCategoryCard(page, categorySlug);
    await expect(createdCard).toBeVisible({ timeout: 30_000 });

    await createdCard.getByTestId("admin-category-edit").click();
    await expect(page).toHaveURL(/\/products\/categories\/edit\/\d+$/);
    await fillCategoryForm(page, updatedCategoryTitle, updatedCategorySlug);

    await waitForCategoriesListNavigation(page);
    await gotoExpandedCategoriesList(page);
    const updatedCard = visibleCategoryCard(page, updatedCategorySlug);
    await expect(updatedCard).toBeVisible({ timeout: 30_000 });
    await expect(updatedCard).toHaveAttribute(
      "data-category-title",
      updatedCategoryTitle,
    );

    await updatedCard.getByTestId("admin-category-delete").click();
    const targetSelect = page.locator("#delete-category-target:visible").first();
    await expect(targetSelect).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () =>
        (await targetSelect.locator("option").allTextContents()).some((text) =>
          text.includes(E2E_CATEGORY_TITLE),
        ),
      )
      .toBe(true);
    await targetSelect.selectOption({ label: E2E_CATEGORY_TITLE });
    await page.locator('[data-testid="delete-category-confirm"]:visible:enabled').first().click();

    await expect(updatedCard).toHaveCount(0, { timeout: 30_000 });
    await expect(categoryCard(page, updatedCategorySlug)).toHaveCount(0);
  });
});
