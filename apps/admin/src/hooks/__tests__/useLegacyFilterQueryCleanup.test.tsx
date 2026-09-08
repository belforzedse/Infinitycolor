import { renderHook } from "@testing-library/react";

const mockSetLegacyUrlFilters = jest.fn().mockResolvedValue(null);

jest.mock("nuqs", () => ({
  useQueryState: () => [[], mockSetLegacyUrlFilters],
}));

import { useLegacyFilterQueryCleanup } from "../useLegacyFilterQueryCleanup";

function setLocation(path: string) {
  window.history.replaceState({}, "", path);
}

describe("useLegacyFilterQueryCleanup", () => {
  beforeEach(() => {
    mockSetLegacyUrlFilters.mockClear();
    setLocation("/products");
  });

  it("does not update the URL when the retired query is absent", () => {
    renderHook(() => useLegacyFilterQueryCleanup());

    expect(mockSetLegacyUrlFilters).not.toHaveBeenCalled();
  });

  it.each(["?filter=", "?filter=%7Bmalformed", "?filter=%5B%5D"])(
    "clears a present legacy value exactly once for %s",
    (query) => {
      setLocation(`/products${query}`);
      const { rerender } = renderHook(() => useLegacyFilterQueryCleanup());

      rerender();

      expect(mockSetLegacyUrlFilters).toHaveBeenCalledTimes(1);
      expect(mockSetLegacyUrlFilters).toHaveBeenCalledWith(null, {
        history: "replace",
      });
    },
  );

  it("does not interfere with normal detail-page navigation", () => {
    setLocation("/products/42");

    renderHook(() => useLegacyFilterQueryCleanup());

    expect(mockSetLegacyUrlFilters).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/products/42");
  });
});
