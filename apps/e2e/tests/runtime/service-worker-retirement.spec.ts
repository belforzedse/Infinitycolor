import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

// Separate loopback origins model old-domain replacement without touching DNS or production.
async function workerOrigin() {
  const retirement = await readFile(
    new URL("../../../frontend/public/sw-retire.js", import.meta.url),
    "utf8",
  );
  let retire = false;
  const server = createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.writeHead(200, {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      response.end(
        retire
          ? retirement
          : `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));`,
      );
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<!doctype html><html><body><input id='cart-note' value='unchanged'></body></html>",
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    retire: () => {
      retire = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

for (const oldDomain of ["new.infinitycolor.co", "www.infinitycolor.co"]) {
  test(`${oldDomain}: updating an existing worker retires only its origin without navigation`, async ({
    context,
    request,
  }) => {
    const old = await workerOrigin(),
      canonical = await workerOrigin();
    const page = await context.newPage(),
      canonicalPage = await context.newPage();
    try {
      for (const [target, origin] of [
        [page, old],
        [canonicalPage, canonical],
      ] as const) {
        await target.goto(origin.url);
        await target.evaluate(async () => {
          await navigator.serviceWorker.register("/sw.js");
          await navigator.serviceWorker.ready;
          await caches.open("runtime-cache-vfixture");
          await caches.open("unrelated-cache");
        });
        await expect
          .poll(() =>
            target.evaluate(() => Boolean(navigator.serviceWorker.controller)),
          )
          .toBe(true);
      }
      await page.locator("#cart-note").fill("preserved shopper state");
      old.retire();
      const response = await request.get(`${old.url}/sw.js`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("javascript");
      expect(response.headers()["cache-control"]).toContain("no-store");
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration!.update();
      });
      await expect
        .poll(() =>
          page.evaluate(
            async () =>
              (await navigator.serviceWorker.getRegistrations()).length,
          ),
        )
        .toBe(0);
      expect(await page.evaluate(() => caches.keys())).toEqual([
        "unrelated-cache",
      ]);
      expect(page.url()).toBe(`${old.url}/`);
      await expect(page.locator("#cart-note")).toHaveValue(
        "preserved shopper state",
      );
      expect(
        await canonicalPage.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
      ).toBe(1);
      expect(await canonicalPage.evaluate(() => caches.keys())).toContain(
        "runtime-cache-vfixture",
      );
    } finally {
      await page.close();
      await canonicalPage.close();
      await old.close();
      await canonical.close();
    }
  });
}
