/**
 * Category cache correctness.
 *
 * Three outcomes must stay distinct: a successful response with categories, a legitimately
 * empty successful response, and a failed request. Collapsing the third into the second —
 * and then caching it — turned one transient backend blip into an apparently empty catalog
 * for the rest of the browser session.
 *
 * The hook's caches are module-level and deliberately shared across mounts (that is the
 * dedupe mechanism under test), so each test uses its own cache key rather than resetting
 * modules — re-importing the module would also re-import React and break its dispatcher.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { getProductCategories } from "@/services/product/categories";
import { useProductCategories } from "../useProductCategories";

jest.mock("@/services/product/categories", () => ({
  getProductCategories: jest.fn(),
  getNavbarProductCategories: jest.fn(),
}));

const mockedGetProductCategories = getProductCategories as jest.Mock;

const category = (id: number, slug: string) => ({
  id,
  name: slug,
  slug,
  imageUrl: null,
  imageAlt: slug,
  megaMenuImageUrl: null,
  megaMenuImageAlt: slug,
  parentId: null,
  isMainCategory: true,
});

let keySeed = 0;
/** A distinct cache key per test, so tests never share cached data or in-flight requests. */
const freshOptions = () => ({ allowedNameSubstrings: [`key-${(keySeed += 1)}`] as const });

describe("useProductCategories", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("exposes successfully fetched categories", async () => {
    const options = freshOptions();
    mockedGetProductCategories.mockResolvedValue([category(1, "bags")]);

    const { result } = renderHook(() => useProductCategories(options));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.categories.map((c) => c.slug)).toEqual(["bags"]);
    expect(result.current.error).toBeNull();
  });

  it("treats a legitimately empty response as real data and caches it", async () => {
    const options = freshOptions();
    mockedGetProductCategories.mockResolvedValue([]);

    const { result } = renderHook(() => useProductCategories(options));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.categories).toEqual([]);
    expect(result.current.error).toBeNull();

    renderHook(() => useProductCategories(options));
    await waitFor(() => expect(mockedGetProductCategories).toHaveBeenCalledTimes(1));
  });

  it("surfaces an initial failure instead of caching an invented empty list", async () => {
    const options = freshOptions();
    mockedGetProductCategories.mockRejectedValue(new Error("backend down"));

    const { result } = renderHook(() => useProductCategories(options));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.categories).toEqual([]);
  });

  it("recovers on a later mount after an initial failure", async () => {
    const options = freshOptions();
    mockedGetProductCategories.mockRejectedValueOnce(new Error("backend down"));

    const first = renderHook(() => useProductCategories(options));
    await waitFor(() => expect(first.result.current.error).not.toBeNull());

    // The rejected in-flight promise must have been evicted; otherwise every later mount
    // would await that same failure for the life of the tab.
    mockedGetProductCategories.mockResolvedValue([category(1, "bags")]);
    const second = renderHook(() => useProductCategories(options));

    await waitFor(() =>
      expect(second.result.current.categories.map((c) => c.slug)).toEqual(["bags"]),
    );
    expect(second.result.current.error).toBeNull();
  });

  it("keeps known-good categories when a later refresh fails", async () => {
    const options = freshOptions();
    mockedGetProductCategories.mockResolvedValueOnce([category(1, "bags")]);

    const first = renderHook(() => useProductCategories(options));
    await waitFor(() =>
      expect(first.result.current.categories.map((c) => c.slug)).toEqual(["bags"]),
    );

    // A failing request for a different key must not disturb the good data already held
    // for this one, and the failing hook must not render an empty catalog as if it were
    // a real answer.
    mockedGetProductCategories.mockRejectedValue(new Error("backend down"));
    const failingOptions = freshOptions();
    const failing = renderHook(() => useProductCategories(failingOptions));
    await waitFor(() => expect(failing.result.current.error).not.toBeNull());

    const remounted = renderHook(() => useProductCategories(options));
    await waitFor(() =>
      expect(remounted.result.current.categories.map((c) => c.slug)).toEqual(["bags"]),
    );
    expect(remounted.result.current.error).toBeNull();
  });

  it("does not fetch when initial data is supplied", async () => {
    const options = { ...freshOptions(), initial: [category(9, "seed")] };
    const { result } = renderHook(() => useProductCategories(options));

    expect(result.current.categories.map((c) => c.slug)).toEqual(["seed"]);
    expect(mockedGetProductCategories).not.toHaveBeenCalled();
  });
});
