import { act, fireEvent, render, screen } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { useOrderDeliverySearch } from "../useOrderDeliverySearch";
function Harness() {
  const filters = useOrderDeliverySearch();
  return (
    <>
      <input
        aria-label="کد محصول"
        value={filters.draft.productCode}
        onChange={(e) => filters.change("productCode", e.target.value)}
      />
      <button onClick={filters.clear}>پاک کردن</button>
      <output>{JSON.stringify(filters.searchFilters)}</output>
    </>
  );
}
describe("URL-backed order delivery filters", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it("restores criteria from the URL without resetting a loaded page", () => {
    const update = jest.fn();
    render(
      <NuqsTestingAdapter
        searchParams="?cityId=7&productCode=Ab-001&postalCode=0123456789&addressText=خیابان&page=4"
        onUrlUpdate={update}
      >
        <Harness />
      </NuqsTestingAdapter>,
    );
    expect(screen.getByLabelText("کد محصول")).toHaveValue("Ab-001");
    expect(screen.getByRole("status")).toHaveTextContent(
      '"postalCode":"0123456789"',
    );
    act(() => jest.advanceTimersByTime(550));
    expect(update).not.toHaveBeenCalled();
  });
  it("debounces 500 ms, writes criteria and page reset together, and cancels pending edits on clear", async () => {
    const update = jest.fn();
    render(
      <NuqsTestingAdapter searchParams="?page=4" onUrlUpdate={update}>
        <Harness />
      </NuqsTestingAdapter>,
    );
    fireEvent.change(screen.getByLabelText("کد محصول"), {
      target: { value: "Ab-001" },
    });
    act(() => jest.advanceTimersByTime(499));
    expect(update).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await act(async () => {
      jest.advanceTimersByTime(60);
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ searchParams: expect.any(URLSearchParams) }),
    );
    expect(update.mock.calls[0][0].searchParams.get("productCode")).toBe(
      "Ab-001",
    );
    expect(update.mock.calls[0][0].searchParams.get("page")).toBeNull();
    fireEvent.change(screen.getByLabelText("کد محصول"), {
      target: { value: "Unsent" },
    });
    fireEvent.click(screen.getByText("پاک کردن"));
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(
      update.mock.calls.at(-1)[0].searchParams.get("productCode"),
    ).toBeNull();
    expect(
      update.mock.calls.some(
        ([event]) => event.searchParams.get("productCode") === "Unsent",
      ),
    ).toBe(false);
  });
  it("cancels URL writes when leaving the orders page", () => {
    const update = jest.fn();
    const view = render(
      <NuqsTestingAdapter onUrlUpdate={update}>
        <Harness />
      </NuqsTestingAdapter>,
    );
    fireEvent.change(screen.getByLabelText("کد محصول"), {
      target: { value: "Unsent" },
    });
    view.unmount();
    act(() => jest.advanceTimersByTime(1000));
    expect(update).not.toHaveBeenCalled();
  });
});
