import {
  buildBlogPaths,
  buildCategoryPaths,
  buildHomePaths,
  buildProductPaths,
  encodeStorefrontPath,
  loadEdgeCacheConfig,
} from "../edgeCache";

describe("encodeStorefrontPath", () => {
  // 1,642 of 3,442 slugs are non-ASCII. Strapi stores them raw; a browser always
  // sends them encoded; the gateway keys on $request_uri. Refreshing with the
  // raw bytes writes an entry under a key nobody requests, so the purge reports
  // success and the stale page keeps being served.
  it("encodes a Persian slug the way a browser would", () => {
    expect(encodeStorefrontPath("/pdp/تیشرت-قلبی-w0016")).toBe(
      "/pdp/%D8%AA%DB%8C%D8%B4%D8%B1%D8%AA-%D9%82%D9%84%D8%A8%DB%8C-w0016",
    );
  });

  it("is idempotent, so an already-encoded path is not double-encoded", () => {
    const once = encodeStorefrontPath("/pdp/تیشرت");
    expect(encodeStorefrontPath(once)).toBe(once);
  });

  it("leaves ASCII slugs alone", () => {
    expect(encodeStorefrontPath("/pdp/plain-slug")).toBe("/pdp/plain-slug");
  });

  it("does not encode the query separator", () => {
    expect(encodeStorefrontPath("/plp?page=2")).toBe("/plp?page=2");
  });
});

describe("path sets per event", () => {
  it("invalidates everything a product appears on", () => {
    const paths = buildProductPaths({ slug: "shirt", categorySlugs: ["tops", "new"] });

    expect(paths).toEqual(
      expect.arrayContaining([
        "/pdp/shirt",
        "/",
        "/plp",
        "/plp/category/tops",
        "/plp/category/new",
        "/sitemap.xml",
      ]),
    );
  });

  // A rename leaves a cached 200 under the old name that no longer exists.
  it("invalidates both names when a slug changes", () => {
    const paths = buildProductPaths({ slug: "new-name", previousSlug: "old-name" });

    expect(paths).toContain("/pdp/new-name");
    expect(paths).toContain("/pdp/old-name");
  });

  it("never emits duplicates", () => {
    const paths = buildProductPaths({
      slug: "shirt",
      previousSlug: "shirt",
      categorySlugs: ["tops", "tops", "", null],
    });

    expect(new Set(paths).size).toBe(paths.length);
  });

  it("skips empty slugs rather than purging /pdp/", () => {
    const paths = buildProductPaths({ slug: "", previousSlug: null });
    expect(paths.some((path) => path.startsWith("/pdp"))).toBe(false);
  });

  it("covers the listing and the blog surfaces", () => {
    expect(buildCategoryPaths("tops")).toEqual(expect.arrayContaining(["/plp/category/tops", "/plp"]));
    expect(buildBlogPaths("a-post")).toEqual(
      expect.arrayContaining(["/a-post", "/blog", "/blog/feed.xml", "/sitemap.xml"]),
    );
    expect(buildHomePaths()).toContain("/");
  });
});

describe("loadEdgeCacheConfig", () => {
  it("is disabled unless explicitly turned on", () => {
    expect(loadEdgeCacheConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(
      loadEdgeCacheConfig({ EDGE_PURGE_ENABLED: "false" } as NodeJS.ProcessEnv).enabled,
    ).toBe(false);
    expect(
      loadEdgeCacheConfig({ EDGE_PURGE_ENABLED: "true" } as NodeJS.ProcessEnv).enabled,
    ).toBe(true);
  });

  it("derives the Host header the gateway routes on from the public origin", () => {
    const config = loadEdgeCacheConfig({
      STOREFRONT_PUBLIC_ORIGIN: "https://new.infinitycolor.co/",
    } as NodeJS.ProcessEnv);

    expect(config.storefrontOrigin).toBe("https://new.infinitycolor.co");
    expect(config.storefrontHost).toBe("new.infinitycolor.co");
  });

  it("falls back to a sane batch size for a nonsense value", () => {
    expect(loadEdgeCacheConfig({ ARVAN_PURGE_BATCH: "nope" } as NodeJS.ProcessEnv).purgeBatch).toBe(30);
    expect(loadEdgeCacheConfig({ ARVAN_PURGE_BATCH: "0" } as NodeJS.ProcessEnv).purgeBatch).toBe(30);
  });
});
