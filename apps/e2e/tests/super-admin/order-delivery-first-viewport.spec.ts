import { expect, test, type Route } from "@playwright/test";
import { adminBaseURL } from "../../helpers/env";

const ORDER_ID = 919191;
const ADDRESS = {
  fullName: "نگار رضایی",
  phone: "09121234567",
  province: "تهران",
  city: "تهران",
  address: "خیابان ولیعصر، کوچه آزمایش، پلاک ۱۲",
  postalCode: "1234567890",
};

test("@admin @mock delivery address is visible first, keeps phone LTR, and copies recipient data", async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "The first-viewport contract is exercised on desktop.",
  );
  test.skip(
    testInfo.project.name.includes("firefox") ||
      testInfo.project.name.includes("webkit"),
    "Clipboard API proof runs in Chromium.",
  );

  const context = await browser.newContext({
    baseURL: adminBaseURL(),
    locale: "fa-IR",
    serviceWorkers: "block",
  });
  await context.addCookies([
    {
      name: "infinity_admin_route_hint",
      value: "1",
      url: adminBaseURL(),
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = value;
        },
      },
    });
  });

  try {
    await context.route("**/api/**", async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(
        /^\/api\/(?:backend\/)?/,
        "/",
      );
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (request.method() === "OPTIONS") return json({});
      if (path === "/auth/token") {
        const payload = Buffer.from(
          JSON.stringify({ sub: "101", exp: Math.floor(Date.now() / 1000) + 7200 }),
        ).toString("base64url");
        return json({ token: `mock.${payload}.mock` });
      }
      if (path === "/users/me" || path === "/auth/self")
        return json({
          data: {
            id: 101,
            isAdmin: true,
            adminRole: "store_manager",
            FirstName: "نگار",
            LastName: "رضایی",
            capabilities: [
              "order.read",
              "order.address.update",
              "order.status.update",
              "order.cancel",
            ],
          },
        });
      if (path === `/orders/${ORDER_ID}`)
        return json({
          data: {
            id: ORDER_ID,
            attributes: {
              Status: "Started",
              Date: "2026-10-13T08:00:00.000Z",
              createdAt: "2026-10-13T08:00:00.000Z",
              ShippingCost: 0,
              order_items: { data: [] },
              user: {
                data: {
                  id: 303,
                  attributes: {
                    Phone: ADDRESS.phone,
                    user_info: {
                      data: {
                        attributes: {
                          FirstName: "مشتری",
                          LastName: "آزمایشی",
                        },
                      },
                    },
                  },
                },
              },
              delivery_address: {
                data: {
                  id: 404,
                  attributes: {
                    FullName: ADDRESS.fullName,
                    Phone: ADDRESS.phone,
                    FullAddress: ADDRESS.address,
                    PostalCode: ADDRESS.postalCode,
                    shipping_city: {
                      data: {
                        id: 505,
                        attributes: {
                          Title: ADDRESS.city,
                          shipping_province: {
                            data: {
                              id: 606,
                              attributes: { Title: ADDRESS.province },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              contract: { data: null },
              shipping: { data: null },
            },
          },
        });
      return json({ data: [], meta: { pagination: { total: 0 } } });
    });

    const page = await context.newPage();
    await page.goto(`/orders/edit/${ORDER_ID}`);

    const delivery = page.getByRole("region", { name: "آدرس ارسال" });
    await expect(delivery).toBeVisible();
    const box = await delivery.boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(box?.y).toBeLessThan(viewportHeight);
    await expect(delivery).toContainText(ADDRESS.fullName);
    await expect(delivery).toContainText(ADDRESS.city);
    await expect(delivery).toContainText(ADDRESS.province);
    await expect(delivery).toContainText(ADDRESS.address);

    const phone = delivery.locator("bdi").filter({ hasText: ADDRESS.phone });
    await expect(phone).toHaveAttribute("dir", "ltr");
    await delivery.getByRole("button", { name: "کپی آدرس" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { __copiedText?: string }).__copiedText,
        ),
      )
      .toBe(
        `${ADDRESS.fullName}\n${ADDRESS.phone}\n${ADDRESS.province}، ${ADDRESS.city}\n${ADDRESS.address}\nکد پستی: ${ADDRESS.postalCode}`,
      );
  } finally {
    await context.close();
  }
});
