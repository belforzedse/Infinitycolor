import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { findProductVariationBySku, resetCartToVariation } from "./api";
import { fillCheckoutWithZarinpal } from "./checkout";

export type FinalizedZarinpalPayment = {
  orderId: number;
  contractId?: number;
  refId: string;
  redirectUrl: string;
  variationId: number;
};

export async function routeZarinpalPlaceholder(page: Page) {
  await page.route(/https?:\/\/(?:www\.)?(?:sandbox\.)?zarinpal\.com\/.*/i, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html>
        <html lang="fa" dir="rtl">
          <head><title>Zarinpal E2E Placeholder</title></head>
          <body>
            <main data-testid="zarinpal-placeholder">
              <button type="button">پرداخت</button>
              <button type="button">انصراف</button>
            </main>
          </body>
        </html>`,
    });
  });
}

async function routeCheckoutGatewaysWithZarinpal(page: Page) {
  await page.route(/\/api\/payment-gateway\/available(?:\?.*)?$/i, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          gateways: [
            { code: "samankish", title: "Saman Kish" },
            { code: "mellat", title: "Mellat" },
            { code: "zarinpal", title: "Zarinpal" },
            { code: "wallet", title: "Wallet" },
          ],
        },
      }),
    });
  });
}

export async function finalizeToZarinpalRedirect(
  page: Page,
  request: APIRequestContext,
  options: {
    mockGateway?: boolean;
    onSubmitStarted?: () => Promise<void> | void;
  } = {},
): Promise<FinalizedZarinpalPayment> {
  if (options.mockGateway !== false) {
    await routeZarinpalPlaceholder(page);
    await routeCheckoutGatewaysWithZarinpal(page);
  }
  const variation = await findProductVariationBySku(request);
  await resetCartToVariation(request, variation.id, 1, "customer");

  await page.goto("/checkout", { waitUntil: "domcontentloaded" });
  await fillCheckoutWithZarinpal(page);

  const finalizeCapturePromise = new Promise<{
    ok: boolean;
    status: number;
    body: string;
    requestBody: string;
  }>((resolve, reject) => {
    page
      .route(
        /\/api\/carts\/finalize(?:\?.*)?$/i,
        async (route) => {
          try {
            const response = await route.fetch({ timeout: 60_000 });
            const body = await response.text();
            resolve({
              ok: response.ok(),
              status: response.status(),
              body,
              requestBody: route.request().postData() ?? "<empty>",
            });
            await route.fulfill({ response, body });
          } catch (error) {
            reject(error);
            await route.continue().catch(() => undefined);
          }
        },
        { times: 1 },
      )
      .catch(reject);
  });

  const submitPromise = page.getByTestId("checkout-submit").click();
  await options.onSubmitStarted?.();
  await submitPromise;
  const finalizeCapture = await finalizeCapturePromise;
  if (!finalizeCapture.ok) {
    expect(
      finalizeCapture.ok,
      `checkout finalize failed with ${finalizeCapture.status}: ${finalizeCapture.body} request=${finalizeCapture.requestBody}`,
    ).toBe(true);
  }
  const payload = JSON.parse(finalizeCapture.body) as {
    data?: {
      orderId?: number;
      contractId?: number;
      refId?: string;
      redirectUrl?: string;
    };
    orderId?: number;
    contractId?: number;
    refId?: string;
    redirectUrl?: string;
  };
  const body = payload.data ?? payload;
  await expect(page).toHaveURL(/zarinpal/i, { timeout: 45_000 });
  expect(body.orderId, "finalize response must include orderId").toBeTruthy();
  expect(body.refId, "finalize response must include refId").toBeTruthy();
  expect(body.redirectUrl, "finalize response must include redirectUrl").toContain("zarinpal");
  if (options.mockGateway !== false) {
    await expect(page.getByTestId("zarinpal-placeholder")).toBeVisible();
  }

  return {
    orderId: Number(body.orderId),
    contractId: body.contractId,
    refId: String(body.refId),
    redirectUrl: String(body.redirectUrl),
    variationId: variation.id,
  };
}

export async function stubSuccessfulCallback(page: Page, payment: FinalizedZarinpalPayment) {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, accept",
    "content-type": "application/json",
  };

  await page.route(/\/api\/carts\/me(?:\?.*)?$/i, async (route) => {
    if (route.request().method().toUpperCase() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({
        data: {
          id: 1,
          cart_items: [],
        },
      }),
    });
  });

  await page.route(/verify-payment/i, async (route) => {
    if (route.request().method().toUpperCase() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: "E2E verified",
        orderId: payment.orderId,
        orderNumber: `E2E-${payment.orderId}`,
        paymentStatus: "Started",
        transactionId: payment.refId,
      }),
    });
  });

  await page.route(
    new RegExp(`/api/orders/${payment.orderId}/payment-status`, "i"),
    async (route) => {
      if (route.request().method().toUpperCase() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          data: {
            success: true,
            orderId: payment.orderId,
            status: "Started",
            paymentStatus: "Succeeded",
            isPaid: true,
            transactionId: payment.refId,
            paymentGateway: "ZarinPal",
          },
        }),
      });
    },
  );
}
