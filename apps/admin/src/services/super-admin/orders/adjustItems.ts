import { apiClient } from "@/services";

export type ItemAdjustment = {
  orderItemId: number;
  newCount?: number;
  remove?: boolean;
};

export type AdjustPreview = {
  changes: Array<{
    orderItemId: number;
    oldCount: number;
    newCount: number;
    productTitle: string;
    restockDelta: number;
  }>;
  newTotals: {
    subtotal: number;
    discount: number;
    tax: number;
    shipping: number;
    total: number;
  };
  oldTotal: number;
  refundToman: number;
  newShipping: number;
};

export type AdjustResult = {
  success: boolean;
  refundToman?: number;
  status: "adjusted" | "cancelled" | "queued";
  operationId?: number;
  operationStatus?: PaymentOperationStatus;
};

export type PaymentOperationStatus =
  | "Queued"
  | "Processing"
  | "Succeeded"
  | "Failed"
  | "Unknown";

export type PaymentOperation = {
  id: number;
  operationType: "CANCEL" | "UPDATE" | string;
  status: PaymentOperationStatus;
  providerStatus?: string | null;
  httpStatus?: number | null;
  providerCode?: number | null;
  retryCount: number;
  nextRunAt?: string | null;
  failureMessage?: string | null;
};

const SNAPPAY_OPERATION_MESSAGES: Record<number, string> = {
  1007:
    "توکن پرداخت نزد اسنپ‌پی معتبر نیست؛ درخواست را تکرار نکنید و با پشتیبانی اسنپ‌پی هماهنگ کنید.",
  1011:
    "وضعیت فعلی تراکنش در اسنپ‌پی اجازه این عملیات را نمی‌دهد؛ وضعیت پرداخت را بررسی کنید.",
  1036:
    "سفارش نزد اسنپ‌پی پیدا نشد یا توکن آن نادرست است؛ درخواست را تکرار نکنید و با پشتیبانی اسنپ‌پی هماهنگ کنید.",
  1042:
    "مبلغ جدید سفارش اسنپ‌پی نمی‌تواند از مبلغ اولیه بیشتر باشد.",
  1048:
    "پذیرنده این تراکنش با تنظیمات فعلی اسنپ‌پی هم‌خوان نیست؛ موضوع را فوراً با پشتیبانی بررسی کنید.",
  1053:
    "یک عملیات قبلی روی این تراکنش در اسنپ‌پی هنوز در حال پردازش است؛ درخواست را تکرار نکنید.",
  1078:
    "این سفارش با کد تخفیف اسنپ‌پی ثبت شده و طبق ضوابط اسنپ‌پی قابل ویرایش نیست.",
};

export function formatSnappayOperationFailure(
  operation: Pick<PaymentOperation, "providerCode" | "failureMessage">,
  fallback: string,
): string {
  const providerCode = Number(operation.providerCode);
  if (Number.isInteger(providerCode) && SNAPPAY_OPERATION_MESSAGES[providerCode]) {
    return SNAPPAY_OPERATION_MESSAGES[providerCode];
  }
  const embeddedCode = String(operation.failureMessage || "").match(
    /SNAPPAY_(?:UPDATE|STATUS|CANCEL|SETTLE|VERIFY)_(\d{4})/,
  )?.[1];
  if (embeddedCode && SNAPPAY_OPERATION_MESSAGES[Number(embeddedCode)]) {
    return SNAPPAY_OPERATION_MESSAGES[Number(embeddedCode)];
  }
  return fallback;
}

export const previewAdjustItems = async (
  orderId: number,
  items: ItemAdjustment[]
): Promise<{ preview: AdjustPreview }> => {
  const response = await apiClient.post(
    `/orders/${orderId}/admin/adjust-items?dryRun=true`,
    { items }
  );
  return (response as any).data;
};

export const adjustItems = async (
  orderId: number,
  items: ItemAdjustment[],
  reason?: string,
  /**
   * Names this operator submission so a retry after a timeout is recognised as
   * the same adjustment rather than refunded a second time. The server binds
   * the refund's ledger reference to it.
   */
  adjustmentId?: string
): Promise<AdjustResult> => {
  const response = await apiClient.post(
    `/orders/${orderId}/admin/adjust-items`,
    { items, reason, adjustmentId }
  );
  return (response as any).data;
};

export const cancelOrder = async (
  orderId: number,
  reason?: string
): Promise<AdjustResult> => {
  const response = await apiClient.post(
    `/orders/${orderId}/admin/cancel`,
    { reason }
  );
  return (response as any).data;
};

export const getPaymentOperation = async (
  orderId: number,
  operationId: number,
): Promise<PaymentOperation> => {
  const response = await apiClient.get(
    `/orders/${orderId}/admin/payment-operations/${operationId}`,
  );
  return (response as any).data;
};

export const waitForPaymentOperation = async (
  orderId: number,
  operationId: number,
  timeoutMs = 30_000,
): Promise<PaymentOperation> => {
  const startedAt = Date.now();
  let operation = await getPaymentOperation(orderId, operationId);
  while (
    ["Queued", "Processing"].includes(operation.status) &&
    Date.now() - startedAt < timeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    operation = await getPaymentOperation(orderId, operationId);
  }
  return operation;
};

export const voidShippingBarcode = async (
  orderId: number,
  reason?: string
): Promise<{ success: boolean }> => {
  const response = await apiClient.post(
    `/orders/${orderId}/admin/void-barcode`,
    { reason }
  );
  return (response as any).data;
};

export type OrderLifecycleStatus = "Paying" | "Started" | "Shipment" | "Done" | "Returned" | "Cancelled";

export const ORDER_STATUSES: OrderLifecycleStatus[] = [
  "Paying",
  "Started",
  "Shipment",
  "Done",
  "Returned",
  "Cancelled",
];

export const ORDER_STATUS_LABELS: Record<OrderLifecycleStatus, string> = {
  Paying: "در حال پرداخت",
  Started: "درحال پردازش",
  Shipment: "در حال ارسال",
  Done: "تکمیل شده",
  Returned: "مرجوع شده",
  Cancelled: "لغو شده",
};

export const changeOrderStatus = async (
  orderId: string,
  status: OrderLifecycleStatus,
) => {
  const response = await apiClient.post(`/orders/${orderId}/admin/transition`, {
    status,
  });
  return (response as any).data;
};
