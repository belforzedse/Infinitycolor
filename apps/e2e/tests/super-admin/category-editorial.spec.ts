import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  expectApiForbidden,
  expectApiOk,
} from "../../helpers/api";
import { authStorageStatePath } from "../../helpers/auth";
import { storefrontBaseURL, strapiApiURL } from "../../helpers/env";

type CategoryResponse = {
  data?: { id?: number };
};

const adminPath = "/blog/category-editorial";

async function createCategory(
  request: APIRequestContext,
  title: string,
  slug: string,
) {
  const response = await apiPost(request, "admin", "/product-categories", {
    data: { Title: title, Slug: slug },
  });
  await expectApiOk(response, `create category ${slug}`);
  const payload = (await response.json()) as CategoryResponse;
  const id = Number(payload.data?.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`create category ${slug} omitted its numeric ID`);
  }
  return id;
}

async function selectCategory(page: Page, title: string) {
  await page.getByLabel("جست‌وجوی دسته").fill(title);
  const target = page.getByRole("button").filter({ hasText: title }).first();
  await expect(target).toBeVisible({ timeout: 30_000 });
  await target.click();
  await expect(
    page.getByRole("heading", { level: 1, name: title }),
  ).toBeVisible();
}

test.describe("category editorial", () => {
  test.use({ storageState: authStorageStatePath("editor") });

  test("@smoke @admin Editor manages scoped editorial content and storefront renders only the canonical category", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("mobile"),
      "The admin smoke configuration exercises desktop browser engines; mobile behavior is asserted explicitly.",
    );
    // About ten page loads against the dev storefront: WebKit in CI needs
    // ~62 s, so the default 60 s ran out in the final unpublish (pipeline 1118).
    test.setTimeout(120_000);

    const project = testInfo.project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const suffix = `${project}-${testInfo.retry}-${Date.now()}`;
    const categoryATitle = `E2E_DO_NOT_USE_ Editorial A ${suffix}`;
    const categoryBTitle = `E2E_DO_NOT_USE_ Editorial B ${suffix}`;
    const categoryASlug = `e2e-do-not-use-editorial-a-${suffix}`;
    const categoryBSlug = `e2e-do-not-use-editorial-b-${suffix}`;
    const heading = `راهنمای انتخاب ${suffix}`;
    const editedHeading = `راهنمای کامل ${suffix}`;
    const introduction = "مقدمه‌ای برای بررسی نمایش محتوای دسته در فروشگاه.";
    const bodyText = "راهنمای خرید و انتخاب محصول ".repeat(60);

    const createdCategoryIds: number[] = [];
    try {
      const categoryAId = await createCategory(
        request,
        categoryATitle,
        categoryASlug,
      );
      createdCategoryIds.push(categoryAId);
      const categoryBId = await createCategory(
        request,
        categoryBTitle,
        categoryBSlug,
      );
      createdCategoryIds.push(categoryBId);

      await expectApiForbidden(
        await apiGet(request, "seller-1", "/category-editorial/targets"),
      );
      await expectApiForbidden(
        await apiPut(
          request,
          "customer",
          `/category-editorial/${categoryAId}`,
          {
            data: {
              Title: "نباید ذخیره شود",
              Paragraph: "متن غیرمجاز",
              Content: "",
              IsPublished: true,
              IsRTL: true,
            },
            expectedUpdatedAt: null,
          },
        ),
      );

      await page.goto(adminPath, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`${adminPath}$`));
      await selectCategory(page, categoryATitle);

      await page.getByLabel("عنوان بخش").fill(heading);
      await page.getByLabel("مقدمه").fill(introduction);
      const editor = page.locator(".ProseMirror");
      await editor.click();
      await page.getByTitle("عنوان 3").click();
      await page.keyboard.insertText("نکات مهم انتخاب");
      await page.keyboard.press("Enter");
      await page.keyboard.insertText(bodyText);
      await page.keyboard.press("Enter");
      await page.getByTitle("افزودن لینک").click();
      await page
        .getByPlaceholder("https://example.com")
        .fill(`/plp/category/${categoryBSlug}`);
      await page.getByPlaceholder("متن لینک").fill("مشاهده دسته دیگر");
      await page.getByRole("button", { name: "ثبت لینک" }).click();
      await page.getByLabel("نمایش در فروشگاه").check();
      await page.waitForTimeout(400);
      const createResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().includes(`/category-editorial/${categoryAId}`),
      );
      await page.getByRole("button", { name: "ذخیره" }).click();
      expect((await createResponse).ok()).toBe(true);
      await expect(page.getByText("تغییرات ذخیره نشده است.")).toHaveCount(0);

      await page.getByLabel("عنوان بخش").fill(editedHeading);
      const editResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().includes(`/category-editorial/${categoryAId}`),
      );
      await page.getByRole("button", { name: "ذخیره" }).click();
      expect((await editResponse).ok()).toBe(true);

      const publicResponse = await request.get(
        `${strapiApiURL()}/category-editorial/public/${encodeURIComponent(categoryASlug)}`,
      );
      await expectApiOk(publicResponse, "read public category editorial");
      const publicPayload = (await publicResponse.json()) as {
        data?: { title?: string; content?: string } | null;
      };
      expect(publicPayload.data?.title).toBe(editedHeading);
      expect(publicPayload.data?.content).toContain(
        `href="/plp/category/${categoryBSlug}"`,
      );

      const categoryAUrl = `${storefrontBaseURL()}/plp/category/${categoryASlug}`;
      const categoryBUrl = `${storefrontBaseURL()}/plp/category/${categoryBSlug}`;
      const htmlResponse = await request.get(categoryAUrl);
      await expectApiOk(
        htmlResponse,
        "render category editorial on the server",
      );
      const html = await htmlResponse.text();
      expect(html).toContain(editedHeading);
      expect((html.match(/<h1\b/g) ?? []).length).toBe(1);

      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(categoryAUrl, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(
        page.getByRole("heading", { level: 2, name: editedHeading }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 3, name: "نکات مهم انتخاب" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "مشاهده دسته دیگر" }),
      ).toHaveAttribute("href", `/plp/category/${categoryBSlug}`);

      await page.goto(categoryBUrl, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(editedHeading)).toHaveCount(0);

      for (const query of ["?page=2", "?sort=price-desc", "?search=محصول"]) {
        await page.goto(`${categoryAUrl}${query}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(page.getByText(editedHeading)).toHaveCount(0);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(categoryAUrl, { waitUntil: "domcontentloaded" });
      const disclosure = page.getByTestId("category-editorial-disclosure");
      await expect(disclosure).toBeVisible();
      const disclosureButton = disclosure.getByRole("button", {
        name: "ادامه مطلب",
      });
      await expect(disclosureButton).toHaveAttribute("aria-expanded", "false");
      await expect(async () => {
        await disclosureButton.click();
        await expect(
          disclosure.getByRole("button", { name: "بستن متن" }),
        ).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
      await expect(
        page.getByRole("link", { name: "مشاهده دسته دیگر" }),
      ).toBeVisible();

      await page.goto(adminPath, { waitUntil: "domcontentloaded" });
      await selectCategory(page, categoryATitle);
      await page.getByLabel("نمایش در فروشگاه").uncheck();
      const unpublishResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().includes(`/category-editorial/${categoryAId}`),
      );
      await page.getByRole("button", { name: "ذخیره" }).click();
      expect((await unpublishResponse).ok()).toBe(true);

      await expect
        .poll(async () => {
          const response = await request.get(
            `${strapiApiURL()}/category-editorial/public/${encodeURIComponent(categoryASlug)}`,
          );
          const payload = (await response.json()) as { data?: unknown };
          return payload.data ?? null;
        })
        .toBeNull();
      await page.goto(categoryAUrl, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(editedHeading)).toHaveCount(0);
    } finally {
      for (const categoryId of createdCategoryIds.reverse()) {
        const response = await apiDelete(
          request,
          "admin",
          `/product-categories/${categoryId}`,
        );
        await expectApiOk(response, `delete category fixture ${categoryId}`);
      }
    }
  });
});
