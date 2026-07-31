import { render, screen, within } from "@testing-library/react";
import Invoice, { type InvoiceOrder } from "../invoice";
import type { SiteIdentity } from "@/types/site-identity";

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    return <span role="img" aria-label={String(props.alt ?? "")} data-src={String(props.src)} />;
  },
}));

const identity: SiteIdentity = {
  siteName: "فروشگاه پوشاک اینفینیتی",
  hasPhysicalStores: true,
  hasMultipleStores: false,
  stores: [
    {
      name: "گرگان",
      address: "گلستان، گرگان، بلوار ناهارخوران",
      postalCode: "4916976618",
      phones: [],
      showInFooter: true,
      showInAbout: true,
      socialLinks: [],
    },
  ],
  socialLinks: [],
  contactNumbers: [],
};

const order: InvoiceOrder = {
  id: "42",
  attributes: {
    Date: "2026-07-27T08:30:00.000Z",
    Description: "بسته‌بندی هدیه",
    Note: "قبل از ارسال تماس بگیرید",
    ShippingCost: 20000,
    DiscountCode: "SUMMER",
    AppliedDiscountAmount: 10000,
    paymentGateway: "ZarinPal",
    transactionId: "REF-42",
    gatewayTrackingCode: "REF-42",
    ShippingMethodTitle: "پست پیشتاز",
    user: {
      data: {
        attributes: {
          Phone: "09120000000",
          user_info: {
            data: {
              attributes: {
                FirstName: "علی",
                LastName: "رضایی",
                NationalCode: "0012345678",
              },
            },
          },
        },
      },
    },
    delivery_address: {
      data: {
        attributes: {
          FullAddress: "گلستان، گرگان، خیابان ولیعصر، پلاک ۱۰",
          PostalCode: "4912345678",
        },
      },
    },
    contract: {
      data: {
        attributes: {
          Amount: 231000,
        },
      },
    },
    order_items: {
      data: [
        {
          id: "14",
          attributes: {
            Count: 2,
            PerAmount: 100000,
            ProductTitle: "پیراهن",
            ProductSKU: "SKU-10",
            product_color: { data: { attributes: { Title: "قرمز" } } },
            product_size: { data: { attributes: { Title: "XL" } } },
            product_variation_model: { data: { attributes: { Title: "کلاسیک" } } },
          },
        },
      ],
    },
  },
};

describe("Invoice", () => {
  it("matches the saved Factorchi classic compact A5 contract using current data", () => {
    render(<Invoice order={order} identity={identity} />);

    const shop = screen.getByRole("table", { name: "اطلاعات فروشگاه" });
    expect(within(shop).getByText(identity.siteName)).toBeInTheDocument();
    expect(within(shop).getByText(identity.stores[0].address as string)).toBeInTheDocument();
    expect(within(shop).getByText("01732525144")).toBeInTheDocument();
    expect(within(shop).getByText("4916976618")).toBeInTheDocument();
    expect(within(shop).queryByText("تاریخ سفارش:")).not.toBeInTheDocument();

    expect(screen.getByText("علی رضایی")).toBeInTheDocument();
    expect(screen.getByText("گلستان، گرگان، خیابان ولیعصر، پلاک ۱۰")).toBeInTheDocument();
    expect(screen.getByText("پست پیشتاز")).toBeInTheDocument();
    expect(screen.queryByText("شماره تراکنش:")).not.toBeInTheDocument();
    expect(screen.queryByText("کد ملی:")).not.toBeInTheDocument();

    const products = screen.getByRole("table", { name: "اقلام سفارش" });
    expect(within(products).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(products).getByText("پیراهن، قرمز، XL، کلاسیک")).toBeInTheDocument();
    expect(within(products).getByText("مبلغ")).toBeInTheDocument();
    expect(within(products).queryByText(/SKU-10/)).not.toBeInTheDocument();
    expect(within(products).getByText(/۲۰۰,۰۰۰/)).toBeInTheDocument();
    expect(within(products).queryByText("ردیف")).not.toBeInTheDocument();
    expect(within(products).queryByText("تنوع")).not.toBeInTheDocument();

    const totals = screen.getByRole("table", { name: "جمع فاکتور" });
    expect(within(totals).getByText("تخفیف")).toBeInTheDocument();
    expect(within(totals).queryByText(/SUMMER/)).not.toBeInTheDocument();
    expect(within(totals).getByText("مالیات")).toBeInTheDocument();
    expect(within(totals).getByText(/۲۳۱,۰۰۰/)).toBeInTheDocument();

    expect(screen.getByText("کدپیگیری درگاه:")).toBeInTheDocument();
    expect(screen.getByText("پرداخت با درگاه زرین‌پال")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "یادداشت" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "توضیحات سفارش" })).not.toBeInTheDocument();
    expect(screen.getByTestId("invoice-document")).toHaveClass(
      "invoice",
      "rtl",
      "classic",
      "factorchi-document",
      "fc-print-a5",
      "fc-compact-texts",
    );

    const barcodes = screen.getAllByTestId("invoice-barcode");
    expect(barcodes).toHaveLength(2);
    barcodes.forEach((barcode) => {
      expect(barcode).toHaveAttribute("data-value", "42");
      expect(barcode).toHaveAttribute("data-format", "CODE128B");
    });
  });
});
