#!/usr/bin/env node
/* eslint-disable no-console -- reporting script; stdout is the product */
/**
 * Which interactions fetch new JavaScript, and how long the handler blocks.
 *
 * This is the check behind "is the lazy boundary in the right place": an
 * interaction that loads a chunk was correctly deferred, one that loads nothing
 * was already paid for at load time. Also reports the longest event handler, as
 * a lab stand-in for INP.
 *
 *   node perf/interact.mjs --steps plp /plp/category/shirt
 *   node perf/interact.mjs --steps pdp /pdp/some-slug
 */
import { DESKTOP, MOBILE, kb, withPage } from "./lib.mjs";

const STEPS = {
  plp: [
    {
      name: "scroll to bottom",
      run: (page) =>
        page.evaluate(() =>
          window.scrollTo({
            top: document.body.scrollHeight,
            behavior: "instant",
          }),
        ),
    },
    {
      name: "hover first card",
      run: (page) =>
        page
          .locator('a[href^="/pdp/"]')
          .first()
          .hover({ trial: false })
          .catch(() => {}),
    },
    {
      name: "open quick view",
      run: (page) =>
        page
          .getByRole("button", { name: /مشاهده سریع|quick/i })
          .first()
          .click({ timeout: 5_000 })
          .catch(() => {}),
    },
    {
      name: "open filters",
      run: (page) =>
        page
          .getByRole("button", { name: /فیلتر/ })
          .first()
          .click({ timeout: 5_000 })
          .catch(() => {}),
    },
    {
      name: "next page",
      run: (page) =>
        page
          .getByRole("link", { name: "2" })
          .first()
          .click({ timeout: 5_000 })
          .catch(() => {}),
    },
  ],
  pdp: [
    {
      name: "second thumbnail",
      run: (page) =>
        page
          .locator("[data-gallery-thumb], button img")
          .nth(1)
          .click({ timeout: 5_000 })
          .catch(() => {}),
    },
    {
      name: "size guide",
      run: (page) =>
        page
          .getByRole("button", { name: /راهنمای سایز/ })
          .first()
          .click({ timeout: 5_000 })
          .catch(() => {}),
    },
    {
      name: "scroll to reviews",
      run: (page) =>
        page.evaluate(() =>
          window.scrollTo({
            top: document.body.scrollHeight,
            behavior: "instant",
          }),
        ),
    },
    {
      name: "share",
      run: (page) =>
        page
          .getByRole("button", { name: /اشتراک|share/i })
          .first()
          .click({ timeout: 5_000 })
          .catch(() => {}),
    },
  ],
};

const argv = process.argv.slice(2);
let steps = "plp";
let base = process.env.PERF_BASE_URL ?? "http://localhost:2888";
let mobile = false;
const routes = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--steps") steps = argv[++i];
  else if (argv[i] === "--base") base = argv[++i];
  else if (argv[i] === "--mobile") mobile = true;
  else routes.push(argv[i]);
}
if (!STEPS[steps])
  throw new Error(`--steps must be one of ${Object.keys(STEPS).join(", ")}`);
if (!routes.length) throw new Error("pass at least one route");

for (const route of routes) {
  const url = new URL(route, base).toString();
  await withPage(mobile ? MOBILE : DESKTOP, async ({ page }) => {
    const scripts = new Map();
    page.on("response", async (response) => {
      if (response.request().resourceType() !== "script") return;
      try {
        scripts.set(
          response.url(),
          (await response.request().sizes()).responseBodySize,
        );
      } catch {
        scripts.set(response.url(), 0);
      }
    });
    await page.addInitScript(`
      window.__events = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__events.push(entry.duration);
      }).observe({ type: "event", buffered: true, durationThreshold: 16 });
    `);

    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    await page.waitForTimeout(4_000);
    let seen = new Set(scripts.keys());

    console.log(
      `\n${url}   [${mobile ? "mobile" : "desktop"}, ${steps} steps]`,
    );
    for (const step of STEPS[steps]) {
      await page.evaluate(() => {
        window.__events.length = 0;
      });
      await step.run(page);
      await page.waitForTimeout(2_500);
      const fresh = [...scripts.keys()].filter((key) => !seen.has(key));
      seen = new Set(scripts.keys());
      const bytes = fresh.reduce(
        (sum, key) => sum + (scripts.get(key) ?? 0),
        0,
      );
      const events = await page.evaluate(() => window.__events);
      const longest = Math.max(0, ...events);
      const label = fresh.length
        ? `${fresh.length} chunk(s), ${kb(bytes)}: ${fresh.map((key) => key.split("/").pop()).join(", ")}`
        : "no new JS";
      console.log(`  ${step.name.padEnd(22)} ${label}`);
      console.log(`  ${"".padEnd(22)} longest event ${longest.toFixed(0)} ms`);
    }
  });
}
