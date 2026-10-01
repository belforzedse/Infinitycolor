import { expect, test } from "@playwright/test";

test("production hydration survives legacy media-query listener APIs", async ({
  page,
}) => {
  const errors: string[] = [];
  await page.route("http://localhost:2889/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: null, session: null }),
      headers: {
        "Access-Control-Allow-Origin": new URL(page.url()).origin,
        "Access-Control-Allow-Credentials": "true",
      },
    }),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      /hydration|did not match|addEventListener is not a function/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  // Remove the modern API before the early guard and dependency bundles execute.
  await page.addInitScript(() => {
    const query = window.matchMedia("all");
    const proto = Object.getPrototypeOf(query);
    Object.defineProperty(proto, "addEventListener", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(proto, "removeEventListener", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });
  await page.goto("/categories");
  await expect(
    page.getByRole("heading", { name: "دسته‌بندی‌های اینفینیتی" }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  expect(
    await page.evaluate(() => typeof window.matchMedia("all").addEventListener),
  ).toBe("function");
  expect(errors).toEqual([]);
});

test("serves separate canonical and retirement workers with JavaScript and no-cache headers", async ({
  request,
}) => {
  for (const path of ["/sw.js", "/sw-retire.js"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/javascript/);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const text = await response.text();
    expect(text).toContain(
      path === "/sw.js" ? "RUNTIME_CACHE" : "self.registration.unregister",
    );
  }
});
