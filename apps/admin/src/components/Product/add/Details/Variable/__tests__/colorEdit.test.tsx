import { render, screen, waitFor } from "@testing-library/react";
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
jest.mock("@/services/product/variation-options", () => ({
  searchColors: jest.fn().mockResolvedValue([
    { id: "1", title: "قرمز", colorCode: "#ff0000" },
    { id: "2", title: "آبی", colorCode: "#0000ff" },
  ]),
}));
jest.mock("@/hooks/useCan", () => ({ useCan: () => true }));
jest.mock("@/lib/api-cache", () => ({ apiCache: { clearByPattern: jest.fn() } }));
const mockToastError = jest.fn();
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: (...args: unknown[]) => mockToastError(...args) },
}));

import ProductVariables from "../index";

const variation = {
  id: 11,
  attributes: {
    SKU: "RED-S",
    Price: 100,
    IsPublished: true,
    product: { data: { id: 5 } },
    product_variation_color: { data: { id: 1, attributes: { Title: "قرمز", ColorCode: "#ff0000" } } },
    product_variation_size: { data: { id: 21, attributes: { Title: "S" } } },
    product_stock: { data: { id: 31, attributes: { Count: 4 } } },
    general_discounts: { data: [] },
    selected_attribute_terms: { data: [] },
  },
};

async function openEditor(onVariationsChanged = jest.fn()) {
  render(<ProductVariables productId={5} onVariationsChanged={onVariationsChanged} />);
  const [edit] = await screen.findAllByRole("button", { name: "ویرایش" });
  await userEvent.click(edit);
  return onVariationsChanged;
}

const save = () => userEvent.click(screen.getByRole("button", { name: "ذخیره تغییرات" }));

describe("editing one variation's colour", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ data: [variation] });
    mockPut.mockResolvedValue({ data: {} });
  });

  it("sends the new colour and refreshes the colour chips", async () => {
    const onVariationsChanged = await openEditor();

    await userEvent.type(screen.getByPlaceholderText("تغییر به رنگ دیگر..."), "آ");
    await userEvent.click(await screen.findByText("آبی"));
    await save();

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith("/products/5/editor/variations/11", {
        data: { product_variation_color: 2 },
      }, { retries: 0 }),
    );
    expect(onVariationsChanged).toHaveBeenCalled();
    expect(await screen.findAllByText("S - آبی")).not.toHaveLength(0);
  });

  it("leaves the colour out when it did not change", async () => {
    const onVariationsChanged = await openEditor();
    await save();

    await waitFor(() => expect(mockPut).toHaveBeenCalled());
    const [, body] = mockPut.mock.calls[0];
    expect(body.data).not.toHaveProperty("product_variation_color");
    expect(onVariationsChanged).not.toHaveBeenCalled();
  });

  it("says why when the product already has that combination", async () => {
    mockPut.mockRejectedValueOnce({
      status: 409,
      message: "این محصول از قبل تنوعی با همین رنگ و ویژگی‌ها دارد",
      errorCode: "VARIATION_SIGNATURE_EXISTS",
    });
    await openEditor();

    await userEvent.type(screen.getByPlaceholderText("تغییر به رنگ دیگر..."), "آ");
    await userEvent.click(await screen.findByText("آبی"));
    await save();

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("این محصول از قبل تنوعی با همین رنگ و ویژگی‌ها دارد"),
    );
  });
});
