"use strict";

const G = require("./genericAttributes");
const { sourceTimestampHeaders } = require("../../utils/sourceTimestamps");

/**
 * Strapi target repository. All writes are idempotent: entities are matched by the
 * unique `external_id` field. Existing WooCommerce-sourced entities are loaded once
 * into an in-memory index per run, so upserts don't issue a lookup per item (the
 * legacy importer did an N+1 GET per variation/SKU/attribute).
 */
class StrapiRepo {
  /**
   * @param {import('./httpClient').HttpClient} http
   * @param {{ info: Function, debug: Function, warn: Function, error: Function }} logger
   */
  constructor(http, logger) {
    this.http = http;
    this.logger = logger;
    // attribute caches: key = `${type}:${title.toLowerCase()}` → strapi id
    this.attrCache = { color: new Map(), size: new Map(), model: new Map() };
    this.productTagCache = new Map();
    this.productTagDryRunSeen = new Set();
    this.genericIndexes = null;
    this.genericDefinitionCache = new Map();
    this.genericTermCache = new Map();
    this.genericDryRunSeen = {
      definitions: new Set(),
      terms: new Set(),
      assignments: new Set(),
    };
  }

  /** Fetch every entity on an endpoint (Strapi pagination), filtered to WC source. */
  async fetchAllWooEntities(endpoint, params = {}) {
    const out = [];
    let page = 1;
    let pageCount = 1;
    do {
      const response = await this.http.get(endpoint, {
        params: {
          "filters[external_source][$eq]": "woocommerce",
          "pagination[page]": page,
          "pagination[pageSize]": 100,
          ...params,
        },
      });
      const body = response.data;
      const data = Array.isArray(body?.data) ? body.data : [];
      out.push(...data);
      pageCount = body?.meta?.pagination?.pageCount || 1;
      page += 1;
    } while (page <= pageCount);
    return out;
  }

  /**
   * Build an index of external_id → { id } for an endpoint.
   * @returns {Promise<Map<string, { id:number, attributes?:object }>>}
   */
  async buildExternalIndex(endpoint, params = {}) {
    const entities = await this.fetchAllWooEntities(endpoint, params);
    const index = new Map();
    for (const entity of entities) {
      const externalId = entity.attributes?.external_id ?? entity.external_id;
      if (externalId !== undefined && externalId !== null && externalId !== "") {
        const key = externalId.toString();
        if (index.has(key)) {
          // external_id is meant to be unique; a duplicate means an ambiguous match.
          // Keep the first seen and warn rather than silently picking one to update.
          this.logger?.warn?.(`⚠️ ambiguous external_id ${key} on ${endpoint} (ids ${index.get(key).id}, ${entity.id}); using ${index.get(key).id}`);
        } else {
          index.set(key, entity);
        }
      }
    }
    return index;
  }

