import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  assertNonProductionTarget,
  cleanupRuntimeStories,
  createRuntimeStory,
} from "../../helpers/admin";
import {
  apiGet,
  apiPost,
  expectApiForbidden,
  expectApiOk,
} from "../../helpers/api";
import { prepareStorefrontPage } from "../../helpers/page";

test.describe("seller-2 stories CRUD", () => {
  test.use({ storageState: authStorageStatePath("seller-2") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin CRUD coverage is desktop-only.",
    );
    assertNonProductionTarget();
    await cleanupRuntimeStories(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeStories(request);
  });

  test("@admin @permissions Seller 2 can list, edit, publish, and delete a story", async ({
    page,
    request,
  }) => {
    await prepareStorefrontPage(page);
    const story = await createRuntimeStory(request, "seller-2");

    await page.goto("/stories", { waitUntil: "domcontentloaded" });
    const row = page
      .locator(
        `[data-testid="admin-story-row"][data-id="${story.storyId}"]:visible`,
      )
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(story.title);

    await page
      .locator(
        `[data-testid="admin-story-edit"][data-id="${story.storyId}"]:visible`,
      )
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/stories/${story.storyId}/edit$`),
      { timeout: 30_000 },
    );

    await page.goto("/stories", { waitUntil: "domcontentloaded" });
    await expect(row).toBeVisible({ timeout: 30_000 });

    await page
      .locator(
        `[data-testid="admin-story-toggle"][data-id="${story.storyId}"]:visible`,
      )
      .first()
      .click();

    await expect
      .poll(async () => {
        const response = await apiGet(request, "seller-2", `/stories/${story.storyId}`);
        await expectApiOk(response, "read toggled story");
        const payload = (await response.json()) as {
          data?: { IsActive?: boolean; attributes?: { IsActive?: boolean } };
        };
        return payload.data?.IsActive ?? payload.data?.attributes?.IsActive ?? false;
      })
      .toBe(true);

    page.once("dialog", (dialog) => {
      void dialog.accept();
    });
    await page
      .locator(
        `[data-testid="admin-story-delete"][data-id="${story.storyId}"]:visible`,
      )
      .first()
      .click();

    await expect
      .poll(async () => {
        const response = await apiGet(request, "admin", `/stories/${story.storyId}`);
        return response.status();
      })
      .toBe(404);
  });
});

test.describe("seller-1 cannot manage stories", () => {
  test.use({ storageState: authStorageStatePath("seller-1") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Super-admin CRUD coverage is desktop-only.",
    );
    assertNonProductionTarget();
    await cleanupRuntimeStories(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeStories(request);
  });

  test("@admin @permissions Seller 1 is forbidden from stories API and UI", async ({
    page,
    request,
  }) => {
    const createAttempt = await apiPost(request, "seller-1", "/stories", {
      data: {
        Title: "Seller 1 should not create this",
        MediaType: "image",
      },
    });
    await expectApiForbidden(createAttempt);

    const seeded = await createRuntimeStory(request, "seller-2");
    const unpublished = await apiGet(
      request,
      "seller-1",
      `/stories/${seeded.storyId}`,
    );
    expect(unpublished.status()).toBe(404);

    await prepareStorefrontPage(page);
    await page.goto("/stories", { waitUntil: "domcontentloaded" });
    const forbiddenAlert = page
      .locator('section[role="alert"]')
      .filter({ hasText: "اجازه مشاهده این بخش را ندارید" });
    await expect(forbiddenAlert).toContainText("اجازه مشاهده این بخش را ندارید", {
      timeout: 30_000,
    });
  });
});
