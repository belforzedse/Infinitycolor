import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockGet = jest.fn();
const mockPut = jest.fn();
jest.mock("@/services", () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/services/product/variation-options", () => ({ searchColors: jest.fn() }));
jest.mock("@/hooks/useCan", () => ({ useCan: () => true }));
jest.mock("@/lib/api-cache", () => ({ apiCache: { clearByPattern: jest.fn() } }));
const mockToastError = jest.fn();
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: (...args: unknown[]) => mockToastError(...args) },
}));

import ProductVariables from "../index";

const variation = (id: number, size: string, price: string) => ({
  id,
  attributes: {
    SKU: `SKU-${id}`,
    // Strapi returns bigint prices as strings.
    Price: price,
    IsPublished: true,
    product: { data: { id: 5 } },
    product_variation_size: { data: { id: id + 100, attributes: { Title: size } } },
    product_stock: { data: { id: id + 200, attributes: { Count: 4 } } },
    general_discounts: { data: [] },
    selected_attribute_terms: { data: [] },
  },
});

// The desktop table and the mobile cards both render; check the table row.
const rowOf = (label: string) =>
  screen
    .getAllByText(label)
    .map((element) => element.closest("tr"))
    .find(Boolean) as HTMLElement;

describe("variation prices in the admin table", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ data: [variation(11, "S", "3499000"), variation(12, "M", "0")] });
    mockPut.mockResolvedValue({ data: {} });
  });

  it("marks a variation without a price instead of showing 0 Toman", async () => {
    render(<ProductVariables productId={5} />);
    await screen.findAllByText("M");

    expect(within(rowOf("M")).getByTestId("variation-unpriced")).toHaveTextContent("بدون قیمت");
    expect(within(rowOf("S")).queryByTestId("variation-unpriced")).not.toBeInTheDocument();
  });

  it("shows the new price only on rows that saved, and names the rows that did not", async () => {
    mockPut.mockImplementation(async (url: string) => {
      if (url === "/products/5/editor/variations/12") {
        throw { status: 400, message: "قیمت تخفیف باید کمتر از قیمت اصلی باشد" };
      }
      return { data: {} };
    });
    render(<ProductVariables productId={5} />);
    await screen.findAllByText("M");

    await userEvent.click(screen.getByRole("button", { name: "انتخاب همه" }));
    await userEvent.click(screen.getByRole("button", { name: "ویرایش گروهی" }));
    await userEvent.type(screen.getAllByPlaceholderText("بدون تغییر")[0], "3599000");
    await userEvent.click(screen.getByRole("button", { name: "ثبت تغییرات" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("M: ذخیره انجام نشد"),
        expect.anything(),
      ),
    );
    expect(within(rowOf("S")).getByText(/3,599,000/)).toBeInTheDocument();
    expect(within(rowOf("M")).getByTestId("variation-unpriced")).toBeInTheDocument();
  });
});
