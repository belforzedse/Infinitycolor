"use strict";

const { JsonHttp } = require("./http");

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

class WordPressSource {
  constructor(config) {
    const base = `${config.sourceBaseUrl}/wp-json`;
    this.woo = new JsonHttp({
      baseUrl: `${base}/wc/v3`,
      headers: { Authorization: basic(config.wooKey, config.wooSecret) },
      sourceReadOnly: true,
      timeoutMs: 45_000,
    });
    this.wp = new JsonHttp({
      baseUrl: `${base}/wp/v2`,
      headers: { Authorization: basic(config.wpUsername, config.wpApplicationPassword) },
      sourceReadOnly: true,
      timeoutMs: 45_000,
    });
    this.wallet = new JsonHttp({
      baseUrl: `${base}/terawallet/v1`,
      headers: { Authorization: basic(config.wpUsername, config.wpApplicationPassword) },
      sourceReadOnly: true,
      timeoutMs: 45_000,
    });
  }

  async *pages(client, pathname, params = {}, pageSize = 100) {
    let page = 1;
    let totalPages = null;
    do {
      const response = await client.get(pathname, { ...params, per_page: pageSize, page });
      const rows = Array.isArray(response.data)
        ? response.data
        : Array.isArray(response.data?.data)
          ? response.data.data
          : Array.isArray(response.data?.users)
            ? response.data.users
            : [];
      const headerPages = Number(response.headers.get("x-wp-totalpages"));
      if (Number.isSafeInteger(headerPages) && headerPages > 0) totalPages = headerPages;
      yield { page, rows, total: Number(response.headers.get("x-wp-total")) || null, totalPages };
      if ((totalPages && page >= totalPages) || (!totalPages && rows.length < pageSize)) break;
      page += 1;
    } while (true);
  }

  customers() { return this.pages(this.woo, "/customers", { orderby: "id", order: "asc" }); }
  orders() { return this.pages(this.woo, "/orders", { orderby: "id", order: "asc" }); }
  walletUsers() { return this.pages(this.wallet, "/admin/users", {}, 100); }
  posts() { return this.pages(this.wp, "/posts", { context: "edit", orderby: "id", order: "asc", status: "any" }); }
  blogCategories() { return this.pages(this.wp, "/categories", { context: "edit", orderby: "id", order: "asc" }); }
  blogTags() { return this.pages(this.wp, "/tags", { context: "edit", orderby: "id", order: "asc" }); }
  blogAuthors() { return this.pages(this.wp, "/users", { context: "edit", orderby: "id", order: "asc" }); }
  media() { return this.pages(this.wp, "/media", { context: "edit", orderby: "id", order: "asc" }); }

  getCustomer(id) { return this.woo.get(`/customers/${id}`).then((response) => response.data); }
  getProduct(id) { return this.woo.get(`/products/${id}`).then((response) => response.data); }
  async getProductVariations(id) {
    const rows = [];
    for await (const page of this.pages(
      this.woo,
      `/products/${id}/variations`,
      { orderby: "id", order: "asc" },
    )) {
      rows.push(...page.rows);
    }
    return rows;
  }
  getOrder(id) { return this.woo.get(`/orders/${id}`).then((response) => response.data); }
  getPost(id) { return this.wp.get(`/posts/${id}`, { context: "edit" }).then((response) => response.data); }
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
