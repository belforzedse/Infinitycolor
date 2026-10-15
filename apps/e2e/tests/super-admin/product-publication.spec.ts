import { expect, test } from "@playwright/test";
import {
  cleanupRuntimeProducts,
  createRuntimeProductFixture,
  leaveRuntimeProductEditor,
  publishRuntimeProduct,
} from "../../helpers/admin";
import { apiGet, expectApiOk } from "../../helpers/api";
import { authStorageStatePath } from "../../helpers/auth";
import { prepareStorefrontPage } from "../../helpers/page";

type PublicationSnapshot = {
  Status?: "Active" | "InActive" | "Scheduled";
  scheduledPublishAt?: string | null;
  scheduledPublishRevision?: number;
};

async function readPublication(
  request: Parameters<typeof apiGet>[0],
  productId: number,
) {
  const response = await apiGet(request, "admin", `/products/${productId}`);
  await expectApiOk(
    response,
    `read publication state for product ${productId}`,
  );
  const payload = (await response.json()) as {
    data?: { attributes?: PublicationSnapshot } & PublicationSnapshot;
  };
  return payload.data?.attributes ?? payload.data ?? {};
}

test.describe("scheduled product publication", () => {
  test.use({ storageState: authStorageStatePath("admin") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Scheduled-publication editor coverage is desktop-only.",
    );
    await cleanupRuntimeProducts(request);
  });

  test.afterEach(async ({ page, request }) => {
    await leaveRuntimeProductEditor(page, request);
    await cleanupRuntimeProducts(request);
  });

  test("@smoke @admin schedules, reschedules, cancels, and publishes through the canonical state", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const runtime = await prepareStorefrontPage(page);
    const fixture = await createRuntimeProductFixture(request, {
      initialPublication: "InActive",
    });
    const firstPublishAt = new Date(Date.now() + 45 * 60_000).toISOString();

    const firstSchedule = await publishRuntimeProduct(
      request,
      fixture.productId,
      {
        action: "schedule",
        publishAt: firstPublishAt,
        timezone: "Asia/Tehran",
      },
    );
    await expectApiOk(firstSchedule, "schedule runtime product");
    const firstPayload = (await firstSchedule.json()) as {
      data?: {
        Status?: string;
        scheduledPublishAt?: string;
        scheduledPublishRevision?: number;
        queueState?: string;
      };
    };
    expect(firstPayload.data).toMatchObject({
      Status: "Scheduled",
      scheduledPublishAt: firstPublishAt,
    });
    expect(["queued", "pending-reconciliation"]).toContain(
      firstPayload.data?.queueState,
    );

    const secondPublishAt = new Date(Date.now() + 90 * 60_000).toISOString();
    const reschedule = await publishRuntimeProduct(
      request,
      fixture.productId,
      {
        action: "schedule",
        publishAt: secondPublishAt,
        timezone: "Asia/Tehran",
      },
    );
    await expectApiOk(reschedule, "reschedule runtime product");
    const reschedulePayload = (await reschedule.json()) as typeof firstPayload;
    expect(reschedulePayload.data?.scheduledPublishAt).toBe(secondPublishAt);
    expect(
      Number(reschedulePayload.data?.scheduledPublishRevision),
    ).toBeGreaterThan(Number(firstPayload.data?.scheduledPublishRevision));

    await page.goto(`/products/${fixture.productId}`, {
      waitUntil: "domcontentloaded",
    });
    const publicationCard = page
      .locator("section:visible")
      .filter({ hasText: "انتشار محصول" })
      .first();
    await expect(publicationCard).toContainText("زمان‌بندی شده", {
      timeout: 30_000,
    });
    await expect(publicationCard).toContainText("Asia/Tehran");
    await expect(publicationCard).toContainText("انتشار در:");
    await expect(
      publicationCard.getByRole("button", { name: "تغییر زمان" }),
    ).toBeVisible();

    await publicationCard
      .getByRole("button", { name: "لغو زمان‌بندی" })
      .click();
    await expect
      .poll(
        async () => (await readPublication(request, fixture.productId)).Status,
      )
      .toBe("InActive");
    await expect(publicationCard).toContainText("پیش‌نویس");

    // Leave the editor and prove its lease released before a separate fixture
    // editor instance prepares the next persisted schedule.
    await leaveRuntimeProductEditor(page, request);
    const scheduleAgain = await publishRuntimeProduct(
      request,
      fixture.productId,
      {
        action: "schedule",
        publishAt: secondPublishAt,
        timezone: "Asia/Tehran",
      },
    );
    await expectApiOk(
      scheduleAgain,
      "schedule runtime product after cancellation",
    );
    // Firefox can commit this Next.js navigation without reporting
    // domcontentloaded to Playwright. The card assertion below is the stronger
    // proof that the refreshed document hydrated with the persisted state.
    await page.goto(`/products/${fixture.productId}`, { waitUntil: "commit" });

    const refreshedCard = page
      .locator("section:visible")
      .filter({ hasText: "انتشار محصول" })
      .first();
    await expect(refreshedCard).toContainText("زمان‌بندی شده", {
      timeout: 30_000,
    });
    await refreshedCard.getByRole("button", { name: "انتشار فوری" }).click();
    await expect
      .poll(
        async () => (await readPublication(request, fixture.productId)).Status,
      )
      .toBe("Active");
    await expect(refreshedCard).toContainText("منتشر شده");
    runtime.assertClean();
  });
});
