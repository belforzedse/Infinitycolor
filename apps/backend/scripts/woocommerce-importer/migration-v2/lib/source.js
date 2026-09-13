"use strict";

const { JsonHttp } = require("./http");
const { createSourceGate } = require("./sourceGate");

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** WP/Woo/TeraWallet each wrap list payloads differently; normalize to an array. */
function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.users)) return body.users;
  return [];
}

class WordPressSource {
  constructor(config, opts = {}) {
    const base = `${config.sourceBaseUrl}/wp-json`;
    const wooHeaders = { Authorization: basic(config.wooKey, config.wooSecret) };
    const wpHeaders = { Authorization: basic(config.wpUsername, config.wpApplicationPassword) };

    // Ungated, short-timeout client used only for the gate's health probe.
    // It must not carry the gate itself, or a probe would park on the hold it
    // is supposed to be testing. `/products?per_page=1` is the same check
    // `catalog/engine.js#preflight` makes, so it exercises Woo *and* its auth.
    const probeClient = new JsonHttp({
      baseUrl: `${base}/wc/v3`,
      headers: wooHeaders,
      sourceReadOnly: true,
      retries: 0,
      timeoutMs: 20_000,
    });
    // Opt-in, unlike the catalog engine. Seven other callers build a
    // WordPressSource for short ad-hoc work (identity-audit, exception audit,
    // cli.js, …); silently giving those a 60-minute hold would turn a dead
    // source into what looks like a hung terminal. The sync service asks for it
    // explicitly, because a campaign is the unattended case that needs it.
    this.sourceGate = opts.sourceGate || (
      opts.sourceHoldMaxMs == null
        ? null
        : createSourceGate({
          logger: opts.logger,
          probe: () => probeClient.get("/products", { per_page: 1 }),
          maxHoldMs: opts.sourceHoldMaxMs,
        })
    );
    const gated = { sourceReadOnly: true, timeoutMs: 45_000, sourceGate: this.sourceGate };

    this.woo = new JsonHttp({ baseUrl: `${base}/wc/v3`, headers: wooHeaders, ...gated });
    this.wp = new JsonHttp({ baseUrl: `${base}/wp/v2`, headers: wpHeaders, ...gated });
    this.wallet = new JsonHttp({ baseUrl: `${base}/terawallet/v1`, headers: wpHeaders, ...gated });
  }

  async *pages(client, pathname, params = {}, pageSize = 100) {
    let page = 1;
    let totalPages = null;
    do {
      const response = await client.get(pathname, { ...params, per_page: pageSize, page });
      const rows = rowsOf(response.data);
      const headerPages = Number(response.headers.get("x-wp-totalpages"));
      if (Number.isSafeInteger(headerPages) && headerPages > 0) totalPages = headerPages;
      yield { page, rows, total: Number(response.headers.get("x-wp-total")) || null, totalPages };
      if ((totalPages && page >= totalPages) || (!totalPages && rows.length < pageSize)) break;
      page += 1;
    } while (true);
  }

  /**
   * `pages()` with a sliding window of in-flight page requests, still yielding
   * pages in order.
   *
   * Sequential pagination pays a full round-trip per page — 2.3 s for
   * /customers, 4.7 s for /orders, ~2 s for TeraWallet /admin/users. A
   * 1,884-page wallet walk is therefore over an hour of pure latency with zero
   * concurrency, which is the single largest fixed cost in the nightly
   * campaign.
   *
   * Termination differs by route and that difference is the risk:
   *   - When the route sends `x-wp-totalpages` (Woo), that is authoritative and
   *     an empty page in the middle is not an end signal.
   *   - TeraWallet's /admin/users sends no such header, so the only stop signal
   *     is a short page. Prefetching means pages *past* the end may already be
   *     in flight when that short page arrives. Those must come back empty; a
   *     non-empty one means the list shifted under us (or the stop rule is
   *     wrong) and we would silently truncate, so it throws instead.
   *
   * Page 1 is fetched alone to learn `x-wp-totalpages` before widening, so a
   * short list never burns a full window of speculative requests.
   */
  async *pagesParallel(client, pathname, params = {}, { pageSize = 100, concurrency = 4 } = {}) {
    const width = Math.max(1, Number(concurrency) || 1);
    const fetchPage = async (page) => {
      const response = await client.get(pathname, { ...params, per_page: pageSize, page });
      const headerPages = Number(response.headers.get("x-wp-totalpages"));
      return {
        page,
        rows: rowsOf(response.data),
        total: Number(response.headers.get("x-wp-total")) || null,
        totalPages: Number.isSafeInteger(headerPages) && headerPages > 0 ? headerPages : null,
      };
    };

    const inflight = new Map();
    let nextToSchedule = 1;
    let cursor = 1;
    let totalPages = null;
    let shortPage = null;
    let primed = false;

    const schedule = () => {
      const limit = primed ? width : 1;
      while (inflight.size < limit) {
        if (totalPages !== null && nextToSchedule > totalPages) return;
        if (shortPage !== null && nextToSchedule > shortPage) return;
        const pending = fetchPage(nextToSchedule);
        // Mark handled the instant it is scheduled. While this generator is
        // suspended at `yield`, nothing is awaiting these speculative fetches,
        // so a rejection here is an *unhandled* rejection and Node (>=15) kills
        // the process outright — bypassing the campaign's own error handling,
        // which would otherwise mark the run failed. That is precisely how a
        // 10s DNS blip destroyed the 2026-09-12 campaign 65 minutes in: the
        // crash stack ended at `fetchPage` with no caller frames above it.
        // The `finally` below only covers the exit path, not this window.
        // Attaching a catch does not swallow anything for the consumer: the
        // awaited `pending` in the loop still rejects normally.
        pending.catch(() => undefined);
        inflight.set(nextToSchedule, pending);
        nextToSchedule += 1;
      }
    };

    try {
      schedule();
      while (inflight.has(cursor)) {
        const pending = inflight.get(cursor);
        inflight.delete(cursor);
        const result = await pending;
        primed = true;
        if (result.totalPages !== null) totalPages = result.totalPages;

        if (shortPage !== null && cursor > shortPage) {
          if (result.rows.length > 0) {
            const error = new Error(
              `Source pagination inconsistent on ${pathname}: page ${cursor} returned ` +
                `${result.rows.length} rows after short page ${shortPage}`,
            );
            error.code = "SOURCE_PAGINATION_INCONSISTENT";
            throw error;
          }
          cursor += 1;
          continue;
        }

        yield { page: result.page, rows: result.rows, total: result.total, totalPages };

        if (totalPages !== null) {
          if (cursor >= totalPages) break;
        } else if (result.rows.length < pageSize) {
          shortPage = cursor;
        }
        cursor += 1;
        schedule();
      }
    } finally {
      // A `break`, a throw, or an early `return` from the consumer leaves
      // speculative fetches outstanding; swallow their rejections so they never
      // surface as unhandled promise rejections.
      for (const pending of inflight.values()) pending.catch(() => undefined);
    }
  }

