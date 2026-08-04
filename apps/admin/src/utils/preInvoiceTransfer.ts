import type { InvoiceOrder } from "@/components/invoice";

const CHANNEL_PREFIX = "infinity-admin-preinvoice-";
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9-]{16,80}$/;
const TRANSFER_TIMEOUT_MS = 15_000;

type TransferMessage =
  | { type: "ready" }
  | { type: "payload"; order: InvoiceOrder }
  | { type: "received" };

export function openPreInvoicePrintWindow(order: InvoiceOrder): boolean {
  if (typeof BroadcastChannel === "undefined") return false;
  const channelId = crypto.randomUUID();
  const channel = new BroadcastChannel(`${CHANNEL_PREFIX}${channelId}`);
  const printWindow = window.open(
    `/orders/print/temp-preview?type=pre-invoice&channel=${encodeURIComponent(channelId)}`,
    "_blank",
    "noopener,noreferrer",
  );
  if (!printWindow) {
    channel.close();
    return false;
  }

  const timeout = window.setTimeout(() => channel.close(), TRANSFER_TIMEOUT_MS);
  channel.onmessage = (event: MessageEvent<TransferMessage>) => {
    if (event.data?.type === "ready") channel.postMessage({ type: "payload", order } satisfies TransferMessage);
    if (event.data?.type === "received") {
      window.clearTimeout(timeout);
      channel.close();
    }
  };
  return true;
}

export function receivePreInvoice(channelId: string): Promise<InvoiceOrder> {
  if (!CHANNEL_ID_PATTERN.test(channelId) || typeof BroadcastChannel === "undefined") {
    return Promise.reject(new Error("کانال امن پیش‌فاکتور در دسترس نیست"));
  }
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(`${CHANNEL_PREFIX}${channelId}`);
    const timeout = window.setTimeout(() => {
      channel.close();
      reject(new Error("زمان دریافت اطلاعات پیش‌فاکتور به پایان رسید"));
    }, TRANSFER_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent<TransferMessage>) => {
      if (event.data?.type !== "payload" || !event.data.order) return;
      channel.postMessage({ type: "received" } satisfies TransferMessage);
      window.clearTimeout(timeout);
      channel.close();
      resolve(event.data.order);
    };
    channel.postMessage({ type: "ready" } satisfies TransferMessage);
  });
}
