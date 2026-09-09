import { expect, test, type Page } from "@playwright/test";
import { authCredentials } from "../../helpers/auth";
import { assertNonProductionTarget } from "../../helpers/admin";
import { prepareStorefrontPage } from "../../helpers/page";
import { adminBaseURL, centralAuthOrigin, storefrontBaseURL } from "../../helpers/env";

const SEEDED_CUSTOMER_PHONE = authCredentials("customer").phone;
const SEEDED_NATIONAL = SEEDED_CUSTOMER_PHONE.replace(/^\+98/, "");
const SEEDED_LOCAL = `0${SEEDED_NATIONAL}`;
const SEEDED_NAME = "E2E Customer";

function toPersianDigits(value: string) {
  return value.replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)] ?? digit);
}

async function signInAdmin(page: Page) {
  const credentials = authCredentials("admin");
  const response = await page.request.post(
    `${centralAuthOrigin().replace(/\/$/, "")}/api/auth/infinity/password/sign-in`,
    {
      headers: { Origin: new URL(storefrontBaseURL()).origin },
      data: credentials,
    },
  );
  expect(response.ok(), `admin sign-in failed: ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as { redirectTo?: string };
  expect(body.redirectTo).toContain("/auth/callback");

  await page.context().addCookies([
    {
      name: "infinity_route_hint",
      value: "1",
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
    {
      name: "infinity_admin_route_hint",
      value: "1",
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  await page.goto(body.redirectTo!, { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/auth(\/|$)/, { timeout: 20_000 });
}

async function searchWallets(page: Page, query: string, phoneDigits: string) {
  const input = page.getByTestId("wallet-customer-search");
  await input.fill(query);
  await page.getByRole("button", { name: "جستجو" }).click();
  const result = page
    .getByTestId("wallet-customer-result")
    .filter({ hasText: phoneDigits });
  await expect(result).toBeVisible({ timeout: 20_000 });
  return result;
}

test.describe("admin wallets customer search", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    void page;
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Wallet administration coverage is desktop-only.",
    );
    assertNonProductionTarget();
  });

  test("@admin finds the seeded customer by phone formats and shows the selection", async ({
    page,
  }) => {
    await prepareStorefrontPage(page);
    await signInAdmin(page);
    await page.goto(`${adminBaseURL().replace(/\/$/, "")}/wallets`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByRole("heading", { name: "مدیریت کیف پول کاربران" })).toBeVisible();

    for (const query of [
      SEEDED_LOCAL,
      SEEDED_NATIONAL,
      SEEDED_CUSTOMER_PHONE,
      `98${SEEDED_NATIONAL}`,
      toPersianDigits(SEEDED_LOCAL),
      SEEDED_NAME,
    ]) {
      const result = await searchWallets(page, query, SEEDED_NATIONAL);
      await expect(result).toContainText("E2E");
      await expect(result).toContainText("Customer");
    }

    const selectedResult = await searchWallets(page, SEEDED_LOCAL, SEEDED_NATIONAL);
    await selectedResult.click();

    await expect(page.getByTestId("wallet-selected-name")).toHaveText(SEEDED_NAME);
    await expect(page.getByTestId("wallet-selected-phone")).toContainText(SEEDED_NATIONAL);
    await expect(page.getByTestId("wallet-adjust-customer")).toContainText(SEEDED_NAME);
    await expect(selectedResult).toHaveAttribute("data-selected", "true");
  });

  test("@admin finds a seeded staff account and opens the wallet editor", async ({
    page,
  }) => {
    const founderPhone = authCredentials("founder").phone;
    const founderNational = founderPhone.replace(/^\+98/, "");
    await prepareStorefrontPage(page);
    await signInAdmin(page);
    await page.goto(`${adminBaseURL().replace(/\/$/, "")}/wallets`, {
      waitUntil: "domcontentloaded",
    });

    const result = await searchWallets(page, founderPhone, founderNational);
    await expect(result).toContainText("Founder");
    await result.click();

    await expect(page.getByTestId("wallet-selected-name")).toHaveText("E2E Founder");
    await expect(page.getByTestId("wallet-selected-phone")).toContainText(founderNational);
    await expect(page.getByTestId("wallet-adjust-customer")).toContainText("E2E Founder");
    await expect(page.getByRole("heading", { name: "کیف پول کاربر" })).toBeVisible();
  });
});
