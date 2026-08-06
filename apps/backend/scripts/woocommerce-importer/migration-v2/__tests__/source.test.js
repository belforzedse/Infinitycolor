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
