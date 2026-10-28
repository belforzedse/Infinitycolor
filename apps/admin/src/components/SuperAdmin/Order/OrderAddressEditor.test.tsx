import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrderAddressEditor from "./OrderAddressEditor";
import { apiClient } from "@/services";
import toast from "react-hot-toast";

jest.mock("@/services", () => ({
  apiClient: { put: jest.fn() },
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));
jest.mock("@/components/Kits/Modal", () => ({
  __esModule: true,
  default: ({ isOpen, children, title }: any) =>
    isOpen ? <section aria-label={title}>{children}</section> : null,
}));
jest.mock(
  "@/components/SuperAdmin/UpsertPage/ContentWrapper/Fields/ProvinceCityField",
  () => ({
    __esModule: true,
    default: ({ provinceValue, cityValue }: any) => (
      <div data-testid="province-city">{provinceValue}:{cityValue}</div>
    ),
  }),
);

const order = {
  id: 10,
  orderDate: new Date(),
  orderStatus: "Started",
  userId: "4",
  userName: "نام مشتری",
  description: "",
  phoneNumber: "+989111111111",
  addressLine: "نشانی سفارش",
  address: "نشانی سفارش - گرگان - گلستان",
  postalCode: "1234567890",
  recipientName: "گیرنده سفارش",
  recipientPhone: "+989122222222",
  shippingProvinceId: 2,
  shippingCityId: 7,
  paymentGateway: "Wallet",
  createdAt: new Date(),
  updatedAt: new Date(),
  contractStatus: "Finished" as const,
  items: [],
  shipping: 0,
  subtotal: 0,
  total: 0,
  reserveGroupId: "80",
  hasSharedReserveAddress: true,
  anipoSubmittedAt: new Date().toISOString(),
};

describe("OrderAddressEditor", () => {
  beforeEach(() => jest.clearAllMocks());

  it("prefills the current snapshot and warns about grouped and Anipo updates", () => {
    render(<OrderAddressEditor isOpen order={order} onClose={jest.fn()} onSaved={jest.fn()} />);
    expect(screen.getByDisplayValue("گیرنده سفارش")).toBeInTheDocument();
    expect(screen.getByDisplayValue("+989122222222")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1234567890")).toBeInTheDocument();
    expect(screen.getByDisplayValue("نشانی سفارش")).toBeInTheDocument();
    expect(screen.getByTestId("province-city")).toHaveTextContent("2:7");
    expect(screen.getByText(/همه سفارش‌های این ارسال رزروی/)).toBeInTheDocument();
    expect(screen.getByText(/به‌صورت خودکار با آنیپو/)).toBeInTheDocument();
  });

  it("submits only the order recipient fields", async () => {
    (apiClient.put as jest.Mock).mockResolvedValue({
      data: { data: { noChange: false, affectedOrderIds: [10, 11], reserveGroupId: 80, carrierSync: { required: true, status: "pending" } } },
    });
    const onSaved = jest.fn();
    render(<OrderAddressEditor isOpen order={order} onClose={jest.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByDisplayValue("نشانی سفارش"), { target: { value: "نشانی اصلاح‌شده" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیره تغییرات" }));
    await waitFor(() => expect(apiClient.put).toHaveBeenCalledWith(
      "/orders/10/admin/address",
      { data: expect.objectContaining({ fullAddress: "نشانی اصلاح‌شده", shippingCityId: 7 }) },
    ));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ affectedOrderIds: [10, 11] }));
  });

  it("shows the backend's reason when a save is refused", async () => {
    // The admin API client rejects with `{ status, message }`.
    (apiClient.put as jest.Mock).mockRejectedValue({
      status: 400,
      message: "کدپستی باید ۱۰ رقم معتبر باشد",
    });
    render(<OrderAddressEditor isOpen order={order} onClose={jest.fn()} onSaved={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "ذخیره تغییرات" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("کدپستی باید ۱۰ رقم معتبر باشد"),
    );
  });
});
