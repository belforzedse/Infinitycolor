import { act, fireEvent, render, screen } from "@testing-library/react";
import { apiClient } from "@/services";
import Page from "../page";
let mockForm: any;
jest.mock("@/services", () => ({ apiClient: { post: jest.fn() } }));
jest.mock("@/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/components/SuperAdmin/UpsertPage/ContentWrapper/index", () => ({
  __esModule: true,
  default: (props: any) => {
    mockForm = props;
    return null;
  },
}));
jest.mock("@/components/SuperAdmin/Order/UserSearchSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/SuperAdmin/Order/ProductSelectionSection", () => ({
  __esModule: true,
  default: (props: any) => (
    <button
      onClick={() =>
        props.onItemsChange([
          {
            id: 1,
            productId: 2,
            productName: "کالا",
            productCode: "A",
            quantity: 1,
            price: 100,
          },
        ])
      }
    >
      افزودن کالا
    </button>
  ),
}));
jest.mock("@/components/SuperAdmin/Order/SummaryFooter", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/SuperAdmin/Order/Sidebar", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/Kits/ConfirmDialog", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock(
  "@/components/SuperAdmin/UpsertPage/ContentWrapper/Fields/ProvinceCityField",
  () => ({
    __esModule: true,
    default: (props: any) => (
      <button
        onClick={() => {
          props.onProvinceChange("2");
          props.onCityChange("7");
        }}
      >
        انتخاب شهر
      </button>
    ),
  }),
);
it("includes the entered city, address, postal code and recipient in manual creation", async () => {
  (apiClient.post as jest.Mock).mockImplementation(async (url: string) =>
    url.includes("decrement-stock-manual")
      ? { data: { success: true, applied: true } }
      : { data: { id: 10 } },
  );
  render(<Page />);
  fireEvent.click(screen.getByText("افزودن کالا"));
  fireEvent.click(screen.getByText("انتخاب شهر"));
  await act(async () =>
    mockForm.onSubmit({
      ...mockForm.data,
      userName: "گیرنده",
      phoneNumber: "09120000000",
      address: "خیابان اصلی پلاک ۱۲",
      postalCode: "0123456789",
      total: 100,
    }),
  );
  expect(apiClient.post).toHaveBeenCalledWith(
    "/orders",
    expect.objectContaining({
      data: expect.objectContaining({
        deliveryAddress: {
          shippingCityId: 7,
          fullAddress: "خیابان اصلی پلاک ۱۲",
          postalCode: "0123456789",
          recipientName: "گیرنده",
          recipientPhone: "09120000000",
        },
      }),
    }),
  );
});
