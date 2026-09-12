# Storefront performance probes

Three read-only probes used to diagnose PLP/PDP load cost, and to re-check it
after a change. They drive headless Chromium over CDP because the numbers that
matter here — block-level V8 coverage, `Performance.getMetrics`, long tasks and
the size of the inlined RSC flight payload — are not exposed by the Playwright
test runner.

All three are safe against production: every probe is a GET plus a handful of
page loads. They never submit a form, add to a cart, or sign in.

```bash
cd apps/e2e

# load cost — transfer, parsed vs executed JS, main thread, long tasks, flight size
node perf/measure.mjs --mobile /plp/category/shirt /pdp/american-collar-paperback-g01173

# which interactions actually fetch new JS (i.e. were correctly deferred)
node perf/interact.mjs --steps plp /plp/category/shirt
node perf/interact.mjs --steps pdp /pdp/american-collar-paperback-g01173

# what a route prefetches over RSC while sitting idle
node perf/prefetch.mjs /pdp/american-collar-paperback-g01173

# against production
PERF_BASE_URL=https://new.infinitycolor.co node perf/measure.mjs --mobile /plp/category/shirt
```

`--mobile` applies the throttled profile the audit used: 412×915 at DPR 2.625,
4× CPU throttling, 150 ms RTT / 1.6 Mbps down. `--desktop` (the default) is
unthrottled. A fresh browser is launched per route so the HTTP cache, the V8
code cache and coverage counters never leak between measurements.

## Reading the output

- **JS executed vs parsed** — "unused" is total bytes minus the union of ranges
  V8 never entered. Summing ranges with `count > 0` instead double-counts nested
  blocks and always reports ~100 % used.
- **flight** — decoded size of the RSC payload inlined in `self.__next_f`. Large
  values mean server props are being serialized in raw form; compare with the
  budgets in `docs/perf/`.
- **interact** — a step that reports "no new JS" is code that shipped at load
  time whether or not the visitor ever used it.
- **prefetch** — `(full)` segment prefetches are the expensive kind. A link that
  triggers one needs `prefetch={false}` unless it is genuinely the likely next
  click.

For the static side of the same question (what each route's first load contains,
and a regression guard on it) use `pnpm --filter @repo/frontend run check:bundle`
after a build, and the baseline in `docs/perf/`.
