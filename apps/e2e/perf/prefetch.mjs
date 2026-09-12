#!/usr/bin/env node
/* eslint-disable no-console -- reporting script; stdout is the product */
/**
 * What a route pulls over RSC while it sits idle.
 *
 * Next prefetches `<Link>` targets that enter the viewport. With
 * `partialPrefetching` a tree fetch is a couple of KB and worth having, but a
 * link that prefetches a full page segment can cost more than the page itself —
 * which is what the logo, breadcrumb and bottom-nav home link were doing on
 * every PDP. Run this before and after changing a link's `prefetch` prop.
 *
 *   node perf/prefetch.mjs /pdp/some-slug
 */
import { DESKTOP, MOBILE, kb, parseArgs, withPage } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const profile = args.profile === "mobile" ? MOBILE : DESKTOP;

for (const route of args.routes) {
  const url = new URL(route, args.base).toString();
  const rows = await withPage(profile, async ({ page }) => {
    const collected = [];
    page.on("response", async (response) => {
      const request = response.request();
      const headers = await request.allHeaders();
      const isRsc = "rsc" in headers || response.url().includes("_rsc=");
      if (!isRsc) return;
      let bytes = 0;
      try {
        bytes = (await request.sizes()).responseBodySize;
      } catch {
        // Aborted prefetches still tell us the request was made.
      }
      collected.push({
        url: response.url(),
        kind: headers["next-router-prefetch"] ? "prefetch" : "navigation",
        segment: headers["next-router-segment-prefetch"] ?? "(full)",
        bytes,
      });
    });

    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    // Scroll the page so every in-viewport link gets its chance to prefetch.
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
    );
    await page.waitForTimeout(8_000);
    return collected;
  });

  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  console.log(`\n${url}   [${profile.name}]`);
  console.log(`  ${rows.length} RSC requests while idle, ${kb(total)} total`);
  for (const row of rows.sort((a, b) => b.bytes - a.bytes)) {
    const path = new URL(row.url).pathname + new URL(row.url).search;
    console.log(
      `    ${kb(row.bytes).padStart(10)}  ${row.kind.padEnd(10)} ${row.segment.padEnd(10)} ${path.slice(0, 80)}`,
    );
  }
  const full = rows.filter(
    (row) => row.segment === "(full)" && row.kind === "prefetch",
  );
  if (full.length) {
    console.log(
      `  ${full.length} full-segment prefetch(es) — check the <Link prefetch> prop on those targets`,
    );
  }
}
