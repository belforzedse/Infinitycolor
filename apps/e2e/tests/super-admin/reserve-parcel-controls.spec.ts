import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { assertNonProductionTarget } from "../../helpers/admin";
import { prepareStorefrontPage } from "../../helpers/page";

const key = "d765fd72-350a-4039-9096-e39f7c706bb2";
const barcode = "123456789012345678901234";
const name = "مریم رضایی";
const longName = "سید محمدرضا حسینی نیا و خانواده";

// Only parcel/order responses are synthetic. Authentication, the admin shell,
// fonts, toolbar, rows, cards and controls are the actual application.
for (const width of [1440, 390]) {
  test.describe(`reserve parcel controls at ${width}px`, () => {
    test.use({ storageState: authStorageStatePath("admin") });
    test("@smoke slim divider, full-parcel actions and reserve visibility", async ({
      page,
      context,
    }, testInfo) => {
      assertNonProductionTarget();
      await page.setViewportSize({ width, height: 1100 });
      const runtime = await prepareStorefrontPage(page);
      await context.addInitScript(() => {
        window.print = () => {};
      });
      let state: "new" | "pending" | "issued" = "new";
      let registrations = 0;
      const summary = (held = false) => ({
        groupKey: held ? "held-parcel" : key,
        orderCount: held ? 1 : 3,
        eligibleOrderCount: held ? 1 : 3,
        recipientName: held ? longName : name,
        shippingMethodCode: "post",
        isHeld: held,
        state:
          state === "new" ? null : state === "pending" ? "Pending" : "Issued",
        barcode: state === "issued" && !held ? barcode : null,
        submittedAt: state === "new" ? null : "2026-10-06T12:00:00.000Z",
        lastCheckedAt: null,
        issuedAt: state === "issued" ? "2026-10-06T12:10:00.000Z" : null,
        weight: 1250,
        boxSizeId: 4,
        registeredWeight: state === "new" ? null : 1250,
        registeredBoxSizeId: state === "new" ? null : 4,
        canSubmit: !held && state === "new",
        canCheck: !held && state === "pending",
        canPrintLabel: !held && state === "issued",
        blockedReason: held ? "در مهلت رزرو" : null,
        recipient: {
          name,
          phone: "09120000000",
          address: "تهران، خیابان نمونه، پلاک ۱۲",
          postalCode: "1234567890",
          city: "تهران",
          province: "تهران",
        },
      });
      const row = (id: number, reserve = false, held = false) => ({
        id: String(id),
        attributes: {
          Description: "",
          Note: "",
          Status: "Started",
          Date: "2026-10-06T12:00:00.000Z",
          createdAt: "2026-10-06T12:00:00.000Z",
          updatedAt: "2026-10-06T12:10:00.000Z",
          ShippingMethodCode: "post",
          ShippingBarcode:
            state === "issued" && reserve && !held ? barcode : null,
          recipientName: held ? longName : name,
          user: { data: { id: 700, attributes: { Phone: "09120000000" } } },
          contract: {
            data: {
              id: id + 1,
              attributes: { Amount: 425000, Status: "Confirmed" },
            },
          },
          reserveGroupId: reserve ? (held ? "held-parcel" : key) : null,
          reserveIsHeld: held,
          isReserveOrder: reserve,
          ...(reserve
            ? {
                reserveParcel: summary(held),
                AnipoBarcodeState: summary(held).state,
                AnipoSubmittedAt: summary(held).submittedAt,
              }
            : {}),
        },
      });
      await context.route(
        /\/admin\/orders-list\/query(?:\?|$)/,
        async (route) => {
          const input = route.request().postDataJSON();
          const filter = input.filters.find(
            (item: { field: string }) =>
              item.field === "[reserve_shipment][id]",
          );
          expect(filter?.operator).toMatch(/^\$(null|notNull)$/);
          const rows =
            filter.operator === "$notNull"
              ? [row(7001, true), row(7002, true), row(7003, true, true)]
              : [row(7000)];
          await route.fulfill({
            json: {
              data: rows,
              meta: {
                pagination: {
                  page: 1,
                  pageSize: 20,
                  total: rows.length,
                  pageCount: 1,
                },
              },
            },
          });
        },
      );
      await context.route(/\/admin\/orders-list\/counts(?:\?|$)/, (route) =>
        route.fulfill({
          json: {
            data: {
              counts: {
                all: 3,
                paying: 0,
                inprogress: 3,
                completed: 0,
                shipped: 0,
                cancelled: 0,
                manual: 0,
                anipo_attention: 0,
              },
              activeReserveGroups: 1,
            },
          },
        }),
      );
      await context.route(
        /\/admin\/orders-list\/shipping-methods(?:\?|$)/,
        (route) =>
          route.fulfill({
            json: {
              data: [
                { code: "post", title: "ارسال با پست" },
                { code: "pickup", title: "دریافت حضوری" },
              ],
            },
          }),
      );
      await context.route(
        new RegExp(
          `/orders/reserve-groups/${key}/anipo-barcode(?:/check)?(?:\\?|$)`,
        ),
        async (route) => {
          if (route.request().url().includes("/check")) state = "issued";
          else {
            expect(route.request().postDataJSON()).toMatchObject({
              weight: 1250,
              boxSizeId: 4,
            });
            registrations += 1;
            state = "pending";
          }
          await route.fulfill({
            status: state === "pending" ? 202 : 200,
            json: {
              pending: state === "pending",
              issued: state === "issued",
              state: state === "pending" ? "Pending" : "Issued",
              barcode: state === "issued" ? barcode : null,
            },
          });
        },
      );
      await context.route(
        new RegExp(`/admin/orders-list/reserve-groups/${key}(?:\\?|$)`),
        (route) =>
          route.fulfill({
            json: { data: { groupKey: key, anipo: summary() } },
          }),
      );

      await page.goto("/orders", { waitUntil: "domcontentloaded" });
      const reserveToggle = page.getByRole("checkbox", {
        name: "نمایش سفارش‌های رزروی",
      });
      await expect(reserveToggle).not.toBeChecked();
      await expect(
        page.locator(
          '[data-testid="admin-order-row"][data-order-id="7000"]:visible',
        ),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("admin-reserve-parcel")).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: testInfo.outputPath(`ordinary-orders-${width}.png`),
        fullPage: true,
      });

      await reserveToggle.check();
      const parcel = page.locator(
        `[data-testid="admin-reserve-parcel"][data-group-id="${key}"]:visible`,
      );
      await expect(parcel).toBeVisible();
      await expect(parcel.getByText("۲ از ۳ سفارش")).toBeVisible();
      await expect(parcel).not.toContainText(key);
      const expand = parcel.getByRole("button", {
        name: `نمایش سفارش‌های بسته ${name}`,
      });
      await expect(expand).toHaveAttribute("aria-expanded", "false");
      await parcel.getByRole("checkbox").check();
      await expect(expand).toHaveAttribute("aria-expanded", "false");
      await parcel.getByRole("checkbox").uncheck();
      await expand.click();
      await expect(
        page.locator(
          '[data-testid="admin-order-row"][data-order-id="7001"]:visible',
        ),
      ).toBeVisible();
      await expect(
        parcel.getByRole("link", { name: "چاپ فاکتور کل بسته" }),
      ).toHaveAttribute("href", `/orders/print/reserve/${key}`);
      await expect(
        page.getByRole("button", { name: "در مهلت رزرو", exact: true }).first(),
      ).toBeDisabled();
      await page.screenshot({
        path: testInfo.outputPath(`reserve-orders-expanded-${width}.png`),
        fullPage: true,
      });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);

      await parcel
        .getByRole("button", { name: "ثبت در آنیپو", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.locator('input[type="number"]')).toHaveValue("1250");
      await expect(dialog.locator("select")).toHaveValue("4");
      await dialog
        .getByRole("button", { name: "ثبت در آنیپو", exact: true })
        .click();
      await expect(dialog).toBeHidden();
      await parcel
        .getByRole("button", { name: "بررسی آنیپو", exact: true })
        .click();
      await expect(
        parcel.getByRole("button", { name: "بارکد صادر شده", exact: true }),
      ).toBeVisible();
      expect(registrations).toBe(1);
      await parcel
        .getByRole("button", { name: "عملیات بسته", exact: true })
        .click();
      await expect(
        page.getByRole("menuitem", { name: "رهگیری بسته" }),
      ).toBeVisible();
      const popupReady = context.waitForEvent("page");
      await page.getByRole("menuitem", { name: "چاپ برچسب پستی" }).click();
      const label = await popupReady;
      await expect(label.getByTestId("anipo-shipping-label")).toBeVisible();
      await expect(label.locator('svg[data-format="CODE128B"]')).toBeVisible();
      await expect(label.getByTestId("anipo-shipping-label")).toContainText(
        name,
      );
      await expect(label.getByTestId("anipo-shipping-label")).toContainText(
        barcode,
      );
      await label.evaluate(() => document.fonts.ready);
      await label.screenshot({
        path: testInfo.outputPath(`parcel-label-${width}.png`),
        fullPage: true,
      });
      await label.close();
      await reserveToggle.uncheck();
      await expect(page.getByTestId("admin-reserve-parcel")).toHaveCount(0);
      await expect(
        page.locator(
          '[data-testid="admin-order-row"][data-order-id="7000"]:visible',
        ),
      ).toBeVisible();
      runtime.assertClean();
    });
  });
}
