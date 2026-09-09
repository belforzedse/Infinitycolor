import { expect, test } from "@playwright/test";
import { prepareStorefrontPage } from "../../helpers/page";

test.describe("blog post sidebar", () => {
  test("@smoke search, categories, TOC, and most-viewed follow the post layout", async ({
    page,
  }, testInfo) => {
    const runtime = await prepareStorefrontPage(page);
    const isMobile = testInfo.project.name.includes("mobile");

    await page.goto("/blog");
    const postLink = page.locator("article a[href^='/']").first();
    const hasPost = await postLink.isVisible().catch(() => false);
    test.skip(!hasPost, "No published blog posts available on /blog");
    await postLink.click();
    await expect(page).not.toHaveURL(/\/blog\/?$/);

    const search = page.getByTestId("blog-sidebar-search");
    await expect(search).toBeVisible();

    const categoriesSlot = page.getByTestId("blog-sidebar-categories-slot");
    if (isMobile) {
      await expect(categoriesSlot).toBeHidden();
    } else {
      await expect(page.getByTestId("blog-sidebar-categories")).toBeVisible();
      await expect(page.getByRole("link", { name: "همه" })).toBeVisible();
    }

    const toc = page.getByTestId("blog-sidebar-toc");
    if ((await toc.count()) > 0) {
      await expect(toc).toBeVisible();
      if (isMobile) {
        const searchBox = await search.boundingBox();
        const tocBox = await toc.boundingBox();
        expect(tocBox?.y ?? 0).toBeGreaterThan(searchBox?.y ?? 0);
      }
    }

    const popular = page.getByTestId("blog-sidebar-popular");
    if ((await popular.count()) > 0) {
      await expect(popular).toBeVisible();
      if (isMobile) {
        const comments = page.getByText("نظرات", { exact: false }).first();
        await comments.scrollIntoViewIfNeeded();
        const commentsBox = await comments.boundingBox();
        await popular.scrollIntoViewIfNeeded();
        const popularBox = await popular.boundingBox();
        expect(popularBox?.y ?? 0).toBeGreaterThan(commentsBox?.y ?? 0);
      } else {
        const tocBox = (await toc.count()) > 0 ? await toc.boundingBox() : null;
        const cats = page.getByTestId("blog-sidebar-categories");
        const anchor = tocBox ?? (await cats.boundingBox());
        const popularBox = await popular.boundingBox();
        expect(popularBox?.y ?? 0).toBeGreaterThan((anchor?.y ?? 0) + (anchor?.height ?? 0) - 8);
        expect(Math.abs((popularBox?.x ?? 0) - (anchor?.x ?? 0))).toBeLessThan(24);
      }
    }

    if (!isMobile && (await toc.count()) > 0) {
      await toc.getByRole("link").first().click();
      await expect(page).toHaveURL(/#/);
    }

    await search.getByRole("searchbox").fill("لباس");
    await search.getByRole("button", { name: /جستجو/ }).click();
    await expect(page).toHaveURL(/\/blog\?search=/);
    await expect(page.getByRole("heading", { name: /نتایج جستجو/ })).toBeVisible();

    runtime.assertClean();
  });
});
