"use strict";

const path = require("node:path");
const { JsonHttp } = require("./http");
const {
  sourceTimestampHeaders,
} = require("../../utils/sourceTimestamps");

class Destination {
  constructor(config) {
    this.baseUrl = config.destinationBaseUrl;
    this.headers = {
      Authorization: `Bearer ${config.strapiToken}`,
      "X-Infinity-Migration-Mode": "wordpress-v2",
      "X-Infinity-Migration-Control": config.controlToken,
    };
    this.http = new JsonHttp({ baseUrl: this.baseUrl, headers: this.headers, timeoutMs: 60_000 });
  }

  async *snapshot(entity, pageSize = 1000) {
    let page = 1;
    do {
      const response = await this.http.get("/internal/migrations/wordpress-v2/snapshot", {
        entity,
        page,
        pageSize,
      });
      const payload = response.data?.data;
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      yield rows;
      if (!payload?.hasMore || rows.length < pageSize) break;
      page += 1;
    } while (true);
  }

  async loadSnapshot(entity) {
    const rows = [];
    for await (const page of this.snapshot(entity)) rows.push(...page);
    return rows;
  }

  async upsertUser(payload) {
    return (await this.http.post(
      "/internal/migrations/wordpress-v2/users/upsert",
      payload,
    )).data?.data;
  }

  async upsertWallet(payload) {
    return (await this.http.post("/internal/migrations/wordpress-v2/wallets/upsert", payload)).data?.data;
  }

  async upsertOrder(payload) {
    const timestamps = payload?.sourceCreatedAt ? {
      createdAt: payload.sourceCreatedAt,
      updatedAt: payload.sourceUpdatedAt,
    } : null;
    return (await this.http.post(
      "/internal/migrations/wordpress-v2/orders/upsert",
      payload,
      sourceTimestampHeaders(timestamps),
    )).data?.data;
  }

  async getContent(endpoint, query = {}) {
    return (await this.http.get(endpoint, query)).data;
  }

  async contentUpsert(endpoint, id, data, sourceTimestamps = null) {
    const headers = sourceTimestampHeaders(sourceTimestamps);
    if (id) {
      await this.http.put(`${endpoint}/${id}`, { data }, headers);
      return { id: Number(id), mode: "updated" };
    }
    const response = await this.http.post(endpoint, { data }, headers);
    const savedId = response.data?.data?.id;
    if (!savedId) throw new Error(`DESTINATION_CREATE_RETURNED_NO_ID:${endpoint}`);
    return { id: Number(savedId), mode: "created" };
  }

  async uploadBlogMedia(sourceUrl, sourceId, sourceTimestamps = null) {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:") throw new Error("BLOG_MEDIA_URL_NOT_HTTPS");
    const hostAllowed = (hostname) =>
      hostname === "infinitycolor.co" || hostname.endsWith(".infinitycolor.co");
    if (!hostAllowed(url.hostname)) throw new Error("BLOG_MEDIA_HOST_NOT_ALLOWED");
    const download = await fetch(url, { method: "GET", redirect: "follow" });
    if (!download.ok) throw new Error(`BLOG_MEDIA_DOWNLOAD_${download.status}`);
    const finalUrl = new URL(download.url);
    if (finalUrl.protocol !== "https:" || !hostAllowed(finalUrl.hostname)) {
      throw new Error("BLOG_MEDIA_REDIRECT_NOT_ALLOWED");
    }
    const mime = String(download.headers.get("content-type") || "").split(";")[0];
    if (!mime.startsWith("image/")) throw new Error("BLOG_MEDIA_NOT_IMAGE");
    const contentLength = Number(download.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 100 * 1024 * 1024) {
      throw new Error("BLOG_MEDIA_TOO_LARGE");
    }
    const bytes = await download.arrayBuffer();
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error("BLOG_MEDIA_TOO_LARGE");
    const extension = path.extname(url.pathname).slice(0, 12) || ".bin";
    const form = new FormData();
    form.append("files", new Blob([bytes], { type: mime }), `wp-blog-${sourceId}${extension}`);
    const response = await fetch(`${this.baseUrl}/upload`, {
      method: "POST",
      headers: { ...this.headers, ...sourceTimestampHeaders(sourceTimestamps) },
      body: form,
    });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload) || !payload[0]?.id) {
      throw new Error(`BLOG_MEDIA_UPLOAD_${response.status}`);
    }
    return { id: Number(payload[0].id), bytes: bytes.byteLength };
  }

  metrics() { return this.http.metrics; }
}

module.exports = { Destination };
