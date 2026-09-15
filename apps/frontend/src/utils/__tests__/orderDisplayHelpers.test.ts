import { PersianOrderStatus } from "@/constants/enums";
import type { Order } from "@/services/order";
import type { OrderItem } from "@/services/order";
import {
  formatOrderItemAttributes,
  getOrderItemAttributes,
  isAwaitingPayment,
  mapOrderToDisplayProps,
} from "@/utils/orderDisplayHelpers";

const context = {
  imageBaseUrl: "",
  placeholderImage: "/placeholder.png",
  formatDate: () => "date",
  formatTime: () => "time",
  faNum: (n: number) => String(n),
  ordersLength: 0,
  handleReleaseReserve: () => undefined,
  persistOrderSnapshot: () => undefined,
  releasingOrderId: null,
  setSelectedOrder: () => undefined,
};

const makeOrder = (Status: string): Order =>
  ({
    id: 42,
    Status,
    createdAt: "2026-09-14T10:00:00.000Z",
    ShippingCost: 0,
    order_items: [],
  }) as unknown as Order;

describe("mapOrderToDisplayProps", () => {
  it("keeps an unpaid order in the in-progress tab but labels it as awaiting payment", () => {
    // Regression: the list printed the tab bucket as the status text, so an
    // abandoned-gateway (Paying) order read «در حال انجام» next to a reserve
    // chip that correctly said «در انتظار پرداخت».
    const props = mapOrderToDisplayProps(makeOrder("Paying"), context);
    expect(props.status).toBe(PersianOrderStatus.INPROGRESS);
    expect(props.statusLabel).toBe("در انتظار پرداخت");
    expect(props.awaitingPayment).toBe(true);
  });

  it("labels a paid order as in progress", () => {
    const props = mapOrderToDisplayProps(makeOrder("Started"), context);
    expect(props.status).toBe(PersianOrderStatus.INPROGRESS);
    expect(props.statusLabel).toBe("در حال انجام");
    expect(props.awaitingPayment).toBe(false);
  });
});

describe("isAwaitingPayment", () => {
  it("matches only the Paying lifecycle state", () => {
    expect(isAwaitingPayment("Paying")).toBe(true);
    expect(isAwaitingPayment(" paying ")).toBe(true);
    expect(isAwaitingPayment("Started")).toBe(false);
    expect(isAwaitingPayment(null)).toBe(false);
  });
});

const makeItem = (overrides: Partial<OrderItem> = {}): OrderItem =>
  ({
    id: 1,
    Count: 1,
    PerAmount: 1000,
    ProductTitle: "شلوار",
    ProductSKU: "SKU-1",
    ...overrides,
  }) as OrderItem;

describe("getOrderItemAttributes", () => {
  // Regression: every storefront order view read
  // `item.product_variation.product_size` -- a spelling that exists on neither
  // entity -- so customers saw order lines with no size at all. The snapshot
  // columns live on the order item; the variation spells them product_variation_*.
  it("reads the order-item snapshot, which is where checkout writes the size", () => {
    const item = makeItem({
      product_color: { id: 3, Title: "مشکی" },
      product_size: { id: 4, Title: "۴۲" },
    });

    expect(getOrderItemAttributes(item)).toEqual({
      color: "مشکی",
      size: "۴۲",
      model: undefined,
    });
    expect(formatOrderItemAttributes(item)).toBe("رنگ: مشکی | سایز: ۴۲");
  });

  it("falls back to the live variation when the snapshot columns are empty", () => {
    const item = makeItem({
      product_variation: {
        id: 9,
        product: null,
        product_variation_color: { id: 3, Title: "آبی" },
        product_variation_size: { id: 4, Title: "۴۴" },
        product_variation_model: { id: 5, Title: "اسلیم" },
      },
    });

    expect(getOrderItemAttributes(item)).toEqual({
      color: "آبی",
      size: "۴۴",
      model: "اسلیم",
    });
  });

  it("prefers the snapshot over a variation that was re-pointed after purchase", () => {
    const item = makeItem({
      product_size: { id: 4, Title: "۴۲" },
      product_variation: {
        id: 9,
        product: null,
        product_variation_size: { id: 7, Title: "۵۰" },
      },
    });

    expect(getOrderItemAttributes(item).size).toBe("۴۲");
  });

  it("ignores blank titles rather than rendering an empty label", () => {
    const item = makeItem({
      product_size: { id: 4, Title: "   " },
      product_variation: {
        id: 9,
        product: null,
        product_variation_size: { id: 7, Title: "۴۴" },
      },
    });

    expect(getOrderItemAttributes(item).size).toBe("۴۴");
  });

  it("returns an empty line for an item with no attributes at all", () => {
    expect(formatOrderItemAttributes(makeItem())).toBe("");
  });
});
