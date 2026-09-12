/**
 * Shared plumbing for the storefront performance probes.
 *
 * These scripts talk to CDP directly rather than using the Playwright test
 * runner: what we want is precise V8 coverage, `Performance.getMetrics`, long
 * tasks and the size of the inlined RSC flight payload, none of which the test
 * runner surfaces. They are safe to point at production — every probe is a GET
 * plus a handful of page loads.
 */
import { chromium } from "@playwright/test";

export const MOBILE = {
  name: "mobile",
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  cpuThrottling: 4,
  network: {
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  },
};

export const DESKTOP = {
  name: "desktop",
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  cpuThrottling: 1,
  network: null,
};

export function parseArgs(argv) {
  const args = { profile: "desktop", trace: false, routes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--mobile") args.profile = "mobile";
    else if (value === "--desktop") args.profile = "desktop";
    else if (value === "--trace") args.trace = true;
    else if (value === "--base") args.base = argv[++i];
    else if (value.startsWith("--")) throw new Error(`unknown flag ${value}`);
    else args.routes.push(value);
  }
  args.base ??= process.env.PERF_BASE_URL ?? "http://localhost:2888";
  if (!args.routes.length)
    args.routes = [
      "/plp/category/shirt",
      "/pdp/american-collar-paperback-g01173",
    ];
  return args;
}

export async function withPage(profile, fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Performance.enable");
    if (profile.cpuThrottling > 1) {
      await cdp.send("Emulation.setCPUThrottlingRate", {
        rate: profile.cpuThrottling,
      });
    }
    if (profile.network) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        ...profile.network,
      });
    }
    return await fn({ page, cdp, context });
  } finally {
    await browser.close();
  }
}

/** Byte accounting per resource type, split into wire and decoded size. */
export function attachResourceAccounting(page) {
  const byType = new Map();
  page.on("response", async (response) => {
    const request = response.request();
    const type = request.resourceType();
    const row = byType.get(type) ?? { count: 0, transfer: 0 };
    row.count += 1;
    try {
      const sizes = await response.request().sizes();
      row.transfer += sizes.responseBodySize + sizes.responseHeadersSize;
    } catch {
      // A response that never finished has no sizes; the count still matters.
    }
    byType.set(type, row);
  });
  return byType;
}

/** Long tasks and paint timings, read from inside the page. */
export const OBSERVER_INIT = `
  window.__perf = { longTasks: [], cls: 0, lcp: 0 };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__perf.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__perf.cls += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    window.__perf.lcp = entries[entries.length - 1]?.startTime ?? 0;
  }).observe({ type: "largest-contentful-paint", buffered: true });
`;

/**
 * Bytes actually executed, from block-level precise coverage.
 *
 * Note the direction: "used" is total minus the union of ranges with count 0.
 * Summing ranges with count > 0 double-counts nested blocks and reports ~100 %.
 */
export function summariseCoverage(entries) {
  let total = 0;
  let unused = 0;
  const perScript = [];
  for (const entry of entries) {
    // The outermost range of the anonymous top-level function spans the whole
    // script, so the largest end offset is the script length.
    const length = Math.max(
      0,
      ...entry.functions.flatMap((fn) =>
        fn.ranges.map((range) => range.endOffset),
      ),
    );
    const dead = [];
    for (const fn of entry.functions) {
      for (const range of fn.ranges) {
        if (range.count === 0) dead.push([range.startOffset, range.endOffset]);
      }
    }
    dead.sort((a, b) => a[0] - b[0]);
    let merged = 0;
    let cursor = -1;
    let end = -1;
    for (const [start, stop] of dead) {
      if (start > end) {
        if (end > cursor) merged += end - Math.max(cursor, 0);
        cursor = start;
        end = stop;
      } else if (stop > end) {
        end = stop;
      }
    }
    if (end > cursor) merged += end - Math.max(cursor, 0);
    total += length;
    unused += merged;
    perScript.push({ url: entry.url, length, unused: merged });
  }
  return { total, unused, used: total - unused, perScript };
}

/**
 * Decoded size of the RSC flight payload inlined in the HTML.
 *
 * React splices rows out of `self.__next_f` as it consumes them, so reading the
 * array after load always reports zero. This pre-creates the array and counts
 * bytes as they are pushed, which is why it has to run as an init script.
 */
export const FLIGHT_INIT = `
  window.__flight = { bytes: 0, rows: 0 };
  self.__next_f = [];
  const __push = self.__next_f.push.bind(self.__next_f);
  self.__next_f.push = (...items) => {
    for (const item of items) {
      const value = Array.isArray(item) ? item[1] : item;
      if (typeof value === "string") {
        window.__flight.bytes += new TextEncoder().encode(value).length;
        window.__flight.rows += 1;
      }
    }
    return __push(...items);
  };
`;

export const FLIGHT_READ = `window.__flight ?? { bytes: 0, rows: 0 }`;

export function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
