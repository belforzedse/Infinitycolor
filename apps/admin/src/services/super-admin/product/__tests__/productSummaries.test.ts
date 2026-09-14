/**
 * Regression tests for the homepage picker's product lookup.
 *
 * The failure was silent and position-dependent: Strapi's default pageSize is 25 and
 * it pages by id, so a 26-id curated section came back one product short — always the
 * HIGHEST id — and the picker drew that row as `محصول #<id>` with a blank thumbnail
 * while the product itself was Active and rendering fine on the storefront.
 */
jest.mock("@/services", () => ({
  apiClient: { get: jest.fn() },
}));

jest.mock("@/utils/resolveAssetUrl", () => ({
  __esModule: true,
  default: (url: string) => url,
}));

import { apiClient } from "@/services";
import { getProductSummariesByIds } from "../get";

const mockGet = apiClient.get as jest.Mock;

/** The 26 ids of the real «جدیدترین ها» section; 4750 is the largest. */
const IDS = [
  4578, 4632, 4597, 4744, 4750, 4616, 4748, 4631, 4689, 4596, 4742, 4588, 4743, 2873,
  4315, 1084, 4624, 4475, 4577, 4687, 4671, 4617, 4745, 4681, 4747, 4746,
];

function rowsFor(ids: number[]) {
  return { data: ids.map((id) => ({ id, attributes: { Title: `product-${id}` } })) };
}

function queriedIds(call: number): number[] {
  const url: string = mockGet.mock.calls[call][0];
  const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  return [...qs.entries()]
    .filter(([k]) => k.startsWith("filters[id][$in]"))
    .map(([, v]) => Number(v));
}

function limitFor(call: number): number {
  const url: string = mockGet.mock.calls[call][0];
  return Number(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("pagination[limit]"));
}

beforeEach(() => mockGet.mockReset());

describe("getProductSummariesByIds", () => {
  it("asks for at least as many rows as it requests ids", async () => {
    mockGet.mockResolvedValue(rowsFor(IDS));
    await getProductSummariesByIds(IDS);

    // Without this the server falls back to pageSize 25 and drops id 4750.
    expect(limitFor(0)).toBeGreaterThanOrEqual(IDS.length);
  });

  it("returns every requested product, including the highest id", async () => {
    // Answers the way Strapi actually does: apply pagination[limit] (defaulting to
    // 25) to the ids sorted ascending, so an unlimited 26-id ask loses id 4750.
    mockGet.mockImplementation((url: string) => {
      const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const asked = [...qs.entries()]
        .filter(([k]) => k.startsWith("filters[id][$in]"))
        .map(([, v]) => Number(v))
        .sort((a, b) => a - b);
      const limit = Math.min(Number(qs.get("pagination[limit]") ?? 25) || 25, 100);
      return Promise.resolve(rowsFor(asked.slice(0, limit)));
    });

    const result = await getProductSummariesByIds(IDS);

    expect(result).toHaveLength(IDS.length);
    expect(result.map((r) => r.id)).toContain(4750);
  });

  it("preserves the caller's order rather than the server's", async () => {
    // Strapi answers in id order; the picker's order is the curated order.
    mockGet.mockResolvedValue(rowsFor([...IDS].sort((a, b) => a - b)));
    const result = await getProductSummariesByIds(IDS);

    expect(result.map((r) => r.id)).toEqual(IDS);
  });

  it("batches past Strapi's maxLimit instead of asking for one oversized page", async () => {
    const many = Array.from({ length: 250 }, (_, i) => i + 1);
    mockGet.mockImplementation((url: string) => {
      const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const ids = [...qs.entries()]
        .filter(([k]) => k.startsWith("filters[id][$in]"))
        .map(([, v]) => Number(v));
      return Promise.resolve(rowsFor(ids));
    });

    const result = await getProductSummariesByIds(many);

    expect(mockGet).toHaveBeenCalledTimes(3);
    // maxLimit is 100 (apps/backend/config/api.ts); a bigger ask truncates silently.
    for (let i = 0; i < 3; i++) expect(limitFor(i)).toBeLessThanOrEqual(100);
    expect(queriedIds(0)).toHaveLength(100);
    expect(result.map((r) => r.id)).toEqual(many);
  });

  it("makes no request for an empty list", async () => {
    expect(await getProductSummariesByIds([])).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
