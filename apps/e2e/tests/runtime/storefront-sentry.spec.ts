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

test("early guards restore missing microtask and settled-Promise APIs before hydration", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "queueMicrotask", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(Promise, "allSettled", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });
  await page.goto("/categories");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  const result = await page.evaluate(async () => {
    const order: number[] = [];
    queueMicrotask(() => order.push(1));
    const settled = await Promise.allSettled([
      Promise.resolve("first"),
      Promise.reject("second"),
    ]);
    order.push(2);
    return { order, settled };
  });
  expect(result).toEqual({
    order: [1, 2],
    settled: [
      { status: "fulfilled", value: "first" },
      { status: "rejected", reason: "second" },
    ],
  });
  expect(errors).toEqual([]);
});

for (const timing of ["before", "after"] as const) {
  test(`recovers exact injected window listeners ${timing} bootstrap with native cleanup`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const inject = () => {
      const previous = window.addEventListener;
      window.addEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (["popstate", "pageshow", "resize", "focus"].includes(type)) {
          const error = new TypeError(
            "Cannot read properties of null (reading 'tagName')",
          );
          error.stack =
            "TypeError\n at addEL_hook (<anonymous>:675:29)\n at top.addEventListener (<anonymous>:695:9)";
          throw error;
        }
        return previous.call(this, type, listener, options);
      };
    };
    if (timing === "before") await page.addInitScript(inject);
    await page.goto("/categories");
    await expect(page.locator("html")).toHaveAttribute(
      "data-app-ready",
      "true",
    );
    if (timing === "after") await page.evaluate(inject);
    const counts = await page.evaluate(() => {
      return ["popstate", "pageshow", "resize", "focus"].map((type) => {
        let count = 0;
        const listener = () => count++;
        window.addEventListener(type, listener, { capture: true });
        window.dispatchEvent(new Event(type));
        window.removeEventListener(type, listener, { capture: true });
        window.dispatchEvent(new Event(type));
        return count;
      });
    });
    expect(counts).toEqual([1, 1, 1, 1]);
    expect(errors).toEqual([]);
  });
}

test("repeated search, scroll, resize and visibility notifications do not exhaust React updates", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/plp");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await page.evaluate(() => {
    for (let iteration = 0; iteration < 100; iteration++) {
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  const input = page.getByRole("combobox").first();
  await input.focus();
  await input.fill("shirt");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  expect(
    errors.filter((message) => /maximum update|depth|hydration/i.test(message)),
  ).toEqual([]);
});
