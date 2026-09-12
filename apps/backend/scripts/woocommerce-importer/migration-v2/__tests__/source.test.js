"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { WordPressSource } = require("../lib/source");

const headers = (totalPages) => ({
  get(name) {
    if (name === "x-wp-totalpages") return String(totalPages);
    if (name === "x-wp-total") return "2";
    return null;
  },
});

test("WordPress pagination follows total pages through an empty middle page", async () => {
  const calls = [];
  const client = {
    async get(_pathname, query) {
      calls.push(query.page);
      const rows = query.page === 1 ? [{ id: 1 }] : query.page === 2 ? [] : [{ id: 2 }];
      return { data: rows, headers: headers(3) };
    },
  };
  const source = Object.create(WordPressSource.prototype);
  const pages = [];
  for await (const page of source.pages(client, "/rows", {}, 100)) pages.push(page.rows);
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(pages, [[{ id: 1 }], [], [{ id: 2 }]]);
});

test("product and order delta methods preserve modified filters while remaining GET-only", async () => {
  const calls = [];
  const client = {
    async get(pathname, query) {
      calls.push({ pathname, query });
      return { data: [], headers: headers(1) };
    },
  };
  const source = Object.create(WordPressSource.prototype);
  source.woo = client;
  for await (const _page of source.products({ modified_after: "2026-08-05T00:00:00Z", orderby: "modified" })) {}
  for await (const _page of source.orders({ modified_after: "2026-08-05T00:00:00Z", orderby: "modified" })) {}
  assert.deepEqual(calls.map((call) => call.pathname), ["/products", "/orders"]);
  assert.ok(calls.every((call) => call.query.modified_after === "2026-08-05T00:00:00Z"));
  assert.ok(calls.every((call) => call.query.orderby === "modified"));
});

test("pagesParallel overlaps page fetches and still yields pages in order", async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  const client = {
    async get(_pathname, query) {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { data: [{ id: query.page }], headers: headers(5) };
    },
  };
  const source = Object.create(WordPressSource.prototype);
  const seen = [];
  for await (const page of source.pagesParallel(client, "/rows", {}, { pageSize: 1, concurrency: 4 })) {
    seen.push(page.page);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.ok(peakInFlight > 1, `expected overlapping requests, peak was ${peakInFlight}`);
});

test("pagesParallel stops at the first short page when the route sends no totalpages header", async () => {
  // TeraWallet's /admin/users omits x-wp-totalpages, so a short page is the
  // only end-of-list signal.
  const requested = [];
  const noHeaders = { get: () => null };
  const client = {
    async get(_pathname, query) {
      requested.push(query.page);
      const rows = query.page <= 3 ? [{ id: query.page * 10 }, { id: query.page * 10 + 1 }] : [];
      return { data: rows, headers: noHeaders };
    },
  };
  const source = Object.create(WordPressSource.prototype);
  const rows = [];
  for await (const page of source.pagesParallel(client, "/admin/users", {}, { pageSize: 2, concurrency: 4 })) {
    rows.push(...page.rows);
  }
  assert.equal(rows.length, 6);
  assert.ok(Math.max(...requested) <= 7, "must not keep paging past the end");
});

test("pagesParallel refuses to truncate when a prefetched page arrives non-empty after a short one", async () => {
  // A speculative page past the apparent end coming back full means the list
  // shifted under us; silently stopping there would drop real rows.
  const noHeaders = { get: () => null };
  const client = {
    async get(_pathname, query) {
      const rows = query.page === 2
        ? [{ id: 21 }]
        : [{ id: query.page * 10 }, { id: query.page * 10 + 1 }];
      return { data: rows, headers: noHeaders };
    },
  };
  const source = Object.create(WordPressSource.prototype);
  await assert.rejects(
    (async () => {
      for await (const _page of source.pagesParallel(client, "/admin/users", {}, { pageSize: 2, concurrency: 4 })) {
        // drain
      }
    })(),
    (error) => error.code === "SOURCE_PAGINATION_INCONSISTENT",
  );
});

test("pageStream stays sequential unless concurrency is raised", async () => {
  const calls = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const client = {
    async get(_pathname, query) {
      calls.push(query.page);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { data: query.page === 1 ? [{ id: 1 }] : [], headers: headers(2) };
    },
  };
  const source = Object.create(WordPressSource.prototype);
  for await (const _page of source.pageStream(client, "/rows", {}, {})) { /* drain */ }
  // One page at a time: page 2 is only requested after page 1 came back.
  assert.deepEqual(calls, [1, 2]);
  assert.equal(peakInFlight, 1, "default pageStream must not prefetch");
});

test("walletUsers reads the bulk balance route and honours a concurrency override", async () => {
  const queries = [];
  const source = Object.create(WordPressSource.prototype);
  source.wallet = {
    async get(pathname, query) {
      queries.push({ pathname, query });
      return { data: [{ id: 70884, balance: 0, base_currency: "IRT" }], headers: { get: () => null } };
    },
  };
  const pages = [];
  for await (const page of source.walletUsers({ concurrency: 4 })) pages.push(page);
  assert.equal(queries[0].pathname, "/admin/users");
  assert.equal(queries[0].query.per_page, 100);
  assert.equal(pages[0].rows[0].id, 70884);
});

test("a speculative page rejecting while the consumer works never becomes an unhandled rejection", async (t) => {
  // The 2026-09-12 campaign death, reproduced. pagesParallel prefetches a window
  // of pages, then suspends at `yield` while the caller processes 100 customers.
  // A prefetched page that rejects during that window has nothing awaiting it,
  // so Node terminates the process — bypassing the campaign's own failure
  // handling entirely. The rejection must still reach the consumer in order.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const client = {
    async get(_pathname, query) {
      if (query.page === 3) throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      });
      return { data: [{ id: query.page }], headers: headers(4) };
    },
  };

  const source = Object.create(WordPressSource.prototype);
  const seen = [];
  await assert.rejects(async () => {
    for await (const page of source.pagesParallel(client, "/rows", {}, { pageSize: 1, concurrency: 4 })) {
      seen.push(page.page);
      // Simulate real per-page work: pages 3 and 4 are already in flight and
      // page 3 rejects right here, with the generator suspended.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, /fetch failed/);

  assert.deepEqual(seen, [1, 2], "pages before the failure are still yielded in order");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], "no rejection may escape unhandled");
});
