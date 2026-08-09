import { RETRY_CONFIG } from "@/constants/api";
import {
  fetchAllPdpEligibleProducts,
  getPdpStaticParamsProducts,
  getSitemapEligibleProducts,
} from "../catalog";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function productRow(id: number, slug: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    attributes: { Slug: slug, Status: "Active", updatedAt: "2026-08-01T00:00:00.000Z", ...extra },
  };
}

describe("fetchAllPdpEligibleProducts", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("paginates through every page and returns the full product set", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        jsonResponse({
          data: [productRow(1, "product-one"), productRow(2, "product-two")],
          meta: { pagination: { pageCount: 2 } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [productRow(3, "product-three")],
          meta: { pagination: { pageCount: 2 } },
        }),
      );

    const products = await fetchAllPdpEligibleProducts();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(products.map((p) => p.id).sort()).toEqual([1, 2, 3]);
    expect(products.find((p) => p.id === 1)?.slug).toBe("product-one");
  });

  it("does not truncate at a single page — no arbitrary cap", async () => {
    const pageCount = 5;
    for (let page = 1; page <= pageCount; page += 1) {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        jsonResponse({
          data: [productRow(page, `product-${page}`)],
          meta: { pagination: { pageCount } },
        }),
      );
    }

    const products = await fetchAllPdpEligibleProducts();

    expect(global.fetch).toHaveBeenCalledTimes(pageCount);
    expect(products).toHaveLength(pageCount);
  });

  it("keeps the first-seen product on a duplicate canonical slug and excludes the rest", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse({
        data: [
          productRow(10, "same-slug"),
          productRow(11, "same-slug"),
          productRow(12, "unique-slug"),
        ],
        meta: { pagination: { pageCount: 1 } },
      }),
    );

    const products = await fetchAllPdpEligibleProducts();

    expect(products).toHaveLength(2);
    expect(products.find((p) => p.slug === "same-slug")?.id).toBe(10);
  });

  it("excludes slugs that cannot survive as a single route segment", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      jsonResponse({
        data: [
          productRow(20, null), // missing
          productRow(21, ""), // empty
          productRow(22, "has/slash"), // path separator
          productRow(23, "bad-%zz-encoding"), // invalid percent-escape, throws on decode
          productRow(24, "good-slug"),
        ],
        meta: { pagination: { pageCount: 1 } },
      }),
    );

    const products = await fetchAllPdpEligibleProducts();

    expect(products).toHaveLength(1);
    expect(products[0].slug).toBe("good-slug");
  });

  it("retries a transient (retryable) failure and succeeds", async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({}, 503)).mockResolvedValueOnce(
      jsonResponse({
        data: [productRow(1, "product-one")],
        meta: { pagination: { pageCount: 1 } },
      }),
    );

    const pending = fetchAllPdpEligibleProducts();
    // Attach immediately so the eventual resolution never has a tick where
    // the promise is settled but nothing is listening.
    const assertion = pending.then((products) => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(products).toHaveLength(1);
    });
    await jest.advanceTimersByTimeAsync(RETRY_CONFIG.maxDelay);
    await assertion;
  });

  it("throws immediately on a non-retryable status without retrying", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({}, 400));

    await expect(fetchAllPdpEligibleProducts()).rejects.toThrow(/400/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries on a persistently retryable failure", async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, 503));

    const pending = fetchAllPdpEligibleProducts();
    // Attach the rejection assertion immediately — before advancing timers —
    // so the rejection is never briefly unhandled.
    const assertion = expect(pending).rejects.toThrow(/503/);
    await jest.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(global.fetch).toHaveBeenCalledTimes(RETRY_CONFIG.maxRetries + 1);
  });
});

describe("getPdpStaticParamsProducts / getSitemapEligibleProducts", () => {
  it("both pass through the eligible product set unchanged (no noindex flag exists yet)", () => {
    const products = [
      { id: 1, slug: "a", status: "Active", updatedAt: "2026-08-01T00:00:00.000Z" },
    ];
    expect(getPdpStaticParamsProducts(products)).toEqual(products);
    expect(getSitemapEligibleProducts(products)).toEqual(products);
  });
});
