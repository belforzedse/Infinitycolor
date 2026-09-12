#!/usr/bin/env node
/* eslint-disable no-console -- reporting script; stdout is the product */
/**
 * Load-time cost of a storefront route: transfer, parsed bytes, how much of the
 * JavaScript actually runs, main-thread time, long tasks, and the size of the
 * inlined RSC flight payload.
 *
 *   node perf/measure.mjs --mobile /plp/category/shirt /pdp/some-slug
 *   PERF_BASE_URL=https://new.infinitycolor.co node perf/measure.mjs --mobile
 *
 * Defaults to the local dev/prod server on :2888 and the desktop profile.
 */
import {
  DESKTOP,
  MOBILE,
  OBSERVER_INIT,
  FLIGHT_INIT,
  FLIGHT_READ,
  attachResourceAccounting,
  kb,
  parseArgs,
  summariseCoverage,
  withPage,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const profile = args.profile === "mobile" ? MOBILE : DESKTOP;

for (const route of args.routes) {
  const url = new URL(route, args.base).toString();
  // A fresh browser per route keeps the HTTP cache, the V8 code cache and
  // coverage counters from leaking between measurements.
  const result = await withPage(profile, async ({ page, cdp }) => {
    const byType = attachResourceAccounting(page);
    await page.addInitScript(FLIGHT_INIT);
    await page.addInitScript(OBSERVER_INIT);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: true,
    });

    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    await page.waitForTimeout(6_000);

    const coverage = await cdp.send("Profiler.takePreciseCoverage");
    const metrics = await cdp.send("Performance.getMetrics");
    const metric = (name) =>
      metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;

    const inPage = await page.evaluate(`({
      perf: window.__perf,
      flight: ${FLIGHT_READ},
      nav: (() => {
        const [entry] = performance.getEntriesByType("navigation");
        return entry ? { ttfb: entry.responseStart, load: entry.loadEventEnd, transfer: entry.transferSize, decoded: entry.decodedBodySize } : null;
      })(),
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0,
      dom: document.getElementsByTagName("*").length,
      listeners: undefined,
    })`);

    return {
      coverage: summariseCoverage(coverage.result),
      metrics: {
        script: metric("ScriptDuration") * 1000,
        task: metric("TaskDuration") * 1000,
      },
      byType,
      inPage,
    };
  });

  const { coverage, metrics, byType, inPage } = result;
  const script = byType.get("script") ?? { count: 0, transfer: 0 };
  const image = byType.get("image") ?? { count: 0, transfer: 0 };
  const longTasks = inPage.perf.longTasks;

  console.log(`\n${url}   [${profile.name}]`);
  console.log(
    `  TTFB ${inPage.nav?.ttfb.toFixed(0)} ms   FCP ${inPage.fcp.toFixed(0)} ms   LCP ${inPage.perf.lcp.toFixed(0)} ms   load ${inPage.nav?.load.toFixed(0)} ms`,
  );
  console.log(
    `  document ${kb(inPage.nav?.transfer ?? 0)} wire / ${kb(inPage.nav?.decoded ?? 0)} decoded   flight ${kb(inPage.flight.bytes)} in ${inPage.flight.rows} rows`,
  );
  console.log(`  JS ${script.count} requests, ${kb(script.transfer)} wire`);
  console.log(
    `  JS executed ${kb(coverage.used)} of ${kb(coverage.total)} parsed  (${((coverage.unused / coverage.total) * 100).toFixed(0)}% unused)`,
  );
  console.log(
    `  main thread  script ${metrics.script.toFixed(0)} ms   task ${metrics.task.toFixed(0)} ms`,
  );
  console.log(
    `  long tasks ${longTasks.length}, ${longTasks.reduce((sum, value) => sum + value, 0).toFixed(0)} ms total, largest ${Math.max(0, ...longTasks).toFixed(0)} ms`,
  );
  console.log(
    `  DOM nodes ${inPage.dom}   images ${image.count} / ${kb(image.transfer)}   CLS ${inPage.perf.cls.toFixed(3)}`,
  );

  const worst = coverage.perScript
    .filter((entry) => entry.url.includes("/_next/static/"))
    .sort((a, b) => b.unused - a.unused)
    .slice(0, 6);
  if (worst.length) {
    console.log("  least-used chunks:");
    for (const entry of worst) {
      console.log(
        `    ${entry.url.split("/").pop().padEnd(26)} ${kb(entry.unused).padStart(10)} unused of ${kb(entry.length)}`,
      );
    }
  }
}
