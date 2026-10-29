import { act, fireEvent, render, screen } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { parseAsString, useQueryState } from "nuqs";
import { useState, type ReactNode } from "react";
import type { UrlUpdateEvent } from "nuqs/adapters/testing";
import ProvinceCityField from "@/components/SuperAdmin/UpsertPage/ContentWrapper/Fields/ProvinceCityField";
import { apiClient } from "@/services";
import { useOrderDeliverySearch } from "../useOrderDeliverySearch";

jest.mock("@/services", () => ({ apiClient: { get: jest.fn() } }));

function StatefulAdapter({ children, onUrlUpdate }: {
  children: ReactNode;
  onUrlUpdate: (event: UrlUpdateEvent) => void;
}) {
  const [searchParams, setSearchParams] = useState("?page=4");
  return (
    <NuqsTestingAdapter
      searchParams={searchParams}
      resetUrlUpdateQueueOnMount={false}
      onUrlUpdate={(event) => {
        setSearchParams(event.searchParams.toString());
        onUrlUpdate(event);
      }}
    >
      {children}
    </NuqsTestingAdapter>
  );
}

function Harness({ withCity = false }: { withCity?: boolean }) {
  const filters = useOrderDeliverySearch();
  const [, setPage] = useQueryState("page", parseAsString.withDefault("1"));
  return (
    <>
      {withCity && (
        <ProvinceCityField
          provinceValue={filters.draft.provinceId}
          cityValue={filters.draft.cityId}
          onProvinceChange={(value) => filters.change("provinceId", value)}
          onCityChange={(value) => filters.change("cityId", value)}
        />
      )}
      <input
        aria-label="کد محصول"
        value={filters.draft.productCode}
        onChange={(e) => filters.change("productCode", e.target.value)}
      />
      <button onClick={filters.clear}>پاک کردن</button>
      <button onClick={() => void setPage("2")}>صفحه بعد</button>
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

  it("keeps selected city IDs with product drafts through debounce and page changes", async () => {
    (apiClient.get as jest.Mock).mockImplementation(async (url: string) => ({
      data: url.startsWith("/shipping-provinces")
        ? [{ id: 20, attributes: { Title: "گلستان" } }, { id: 21, attributes: { Title: "تهران" } }]
        : url.includes("=20")
          ? [{ id: 325, attributes: { Title: "گرگان" } }]
          : [{ id: 1, attributes: { Title: "تهران" } }],
    }));
    const update = jest.fn();
    await act(async () => {
      render(
        <StatefulAdapter onUrlUpdate={update}>
          <Harness withCity />
        </StatefulAdapter>,
      );
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "استان" }), {
        target: { value: "20" },
      });
    });
    fireEvent.change(screen.getByRole("combobox", { name: "شهر" }), {
      target: { value: "325" },
    });
    fireEvent.change(screen.getByLabelText("کد محصول"), { target: { value: "مانتو" } });
    await act(async () => { jest.advanceTimersByTime(560); });
    const selected = update.mock.calls.at(-1)[0].searchParams;
    expect(selected.get("provinceId")).toBe("20");
    expect(selected.get("cityId")).toBe("325");
    expect(selected.get("productCode")).toBe("مانتو");
    expect(selected.get("page")).toBeNull();
    expect(screen.getByRole("combobox", { name: "شهر" })).toHaveValue("325");
    expect(screen.getByRole("status")).toHaveTextContent('"cityId":"325"');

    fireEvent.click(screen.getByText("صفحه بعد"));
    await act(async () => { jest.advanceTimersByTime(60); });
    expect(update.mock.calls.at(-1)[0].searchParams.get("cityId")).toBe("325");
    expect(update.mock.calls.at(-1)[0].searchParams.get("page")).toBe("2");
    expect(screen.getByRole("combobox", { name: "شهر" })).toHaveValue("325");

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "استان" }), {
        target: { value: "21" },
      });
    });
    expect(screen.getByRole("combobox", { name: "شهر" })).toHaveValue("");
    await act(async () => { jest.advanceTimersByTime(560); });
    expect(update.mock.calls.at(-1)[0].searchParams.get("provinceId")).toBe("21");
    expect(update.mock.calls.at(-1)[0].searchParams.get("cityId")).toBeNull();
    expect(update.mock.calls.at(-1)[0].searchParams.get("productCode")).toBe("مانتو");
  });
});
