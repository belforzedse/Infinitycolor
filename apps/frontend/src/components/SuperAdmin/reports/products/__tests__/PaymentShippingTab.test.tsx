import { render, screen, waitFor } from "@testing-library/react";
import PaymentShippingTab from "../PaymentShippingTab";
import { getProductBreakdown } from "@/services/super-admin/reports/products";

jest.mock("@/services/super-admin/reports/products", () => ({
  getProductBreakdown: jest.fn(),
}));

const mockBreakdown = getProductBreakdown as jest.Mock;

const baseResponse = {
  range: { start: "2026-01-01", end: "2026-01-31" },
  currency: "Toman",
  totals: { gatewaySales: 1_500_000, shippingRevenue: 90_000, ordersCount: 3 },
  gateways: [
    { gateway: "Mellat", label: "ملت", ordersCount: 2, total: 1_000_000, sharePct: 66.67 },
    { gateway: "ZarinPal", label: "زرین‌پال", ordersCount: 1, total: 500_000, sharePct: 33.33 },
  ],
  shippingMethods: [
    { method: "پست پیشتاز", ordersCount: 2, total: 60_000 },
    { method: "نامشخص", ordersCount: 1, total: 30_000 },
  ],
  notes: { gatewaySales: "note-a", shippingRevenue: "note-b" },
};

describe("PaymentShippingTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders gateway and shipping rows with Persian money + counts", async () => {
    mockBreakdown.mockResolvedValue(baseResponse);
    render(<PaymentShippingTab start="2026-01-01" end="2026-01-31" />);

    // Gateway code/label is normalized to the central Persian label via PaymentGatewayBadge.
    await waitFor(() => {
      expect(screen.getByText("بانک ملت")).toBeInTheDocument();
    });
    expect(screen.getByText("زرین پال")).toBeInTheDocument();
    expect(screen.getByText("پست پیشتاز")).toBeInTheDocument();
    expect(screen.getByText("نامشخص")).toBeInTheDocument();
    // money formatted in Persian numerals (fa-IR grouping separator U+066C) + تومان
    expect(screen.getByText("۱٬۰۰۰٬۰۰۰ تومان")).toBeInTheDocument();
    expect(screen.getByText("۶۰٬۰۰۰ تومان")).toBeInTheDocument();
    // share percentage rendered (fa-IR decimal separator U+066B)
    expect(screen.getByText("۶۶٫۶۷٪")).toBeInTheDocument();
  });

  it("shows an empty state for each section when there is no data", async () => {
    mockBreakdown.mockResolvedValue({
      ...baseResponse,
      totals: { gatewaySales: 0, shippingRevenue: 0, ordersCount: 0 },
      gateways: [],
      shippingMethods: [],
    });
    render(<PaymentShippingTab start="2026-01-01" end="2026-01-31" />);

    await waitFor(() => {
      expect(screen.getAllByText("داده‌ای برای این بازه یافت نشد")).toHaveLength(2);
    });
  });

  it("shows an error state with retry when the request fails", async () => {
    mockBreakdown.mockRejectedValue(new Error("boom"));
    render(<PaymentShippingTab start="2026-01-01" end="2026-01-31" />);

    await waitFor(() => {
      expect(screen.getByText("boom")).toBeInTheDocument();
    });
    expect(screen.getByText("تلاش مجدد")).toBeInTheDocument();
  });
});