  /**
   * Sequential by default so every existing caller is unchanged; opt into the
   * windowed fetcher with `{ concurrency: N }`.
   */
  pageStream(client, pathname, params = {}, { concurrency = 1, pageSize = 100 } = {}) {
    return Number(concurrency) > 1
      ? this.pagesParallel(client, pathname, params, { pageSize, concurrency })
      : this.pages(client, pathname, params, pageSize);
  }

  // Woo defaults this endpoint to role=customer; OTP/phone-login plugins register
  // accounts as subscriber, which hid 285 real customers from the identity sweep.
  customers(params = {}, opts = {}) {
    return this.pageStream(this.woo, "/customers", { orderby: "id", order: "asc", role: "all", ...params }, opts);
  }
  products(params = {}, opts = {}) {
    return this.pageStream(this.woo, "/products", { orderby: "id", order: "asc", ...params }, opts);
  }
  orders(params = {}, opts = {}) {
    return this.pageStream(this.woo, "/orders", { orderby: "id", order: "asc", ...params }, opts);
  }
  productVariations(id, params = {}) {
    return this.pages(this.woo, `/products/${id}/variations`, { orderby: "id", order: "asc", ...params });
  }
  // TeraWallet returns the balance inline on this route, so one page replaces
  // 100 per-id /admin/users/{id}/balance calls. It sends no x-wp-totalpages,
  // so pagesParallel's short-page invariant is what guards completeness.
  walletUsers(opts = {}) { return this.pageStream(this.wallet, "/admin/users", {}, { pageSize: 100, ...opts }); }
  posts() { return this.pages(this.wp, "/posts", { context: "edit", orderby: "id", order: "asc", status: "any" }); }
  blogCategories() { return this.pages(this.wp, "/categories", { context: "edit", orderby: "id", order: "asc" }); }
  blogTags() { return this.pages(this.wp, "/tags", { context: "edit", orderby: "id", order: "asc" }); }
  blogAuthors() { return this.pages(this.wp, "/users", { context: "edit", orderby: "id", order: "asc" }); }
  media() { return this.pages(this.wp, "/media", { context: "edit", orderby: "id", order: "asc" }); }

  getCustomer(id) { return this.woo.get(`/customers/${id}`).then((response) => response.data); }
  getProduct(id) { return this.woo.get(`/products/${id}`).then((response) => response.data); }
  async getProductVariations(id) {
    const rows = [];
    for await (const page of this.productVariations(id)) {
      rows.push(...page.rows);
    }
    return rows;
  }
  getOrder(id) { return this.woo.get(`/orders/${id}`).then((response) => response.data); }
  getPost(id) { return this.wp.get(`/posts/${id}`, { context: "edit" }).then((response) => response.data); }
  /**
   * The same post as the site renders it. `context=edit` returns the raw body
   * and a `content.rendered` that expands the promotional shortcode but never
   * the product carousel — only the view context runs that one, so the carousel
   * is invisible to every importer that reads edit context alone.
   */
  getPostView(id) { return this.wp.get(`/posts/${id}`, { context: "view" }).then((response) => response.data); }
  getBlogCategory(id) { return this.wp.get(`/categories/${id}`, { context: "edit" }).then((response) => response.data); }
  getBlogTag(id) { return this.wp.get(`/tags/${id}`, { context: "edit" }).then((response) => response.data); }
  getBlogAuthor(id) { return this.wp.get(`/users/${id}`, { context: "edit" }).then((response) => response.data); }
  getMedia(id) { return this.wp.get(`/media/${id}`, { context: "edit" }).then((response) => response.data); }
  getWalletBalance(id) { return this.wallet.get(`/admin/users/${id}/balance`).then((response) => response.data); }

  metrics() {
    return { woo: this.woo.metrics, wordpress: this.wp.metrics, wallet: this.wallet.metrics };
  }
}

module.exports = { WordPressSource };
