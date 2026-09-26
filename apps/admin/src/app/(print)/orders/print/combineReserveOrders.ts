import type { InvoiceOrder } from "@/components/invoice";
import type { AdminReserveGroupDetail } from "@/services/super-admin/orders/reserveGroups";

const amount = (value: unknown): number => {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** A printable view only; the member orders remain separate financial records. */
export function combineReserveOrders(
  group: AdminReserveGroupDetail,
  orders: InvoiceOrder[],
): InvoiceOrder {
  const memberIds = group.orders.map((order) => String(order.id));
  const expected = new Set(memberIds);
  if (
    !memberIds.length ||
    memberIds.length !== group.orderCount ||
    expected.size !== memberIds.length ||
    orders.length !== memberIds.length ||
    orders.some((order) => !expected.has(order.id)) ||
    new Set(orders.map((order) => order.id)).size !== orders.length
  ) {
    throw new Error("اطلاعات همه سفارش‌های بسته در دسترس نیست. دوباره تلاش کنید.");
  }

  const root = orders.find((order) => order.id === String(group.rootOrderId)) ?? orders[0];
  const items = orders.flatMap((order) => order.attributes.order_items?.data ?? []);
  const itemCount = items.reduce((sum, item) => sum + amount(item.attributes.Count), 0);
  if (itemCount !== group.itemCount) {
    throw new Error("اقلام بسته تغییر کرده‌اند. دوباره تلاش کنید.");
  }

  const total = orders.reduce((sum, order) => {
    const attributes = order.attributes;
    const contractAmount = attributes.contract?.data?.attributes?.Amount;
    if (contractAmount !== undefined && contractAmount !== null) {
      return sum + amount(contractAmount);
    }
    const subtotal = (attributes.order_items?.data ?? []).reduce(
      (itemSum, item) =>
        itemSum + amount(item.attributes.PerAmount) * amount(item.attributes.Count),
      0,
    );
    return sum + subtotal - amount(attributes.AppliedDiscountAmount) + amount(attributes.ShippingCost);
  }, 0);

  return {
    id: root.id,
    attributes: {
      ...root.attributes,
      isReserveOrder: true,
      combinedReserveGroupKey: group.groupKey,
      combinedReserveOrderIds: memberIds,
      order_items: { data: items },
      ShippingCost: group.shippingCostPaid,
      ShippingMethodTitle: group.shippingMethodTitle || root.attributes.ShippingMethodTitle,
      AppliedDiscountAmount: orders.reduce(
        (sum, order) => sum + amount(order.attributes.AppliedDiscountAmount),
        0,
      ),
      contract: { data: { attributes: { Amount: total } } },
      ...(orders.length > 1
        ? {
            PaymentMethod: "پرداخت‌های جداگانه",
            PaymentGateway: undefined,
            paymentGateway: undefined,
            transactionId: undefined,
            gatewayTrackingCode: undefined,
          }
        : {}),
    },
  };
}
