import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { useAdvancedFiltersUrlState } from "../advancedFiltersUrlState";

const filter = { field: "[Description]", operator: "$containsi", value: "vip" };

function renderFilters(searchParams: string) {
  const updates: UrlUpdateEvent[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={(event) => updates.push(event)}>
      {children}
    </NuqsTestingAdapter>
  );
  const { result } = renderHook(() => useAdvancedFiltersUrlState(), { wrapper });
  return { result, updates };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 100)));

describe("advanced filters in the URL", () => {
  it("reads them from ?af=", () => {
    const { result } = renderFilters(new URLSearchParams({ af: JSON.stringify([filter]) }).toString());
    expect(result.current[0]).toEqual([filter]);
  });

  it("writes a change and page 1 in one update", async () => {
    const { result, updates } = renderFilters("?page=3");

    await act(async () => result.current[1]([filter]));
    await flush();

    expect(updates).toHaveLength(1);
    expect(JSON.parse(decodeURIComponent(updates[0].searchParams.get("af") ?? ""))).toEqual([filter]);
    expect(updates[0].searchParams.has("page")).toBe(false);
    expect(result.current[0]).toEqual([filter]);
  });

  it("drops the key when the filters are cleared", async () => {
    const { result, updates } = renderFilters(
      new URLSearchParams({ af: JSON.stringify([filter]), page: "2" }).toString(),
    );

    await act(async () => result.current[1]([]));
    await flush();

    expect(updates.map((update) => update.queryString)).toEqual([""]);
    expect(result.current[0]).toEqual([]);
  });
});