  /** Read the protected category/editorial migration projection in bounded pages. */
  async fetchCategoryEditorialSnapshot() {
    const rows = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const response = await this.http.get("/internal/migrations/wordpress-v2/snapshot", {
        params: { entity: "categoryEditorial", page, pageSize: 500 },
      });
      const snapshot = response.data?.data ?? response.data;
      if (!Array.isArray(snapshot?.rows)) {
        throw new Error("CATEGORY_EDITORIAL_SNAPSHOT_INVALID");
      }
      rows.push(...snapshot.rows);
      hasMore = snapshot.hasMore === true;
      page += 1;
      if (page > 10) throw new Error("CATEGORY_EDITORIAL_SNAPSHOT_PAGINATION_INVALID");
    }
    return rows;
  }

  async prepareCategoryEditorial(payload) {
    const response = await this.http.post(
      "/internal/migrations/wordpress-v2/category-editorial/prepare",
      payload,
    );
    return response.data?.data ?? response.data;
  }

  async finalizeCategoryEditorial(payload) {
    const response = await this.http.post(
      "/internal/migrations/wordpress-v2/category-editorial/finalize",
      payload,
    );
    return response.data?.data ?? response.data;
  }

  /**
   * Idempotent upsert keyed on external_id. Uses the preloaded index first; on a
   * create that hits a unique-constraint race, falls back to a live lookup + update.
   *
   * @param {object} args
   * @param {string} args.endpoint e.g. "/products"
   * @param {string} args.externalId
   * @param {object} args.payload
   * @param {Map<string, {id:number}>} args.index
   * @returns {Promise<{ id:number, mode:"created"|"updated" }>}
   */
  async upsert({ endpoint, externalId, payload, index, sourceTimestamps = null }) {
    const existing = index.get(externalId.toString());
    const requestConfig = { headers: sourceTimestampHeaders(sourceTimestamps) };
    if (existing) {
      await this.http.put(`${endpoint}/${existing.id}`, { data: payload }, requestConfig);
      return { id: existing.id, mode: "updated" };
    }

    try {
      const response = await this.http.post(endpoint, { data: payload }, requestConfig);
      const id = response.data?.data?.id;
      index.set(externalId.toString(), { id });
      return { id, mode: "created" };
    } catch (error) {
      // Possible unique-constraint race: another path already created it. Recover.
      if (error.response?.status === 400 || error.response?.status === 409) {
        const found = await this.findByExternalId(endpoint, externalId);
        if (found) {
          await this.http.put(`${endpoint}/${found.id}`, { data: payload }, requestConfig);
          index.set(externalId.toString(), { id: found.id });
          return { id: found.id, mode: "updated" };
        }
      }
      throw error;
    }
  }

  async findByExternalId(endpoint, externalId) {
    const response = await this.http.get(endpoint, {
      params: { "filters[external_id][$eq]": externalId.toString(), "pagination[pageSize]": 1 },
    });
    const data = response.data?.data;
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  }

  async changeProductPublication(productId, externalId, intent) {
    const response = await this.http.post(`/products/${productId}/publication`, {
      data: {
        action: intent.action,
        ...(intent.publishAt ? { publishAt: intent.publishAt } : {}),
        ...(intent.timezone ? { timezone: intent.timezone } : {}),
        requireMedia: intent.requireMedia === true,
        expectedExternalSource: "woocommerce",
        expectedExternalId: String(externalId),
      },
    });
    return response.data?.data || response.data;
  }

  /**
   * Preload color/size/model attribute caches so attribute resolution is local.
   */
  async preloadAttributes() {
    const load = async (type, endpoint) => {
      const entities = await this.fetchAllAttributeEntities(endpoint);
      for (const e of entities) {
        const title = (e.attributes?.Title ?? e.Title ?? "").toString().toLowerCase();
        if (title) {
          this.attrCache[type].set(title, e.id);
        }
      }
    };
    await Promise.all([
      load("color", "/product-variation-colors"),
      load("size", "/product-variation-sizes"),
      load("model", "/product-variation-models"),
    ]);
  }

  async preloadProductTags() {
    const entities = await this.fetchAllAttributeEntities("/product-tags");
    for (const entity of entities) {
      const title = String(entity.attributes?.Title ?? entity.Title ?? "").trim();
      if (title) this.productTagCache.set(G.canonicalKey(title), entity.id);
    }
  }

  inspectProductTags(sourceTags) {
    const counters = { created: 0, unchanged: 0 };
    const seen = new Set();
    for (const tag of Array.isArray(sourceTags) ? sourceTags : []) {
      const title = String(tag?.name || "").trim();
      const key = G.canonicalKey(title);
      if (!key || seen.has(key) || this.productTagDryRunSeen.has(key)) continue;
      seen.add(key);
      this.productTagDryRunSeen.add(key);
      counters[this.productTagCache.has(key) ? "unchanged" : "created"] += 1;
    }
    return counters;
  }

  async syncProductTags(sourceTags) {
    const ids = [];
    const counters = { created: 0, unchanged: 0 };
    const seen = new Set();
    for (const tag of Array.isArray(sourceTags) ? sourceTags : []) {
      const title = String(tag?.name || "").trim();
      const key = G.canonicalKey(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let id = this.productTagCache.get(key);
      if (id) {
        counters.unchanged += 1;
      } else {
        const response = await this.http.post("/product-tags", { data: { Title: title } });
        id = response.data?.data?.id;
        if (!id) throw new Error(`Product tag create returned no id: ${title}`);
        this.productTagCache.set(key, id);
        counters.created += 1;
      }
      ids.push(id);
    }
    return { ids, counters };
  }

  async fetchAllAttributeEntities(endpoint) {
    const out = [];
    let page = 1;
    let pageCount = 1;
    do {
      const response = await this.http.get(endpoint, {
        params: { "pagination[page]": page, "pagination[pageSize]": 100 },
      });
      const data = Array.isArray(response.data?.data) ? response.data.data : [];
      out.push(...data);
      pageCount = response.data?.meta?.pagination?.pageCount || 1;
      page += 1;
    } while (page <= pageCount);
    return out;
  }

  /**
   * Find-or-create an attribute (color/size/model) and return its Strapi id.
   * @param {{ type:"color"|"size"|"model", title:string, colorCode?:string, externalId?:string }} attr
   */
  async resolveAttributeId(attr) {
    const key = attr.title.toLowerCase();
    const cache = this.attrCache[attr.type];
    if (cache.has(key)) {
      return cache.get(key);
    }

    const endpoint =
      attr.type === "color"
        ? "/product-variation-colors"
        : attr.type === "size"
          ? "/product-variation-sizes"
          : "/product-variation-models";

    const payload = {
      Title: attr.title,
      external_source: "woocommerce",
    };
    if (attr.externalId) {
      payload.external_id = attr.externalId;
    }
    if (attr.type === "color" && attr.colorCode) {
      payload.ColorCode = attr.colorCode;
    }

    try {
      const response = await this.http.post(endpoint, { data: payload });
      const id = response.data?.data?.id;
      cache.set(key, id);
      return id;
    } catch (error) {
      // Likely a duplicate (unique Title) — fetch the existing one.
      const found = await this.findAttributeByTitle(endpoint, attr.title);
      if (found) {
        cache.set(key, found.id);
        return found.id;
      }
      throw error;
    }
  }

  async findAttributeByTitle(endpoint, title) {
    const response = await this.http.get(endpoint, {
      params: { "filters[Title][$eq]": title, "pagination[pageSize]": 1 },
    });
    const data = response.data?.data;
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  }

  async preloadGenericAttributes() {
    const [definitions, terms, assignments] = await Promise.all([
      this.buildExternalIndex("/product-attributes"),
      this.buildExternalIndex("/product-attribute-terms"),
      this.buildExternalIndex("/product-attribute-assignments"),
    ]);
    this.genericIndexes = { definitions, terms, assignments };
    return this.genericIndexes;
  }

  inspectProductAttributePlan(plan) {
    if (!this.genericIndexes) throw new Error("Generic attribute indexes are not loaded");
    const counters = { created: 0, updated: 0 };
    const countOnce = (kind, externalId) => {
      if (this.genericDryRunSeen[kind].has(externalId)) return;
      this.genericDryRunSeen[kind].add(externalId);
      counters[this.genericIndexes[kind].has(externalId) ? "updated" : "created"] += 1;
    };
    for (const dimension of plan.dimensions) {
      countOnce("definitions", dimension.definitionExternalId);
      for (const term of dimension.terms) {
        countOnce("terms", term.externalId);
      }
      countOnce("assignments", dimension.assignmentExternalId);
    }
    return counters;
  }

  async syncProductAttributePlan(plan, productId) {
    if (!this.genericIndexes) throw new Error("Generic attribute indexes are not loaded");
    const resolvedDimensions = new Map();
    const counters = { created: 0, updated: 0 };

    for (const dimension of plan.dimensions) {
      let definitionId = this.genericDefinitionCache.get(dimension.definitionExternalId);
      if (!definitionId) {
        const result = await this.upsert({
          endpoint: "/product-attributes",
          externalId: dimension.definitionExternalId,
          payload: G.definitionPayload(dimension, productId),
          index: this.genericIndexes.definitions,
        });
        definitionId = result.id;
        counters[result.mode] += 1;
        if (dimension.scope === "Global") {
          this.genericDefinitionCache.set(dimension.definitionExternalId, definitionId);
        }
      }

      const resolvedTerms = new Map();
      const assignmentTermIds = [];
      for (const term of dimension.terms) {
        let termId = dimension.scope === "Global" ? this.genericTermCache.get(term.externalId) : null;
        if (!termId) {
          const result = await this.upsert({
            endpoint: "/product-attribute-terms",
            externalId: term.externalId,
            payload: G.termPayload(term, definitionId),
            index: this.genericIndexes.terms,
          });
          termId = result.id;
          counters[result.mode] += 1;
          if (dimension.scope === "Global") this.genericTermCache.set(term.externalId, termId);
        }
        assignmentTermIds.push(termId);

        let legacyId = null;
        if (dimension.legacyProjection === "Color") {
          legacyId = await this.resolveAttributeId({
            type: "color",
            title: term.title,
            colorCode: term.colorCode,
            externalId: term.externalId,
          });
        } else if (dimension.legacyProjection === "Size") {
          legacyId = await this.resolveAttributeId({
            type: "size",
            title: term.title,
            externalId: term.externalId,
          });
        }

        resolvedTerms.set(term.sourceKey, { ...term, id: termId, legacyId });
      }

      const assignmentResult = await this.upsert({
        endpoint: "/product-attribute-assignments",
        externalId: dimension.assignmentExternalId,
        payload: G.assignmentPayload(dimension, productId, definitionId, assignmentTermIds),
        index: this.genericIndexes.assignments,
      });
      counters[assignmentResult.mode] += 1;

      resolvedDimensions.set(dimension.sourceKey, {
        ...dimension,
        definitionId,
        assignmentId: assignmentResult.id,
        resolvedTerms,
      });
    }

    return { resolvedDimensions, counters };
  }

  /**
   * Upsert a product-stock record for a variation by external_id (`stock_<vid>`).
   * @returns {Promise<"created"|"updated">}
   */
  async upsertStock({ externalId, count, variationId, stockIndex, sourceTimestamps = null }) {
    const payload = {
      Count: count,
      product_variation: variationId,
      external_id: externalId,
      external_source: "woocommerce",
    };
    const result = await this.upsert({
      endpoint: "/product-stocks",
      externalId,
      payload,
      index: stockIndex,
      sourceTimestamps,
    });
    return result.mode;
  }

  async findProductSizeHelper(productId) {
    const response = await this.http.get("/product-size-helpers", {
      params: {
        "filters[product][id][$eq]": productId,
        "pagination[pageSize]": 1,
      },
    });
    const data = response.data?.data;
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  }

  /**
   * Mirror the legacy size-guide helper behavior for a product.
   * @param {number} productId
   * @param {string[][] | null} helperMatrix
   * @returns {Promise<"created"|"updated"|"deleted"|"unchanged">}
   */
  async syncProductSizeHelper(productId, helperMatrix, sourceTimestamps = null) {
    const existing = await this.findProductSizeHelper(productId);
    const requestConfig = { headers: sourceTimestampHeaders(sourceTimestamps) };

    if (!helperMatrix) {
      if (existing) {
        await this.http.delete(`/product-size-helpers/${existing.id}`);
        return "deleted";
      }
      return "unchanged";
    }

    if (existing) {
      await this.http.put(`/product-size-helpers/${existing.id}`, {
        data: { Helper: helperMatrix },
      }, requestConfig);
      return "updated";
    }

    await this.http.post("/product-size-helpers", {
      data: {
        Helper: helperMatrix,
        product: productId,
      },
    }, requestConfig);
    return "created";
  }

  /**
   * Record a prior product slug so the storefront can 301 it to the canonical
   * Slug. Idempotent on the unique Slug field.
   */
  async ensureProductSlugAlias(fromSlug, productId) {
    const slug = String(fromSlug ?? "");
    if (!slug || !productId) return "unchanged";
    try {
      await this.http.post("/product-slug-aliases", {
        data: { Slug: slug, product: productId },
      });
      return "created";
    } catch (error) {
      const status = error.response?.status;
      if (status !== 400 && status !== 409) throw error;
      const response = await this.http.get("/product-slug-aliases", {
        params: {
          "filters[Slug][$eq]": slug,
          "pagination[pageSize]": 1,
        },
      });
      const row = response.data?.data?.[0];
      if (!row?.id) throw error;
      await this.http.put(`/product-slug-aliases/${row.id}`, {
        data: { product: productId },
      });
      return "updated";
    }
  }

  /**
   * Upsert PLP/category SEO editorial through the bounded category-editorial API.
   * Retired generic `/product-category-contents` CRUD is not a fallback.
   *
   * @param {number} categoryId
   * @param {{ Title:string, Paragraph:string, Content:string, IsPublished:boolean, IsRTL:boolean }} editorial
   * @returns {Promise<"created"|"updated">}
   */
  async upsertCategoryEditorial(categoryId, editorial) {
    const editable = await this.http.get(`/category-editorial/${categoryId}`);
    const current = editable.data?.data?.editorial || null;
    const body = {
      data: editorial,
      ...(current?.updatedAt ? { expectedUpdatedAt: current.updatedAt } : {}),
    };
    try {
      await this.http.put(`/category-editorial/${categoryId}`, body);
      return current ? "updated" : "created";
    } catch (error) {
      if (error.response?.status !== 409) throw error;
      const retry = await this.http.get(`/category-editorial/${categoryId}`);
      const latest = retry.data?.data?.editorial || null;
      await this.http.put(`/category-editorial/${categoryId}`, {
        data: editorial,
        expectedUpdatedAt: latest?.updatedAt,
      });
      return "updated";
    }
  }
}

module.exports = StrapiRepo;
