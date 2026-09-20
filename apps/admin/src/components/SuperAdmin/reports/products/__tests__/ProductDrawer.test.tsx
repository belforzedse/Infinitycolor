import { render, screen, waitFor } from "@testing-library/react";
import ProductDrawer from "../ProductDrawer";
import { getProductDetail } from "@/services/super-admin/reports/products";
import type { ProductDetail } from "@/services/super-admin/reports/products";

jest.mock("@/services/super-admin/reports/products", () => ({
  getProductDetail: jest.fn(),
}));

// recharts renders nothing useful in jsdom and the drawer only loads it for the
// trend line, which this test does not exercise.
jest.mock("next/dynamic", () => () => {
  const Stub = () => null;
  Stub.displayName = "DynamicStub";
  return Stub;
});

const VARIATION = {
  units: 3,
  gross: 300_000,
  discounts: 0,
  refunds: 0,
  net: 300_000,
  reservedStock: 0,
  stockStatus: "in" as const,
  variantColorCode: "#000000",
  variantModel: null,
  variantAttrs: [],
};

function makeDetail(): ProductDetail {
  return {
    product: { id: 5, title: "شلوار G01170", productType: "Variable", status: "Active", category: null },
    range: { start: "2026-05-01", end: "2026-05-31" },
    grouping: "day",
    timezone: "Asia/Tehran",
    totals: { units: 6, gross: 600_000, discounts: 0, refunds: 0, net: 600_000, currentStock: 40 },
    variations: [
      {
        ...VARIATION,
        variationId: 2,
        sku: "G01170-1",
        currentStock: 6,
        variantColor: "مشکی",
        variantSize: "L",
        variantOther: "جنس: نخی",
        variantLabel: "مشکی / L",
      },
      {
        ...VARIATION,
        variationId: 3,
        sku: "G01170-2",
        currentStock: 34,
        variantColor: "سرمه‌ای",
        variantSize: "XL",
        variantOther: null,
        variantLabel: "سرمه‌ای / XL",
      },
    ],
    trend: [],
  } as unknown as ProductDetail;
}

describe("ProductDrawer variation table", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getProductDetail as jest.Mock).mockResolvedValue(makeDetail());
  });

  it("names each variation by colour and size, not only by SKU code", async () => {
    // The reported problem: «بر اساس متغیرها (sku) بصورت کدینگ هست» — two rows of
    // the same product were distinguishable only by an opaque code.
    render(<ProductDrawer productId={5} start="2026-05-01" end="2026-05-31" onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("مشکی / L")).toBeInTheDocument());
    expect(screen.getByText("سرمه‌ای / XL")).toBeInTheDocument();
    expect(screen.getByText("جنس: نخی")).toBeInTheDocument();
  });

  it("labels the per-variation column and the product total distinctly", async () => {
    // 6 on one row while the product holds 40 is correct, but only once the two
    // numbers say which is which.
    render(<ProductDrawer productId={5} start="2026-05-01" end="2026-05-31" onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("موجودی کل محصول")).toBeInTheDocument());
    expect(screen.getByText("موجودی متغیر")).toBeInTheDocument();
    expect(screen.getByText("۴۰")).toBeInTheDocument();
  });

  it("falls back to a dash when a variation carries no attributes at all", async () => {
    (getProductDetail as jest.Mock).mockResolvedValue({
      ...makeDetail(),
      variations: [
        {
          ...VARIATION,
          variationId: 9,
          sku: "PLAIN-1",
          currentStock: 1,
          variantColor: null,
          variantSize: null,
          variantOther: null,
          variantLabel: null,
        },
      ],
    });
    render(<ProductDrawer productId={5} start="2026-05-01" end="2026-05-31" onClose={jest.fn()} />);

    await waitFor(() => expect(screen.getByText("PLAIN-1")).toBeInTheDocument());
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
