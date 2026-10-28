/**
 * Custom router for order APIs
 */

const capabilityPolicy = (capability: string) => [
  { name: "global::require-capability", config: { capability } },
];

export default {
  routes: [
    {
      method: "POST",
      path: "/orders/snappay/callback",
      handler: "order.snappayCallback",
      config: {
        auth: false,
      },
    },
    {
      method: "POST",
      path: "/orders/payment-callback",
      handler: "order.verifyPayment",
      config: {
        auth: false,
        // No authentication middleware for the callback from payment gateway
      },
    },
    {
      method: "GET",
      path: "/orders/payment-callback",
      handler: "order.verifyPayment",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/orders/active-reserve",
      handler: "order.getActiveReserve",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/orders/reserve-groups",
      handler: "order.listMyReserveGroups",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/orders/reserve-groups/:groupKey",
      handler: "order.getMyReserveGroup",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/orders/:id/payment-status",
      handler: "order.checkPaymentStatus",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "POST",
      path: "/orders/:id/payment-reconcile",
      handler: "order.reconcilePayment",
      config: {
        auth: { scope: [] },
        middlewares: ["api::order.payment-reconcile-throttle"],
      },
    },
    {
      method: "GET",
      path: "/orders/my-orders",
      handler: "order.getMyOrders",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/orders/my-orders/:id",
      handler: "order.getMyOrderDetail",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "POST",
      path: "/orders/:id/release-reserve",
      handler: "order.releaseReserve",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "POST",
      path: "/orders/:id/anipo-barcode",
      handler: "order.generateAnipoBarcode",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.shipping.manage"),
      },
    },
    {
      method: "POST",
      path: "/orders/reserve-groups/:groupKey/anipo-barcode",
      handler: "order.generateReserveParcelBarcode",
      config: { auth: { scope: [] }, policies: capabilityPolicy("order.shipping.manage") },
    },
    {
      method: "POST",
      path: "/orders/reserve-groups/:groupKey/anipo-barcode/check",
      handler: "order.checkReserveParcelBarcode",
      config: { auth: { scope: [] }, policies: capabilityPolicy("order.shipping.manage") },
    },
    {
      method: "POST",
      path: "/orders/:id/anipo-barcode/check",
      handler: "order.checkAnipoBarcode",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.shipping.manage"),
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/adjust-items",
      handler: "order.adminAdjustItems",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.items.adjust"),
      },
    },
    {
      method: "PUT",
      path: "/orders/:id/admin/notes",
      handler: "order.adminUpdateNotes",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.notes.update"),
      },
    },
    {
      method: "PUT",
      path: "/orders/:id/admin/address",
      handler: "order.adminUpdateAddress",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.address.update"),
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/transition",
      handler: "order.adminTransition",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.status.update"),
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/cancel",
      handler: "order.adminCancel",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.cancel"),
      },
    },
    {
      method: "GET",
      path: "/orders/:id/admin/payment-operations/:operationId",
      handler: "order.adminPaymentOperation",
      config: {
        auth: { scope: [] },
        // Outer gate only: the handler decides which operation types this
        // operator may read (financial read, or the kind they can queue).
        policies: capabilityPolicy("order.read"),
      },
    },
    {
      method: "GET",
      path: "/orders/:id/admin/wallet-recovery",
      handler: "order.adminWalletRecovery",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.financial.read"),
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/void-barcode",
      handler: "order.adminVoidBarcode",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.shipping.manage"),
      },
    },
    {
      method: "POST",
      path: "/orders/:id/decrement-stock-manual",
      handler: "order.decrementStockManual",
      config: {
        auth: { scope: [] },
        policies: capabilityPolicy("order.manual.create"),
      },
    },
  ],
};
