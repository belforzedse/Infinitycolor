import { fireEvent, render, screen } from "@testing-library/react";
import { MobileTable, type Order } from "./table";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/components/SuperAdmin/Order/OrderRowActions", () => ({
  __esModule: true,
  default: ({ orderId }: { orderId: string }) => (
    <button type="button" data-testid={`order-actions-${orderId}`}>
      عملیات سفارش
    </button>
  ),
}));

const order = {
  id: "98765432109876543210",
  attributes: {
    Description: "",
    Note: "",
    Status: "Started",
    Date: "2026-09-09T08:15:00.000Z",
    ShippingMethodCode: "anipo",
    ShippingBarcode: "123456789012345678901234567890",
    createdAt: "2026-09-09T08:15:00.000Z",
    updatedAt: "2026-09-09T08:45:00.000Z",
    user: {
      data: {
        id: 42,
        attributes: {
          Phone: "+989123456789",
          IsVerified: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-09-09T08:45:00.000Z",
          IsActive: true,
          removedAt: null,
          user_info: {
            data: {
              id: 84,
              attributes: {
                FirstName: "آناهیتا",
                LastName: "سادات موسوی نیشابوری با نام خانوادگی بسیار طولانی",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-09-09T08:45:00.000Z",
                NationalCode: "0012345678",
                BirthDate: "1990-01-01",
                Sex: false,
                Bio: "",
              },
            },
          },
        },
      },
    },
    contract: {
      data: {
        id: 21,
        attributes: {
          Type: "Online",
          Status: "Confirmed",
          Amount: 987654321,
          TaxPercent: 0,
          Date: "2026-09-09T08:15:00.000Z",
          createdAt: "2026-09-09T08:15:00.000Z",
          updatedAt: "2026-09-09T08:45:00.000Z",
        },
      },
    },
  },
} satisfies Order;

describe("mobile order cards", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("keeps long Persian buyer, tracking, status, and amount content in wrapping regions", () => {
    render(<MobileTable data={[order]} />);

    const card = screen.getByRole("button", { name: /آناهیتا سادات موسوی/ });
    expect(card).toHaveClass("w-full", "overflow-hidden", "flex-col");
    expect(card.querySelector(".min-w-0")).not.toBeNull();
    expect(
      card.querySelector(".w-full.min-w-0.flex-wrap.items-center.justify-end"),
    ).not.toBeNull();
    expect(screen.getByText("در حال انجام")).toBeVisible();
    expect(screen.getByText("+989123456789")).toBeVisible();
    expect(screen.getByText(/123456789012345678901234567890/)).toBeVisible();
    expect(screen.getByText(/۹۸۷٬۶۵۴٬۳۲۱/)).toBeVisible();
  });

  it("opens the order from the card while nested selection and actions remain independent", () => {
    const onSelectionChange = jest.fn();
    render(
      <MobileTable
        data={[order]}
        selectionProps={{
          enableSelection: true,
          selectedIds: new Set(),
          onSelectionChange,
        }}
      />,
    );

    const card = screen.getByRole("button", { name: /آناهیتا سادات موسوی/ });
    fireEvent.click(card);
    expect(mockPush).toHaveBeenCalledWith("/orders/edit/98765432109876543210");

    mockPush.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: /انتخاب سفارش/ }));
    expect(onSelectionChange).toHaveBeenCalledWith(
      "98765432109876543210",
      true,
    );
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("order-actions-98765432109876543210"));
    expect(mockPush).not.toHaveBeenCalled();

    fireEvent.keyDown(card, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledWith("/orders/edit/98765432109876543210");
  });
});
