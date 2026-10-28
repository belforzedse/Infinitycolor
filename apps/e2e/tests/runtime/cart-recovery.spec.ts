import { expect, test, type Page } from "@playwright/test";

async function watchHydration(page: Page, lowQuality: boolean) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/hydration|did not match/i.test(message.text()))
      errors.push(message.text());
  });
  await page.addInitScript((low) => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      get: () => (low ? 2 : 16),
    });
    Object.defineProperty(navigator, "deviceMemory", {
      get: () => (low ? 2 : 16),
    });
    localStorage.setItem("pdp_debug", "0");
    localStorage.setItem("pwa-prompt-dismissed-permanently", "true");
  }, lowQuality);
  if (lowQuality) await page.emulateMedia({ reducedMotion: "reduce" });
  return errors;
}

async function stubSessionCheck(page: Page, shouldFail: () => boolean) {
  await page.route("http://localhost:2889/api/auth/token", (route) =>
    route.fulfill({
      status: shouldFail() ? 503 : 401,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "http://127.0.0.1:4330",
        "Access-Control-Allow-Credentials": "true",
      },
      body: JSON.stringify({ message: "fixture" }),
    }),
  );
}

async function openProduct(page: Page, lowQuality: boolean) {
  await page.goto("/pdp/cart-recovery-fixture");
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__INFINITY_AQ_E2E__)))
    .toBe(true);
  await page.evaluate(
    (low) =>
      window.__INFINITY_AQ_E2E__?.setTier(
        low
          ? { rendering: "safe", media: "economy", motion: "minimal" }
          : { rendering: "enhanced", media: "high", motion: "enhanced" },
      ),
    lowQuality,
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-aq-rendering",
    lowQuality ? "safe" : "enhanced",
  );
}

for (const lowQuality of [false, true]) {
  test(`account cart waits for identity recovery before making one add request (${lowQuality ? "safe" : "normal"})`, async ({
    page,
  }) => {
    const errors = await watchHydration(page, lowQuality);
    let unavailable = true;
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = `fixture.${Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + 60 })).toString("base64url")}.fixture`;
    const headers = {
      "Access-Control-Allow-Origin": "http://127.0.0.1:4330",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "authorization, content-type",
    };
    await page.route("http://localhost:2889/api/auth/token", (route) =>
      route.fulfill({
        status: unavailable ? 503 : 200,
        contentType: "application/json",
        headers,
        body: JSON.stringify(unavailable ? {} : { token }),
      }),
    );
    const additions: unknown[] = [];
    await page.route("http://127.0.0.1:4341/api/carts/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/add-item"))
        additions.push(route.request().postDataJSON());
      const cartItems = additions.length
        ? [
            {
              id: 900006,
              Count: 1,
              Sum: 100000,
              availableStock: 3,
              product_variation: {
                id: 900003,
                Price: 100000,
                product_variation_size: { id: 900005, Title: "L" },
                product: {
                  id: 900001,
                  Title: "محصول آزمایشی سبد خرید",
                  Slug: "cart-recovery-fixture",
                },
              },
            },
          ]
        : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers,
        body: JSON.stringify({
          data: path.endsWith("/me")
            ? { cart_items: cartItems }
            : { valid: true },
        }),
      });
    });
    await openProduct(page, lowQuality);
    const add = page.getByTestId("pdp-add-to-cart");
    await expect(
      page.getByTestId("pdp-cart-action").getByRole("alert"),
    ).toContainText("اتصال به سبد خرید برقرار نشد.");
    await expect(add).toBeDisabled();
    expect(additions).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("cart"))).toBeNull();
    unavailable = false;
    await expect(add).toBeEnabled({ timeout: 15_000 });
    await add.click();
    await expect(page.getByTestId("cart-drawer")).toContainText(
      "محصول آزمایشی سبد خرید",
    );
    await expect
      .poll(() => additions)
      .toEqual([{ productVariationId: 900003, count: 1 }]);
    expect(await page.evaluate(() => localStorage.getItem("cart"))).toBeNull();
    expect(errors).toEqual([]);
  });

  test(`stocked PDP recovers automatically after a failed session check (${lowQuality ? "safe" : "normal"})`, async ({
    page,
  }) => {
    const errors = await watchHydration(page, lowQuality);
    let unavailable = true;
    await stubSessionCheck(page, () => unavailable);
    await openProduct(page, lowQuality);
    const add = page.getByTestId("pdp-add-to-cart");
    await expect(
      page.getByTestId("pdp-cart-action").getByRole("alert"),
    ).toContainText("اتصال به سبد خرید برقرار نشد.");
    await expect(add).toBeDisabled();
    unavailable = false;
    await expect(add).toBeEnabled({ timeout: 15_000 });
    await add.click();
    await expect(page.getByTestId("cart-drawer")).toContainText(
      "محصول آزمایشی سبد خرید",
    );
    const cart = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("cart") || "[]"),
    );
    expect(cart).toMatchObject([
      { productId: "900001", variationId: "900003", size: "L", quantity: 1 },
    ]);
    expect(errors).toEqual([]);
  });

  test(`stocked PDP exposes manual recovery during a persistent session failure (${lowQuality ? "safe" : "normal"})`, async ({
    page,
  }) => {
    const errors = await watchHydration(page, lowQuality);
    let unavailable = true;
    await stubSessionCheck(page, () => unavailable);
    await openProduct(page, lowQuality);
    const add = page.getByTestId("pdp-add-to-cart");
    await expect(add).toBeDisabled();
    await expect(
      page.getByTestId("pdp-cart-action").getByRole("alert"),
    ).toContainText("اتصال به سبد خرید برقرار نشد.");
    expect(await page.evaluate(() => localStorage.getItem("cart"))).toBeNull();
    unavailable = false;
    await page
      .getByRole("button", { name: "تلاش دوباره", exact: true })
      .click();
    await expect(add).toBeEnabled();
    await expect(
      page.getByTestId("pdp-cart-action").getByRole("alert"),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
