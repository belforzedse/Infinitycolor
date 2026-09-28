import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProvinceCityField from "../ProvinceCityField";
import { apiClient } from "@/services";

jest.mock("@/services", () => ({
  apiClient: { get: jest.fn() },
}));

const get = apiClient.get as jest.Mock;

const provinces = {
  data: [
    { id: 20, attributes: { Title: "گلستان" } },
    { id: 21, attributes: { Title: "تهران" } },
  ],
};
const citiesOf: Record<string, unknown> = {
  "20": { data: [{ id: 325, attributes: { Title: "گرگان" } }] },
  "21": { data: [{ id: 1, attributes: { Title: "تهران" } }] },
};

const routeGets = () =>
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("/shipping-provinces")) return provinces;
    const match = url.match(/\[\$eq\]=(\d+)/);
    if (url.startsWith("/shipping-cities") && match) return citiesOf[match[1]];
    throw { status: 404, message: "Not Found" };
  });

describe("ProvinceCityField", () => {
  beforeEach(() => get.mockReset());

  it("lists provinces from the Strapi collection and the current city of a pre-filled province", async () => {
    routeGets();
    render(
      <ProvinceCityField
        provinceValue="20"
        cityValue="325"
        onProvinceChange={jest.fn()}
        onCityChange={jest.fn()}
      />,
    );

    const province = screen.getByRole("combobox", { name: "استان" }) as HTMLSelectElement;
    const city = screen.getByRole("combobox", { name: "شهر" }) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByRole("option", { name: "گرگان" })).toBeInTheDocument());

    expect(screen.getByRole("option", { name: "گلستان" })).toBeInTheDocument();
    expect(province.value).toBe("20");
    expect(city.value).toBe("325");
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/^\/shipping-provinces\?pagination\[pageSize\]=100/));
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("/shipping-cities?filters[shipping_province][id][$eq]=20"),
    );
  });

  it("reloads cities for a newly chosen province and clears the old city", async () => {
    routeGets();
    const onProvinceChange = jest.fn();
    const onCityChange = jest.fn();
    const { rerender } = render(
      <ProvinceCityField
        provinceValue="20"
        cityValue="325"
        onProvinceChange={onProvinceChange}
        onCityChange={onCityChange}
      />,
    );
    await waitFor(() => expect(screen.getByRole("option", { name: "گلستان" })).toBeInTheDocument());

    fireEvent.change(screen.getByRole("combobox", { name: "استان" }), { target: { value: "21" } });
    expect(onProvinceChange).toHaveBeenCalledWith("21");
    expect(onCityChange).toHaveBeenCalledWith("");

    rerender(
      <ProvinceCityField
        provinceValue="21"
        cityValue=""
        onProvinceChange={onProvinceChange}
        onCityChange={onCityChange}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("option", { name: "تهران" }).some((option) =>
          option.closest("select")?.getAttribute("aria-label") === "شهر",
        ),
      ).toBe(true),
    );
  });

  it("says so when the list can't be loaded, and retries on request", async () => {
    get.mockRejectedValueOnce({ status: 404, message: "Not Found" });
    render(
      <ProvinceCityField
        provinceValue=""
        cityValue=""
        onProvinceChange={jest.fn()}
        onCityChange={jest.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("فهرست استان‌ها دریافت نشد");

    routeGets();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    });
    await waitFor(() => expect(screen.getByRole("option", { name: "گلستان" })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
