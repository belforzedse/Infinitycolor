/**
 * Custom router for order APIs
 */

import { ROLE_NAMES, STORE_MANAGER_PLUS_ROLES } from "../../../utils/roles";

const operationalPolicy = [
  {
    name: "global::role-based",
    config: { roles: STORE_MANAGER_PLUS_ROLES },
  },
];

const superadminPolicy = [
  {
    name: "global::role-based",
    config: { roles: [ROLE_NAMES.SUPERADMIN] },
  },
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
        policies: operationalPolicy,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/adjust-items",
      handler: "order.adminAdjustItems",
      config: {
        auth: { scope: [] },
        policies: operationalPolicy,
      },
    },
    {
      method: "PUT",
      path: "/orders/:id/admin/notes",
      handler: "order.adminUpdateNotes",
      config: {
        auth: { scope: [] },
        policies: operationalPolicy,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/transition",
      handler: "order.adminTransition",
      config: {
        auth: { scope: [] },
        policies: operationalPolicy,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/cancel",
      handler: "order.adminCancel",
      config: {
        auth: { scope: [] },
        policies: operationalPolicy,
      },
    },
    {
      method: "GET",
      path: "/orders/:id/admin/payment-operations/:operationId",
      handler: "order.adminPaymentOperation",
      config: {
        auth: { scope: [] },
        policies: superadminPolicy,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/admin/void-barcode",
      handler: "order.adminVoidBarcode",
      config: {
        auth: { scope: [] },
        policies: operationalPolicy,
      },
    },
    {
      method: "POST",
      path: "/orders/:id/decrement-stock-manual",
      handler: "order.decrementStockManual",
      config: {
        auth: { scope: [] },
        policies: operationalPolicy,
      },
    },
  ],
};
