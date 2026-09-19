import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { strapiOrigin } from "./env";
import { routeZarinpalPlaceholder } from "./payment";

/**
 * Helpers for the two wallet money paths: adding credit, and spending part of
 * it on an order.
 *
 * Everything here drives the *server's* callback route rather than stubbing a
 * verification response in the browser. Wallet money moves entirely server-side
 * — the ledger row, the hold capture, the balance — so a `page.route` stub of
 * the verify call would assert nothing about whether the money actually moved.
 * That is why these depend on ZarinPal's deterministic mode
 * (`ZARINPAL_E2E_DETERMINISTIC`), which answers verification for an `E2E-`
 * authority it minted itself, for exactly the amount it minted it for.
 */

/** The authority ZarinPal minted, as carried on the redirect it handed back. */
export function authorityFromRedirect(redirectUrl: string): string {
  const direct = /\/(?:StartPay|pay)\/([^/?#]+)/i.exec(redirectUrl);
  if (direct?.[1]) return decodeURIComponent(direct[1]);
  const queried = new URL(redirectUrl).searchParams.get("Authority");
  expect(queried, `no authority in redirect ${redirectUrl}`).toBeTruthy();
  return String(queried);
}

/**
 * Hand the provider's answer to the server, the way a returning browser does.
 *
 * `request` rather than `page`, so the assertion is about what the server did
 * with it and not about what a redirect chain rendered. Redirects are not
 * followed: the response is the store's own redirect back to the storefront.
 */
export async function deliverProviderCallback(
  request: APIRequestContext,
  path: "/api/wallet/payment-callback" | "/api/orders/payment-callback",
  params: Record<string, string>,
) {
  const url = new URL(`${strapiOrigin()}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return request.get(url.toString(), { maxRedirects: 0 });
}

/** Start a top-up from the wallet page and follow it to the provider. */
export async function startTopupFromWalletPage(
  page: Page,
  amountToman: number,
): Promise<{ redirectUrl: string; saleOrderId: string; authority: string }> {
  await routeZarinpalPlaceholder(page);
  await page.goto("/wallet", { waitUntil: "domcontentloaded" });

  const topup = page.locator("[data-wallet-topup]");
  await expect(topup, "the wallet page should offer a top-up").toBeVisible({ timeout: 30_000 });

  const amountField = page.getByTestId("wallet-topup-amount");
  await amountField.fill(String(amountToman));

  const startPromise = page.waitForResponse(
    (response) =>
      /\/api\/wallet\/charge-intent(?:\?.*)?$/i.test(response.url()) &&
      response.request().method() === "POST",
    { timeout: 45_000 },
  );
  await page.getByTestId("wallet-topup-submit").click();
  const started = await startPromise;
  expect(
    started.ok(),
    `charge-intent failed with ${started.status()}: ${await started.text()}`,
  ).toBe(true);

  const payload = (await started.json()) as {
    data?: { redirectUrl?: string; saleOrderId?: string };
    redirectUrl?: string;
    saleOrderId?: string;
  };
  const body = payload.data ?? payload;
  expect(body.redirectUrl, "charge-intent must return a redirect").toBeTruthy();
  expect(body.saleOrderId, "charge-intent must return its own reference").toBeTruthy();

  return {
    redirectUrl: String(body.redirectUrl),
    saleOrderId: String(body.saleOrderId),
    authority: authorityFromRedirect(String(body.redirectUrl)),
  };
}

/**
 * Tick the wallet tender at checkout and report the split it produces.
 *
 * The card is all-or-nothing: ticking it spends as much of this order as the
 * shopper's spendable credit covers. It only appears when the server reports
 * the wallet as available, so a missing card is a real failure rather than
 * something to skip past.
 */
export async function useWalletAtCheckout(page: Page): Promise<{
  walletToman: number;
  gatewayToman: number;
}> {
  const toggle = page.getByTestId("wallet-contribution-toggle");
  await expect(
    toggle,
    "the contribution card should be offered when the wallet is enabled and credit is spendable",
  ).toBeVisible({ timeout: 30_000 });
  await toggle.check();

  await expect(page.getByTestId("wallet-contribution-summary")).toBeVisible();
  const toman = async (testId: string) => {
    const text = (await page.getByTestId(testId).innerText()).trim();
    // Persian digits and separators back to a number.
    const normalized = text
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[^\d]/g, "");
    return Number(normalized || 0);
  };

  return {
    walletToman: await toman("wallet-contribution-wallet-leg"),
    gatewayToman: await toman("wallet-contribution-gateway-leg"),
  };
}
