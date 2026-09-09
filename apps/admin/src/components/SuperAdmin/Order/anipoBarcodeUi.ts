import type { AnipoBarcodeState } from "@/types/super-admin/order";

export type AnipoBarcodeAction = "submit" | "check" | null;
export type AnipoBarcodeTone = "green" | "amber" | "red" | "slate";

export type AnipoBarcodeUi = {
  action: AnipoBarcodeAction;
  tone: AnipoBarcodeTone;
  label: string;
  message?: string;
};

type AnipoBarcodeUiInput = {
  shippingBarcode?: string | null;
  state?: AnipoBarcodeState | null;
  orderStatus?: string | null;
  shippingMethodCode?: string | null;
  providerMessage?: string | null;
  lastError?: string | null;
  /**
   * The order belongs to a reserve group whose window is still open. The server
   * refuses barcode submission for these (`ANIPO_RESERVE_HOLD`); this only makes
   * the refusal legible before the operator clicks.
   */
  reserveIsHeld?: boolean | null;
  reserveExpiresAt?: string | null;
};

const ELIGIBLE_STATUSES = new Set(["Started", "Shipment"]);

export function getAnipoBarcodeUi(input: AnipoBarcodeUiInput): AnipoBarcodeUi {
  if (input.shippingBarcode?.trim()) {
    return { action: null, tone: "green", label: "بارکد صادر شده" };
  }

  // Checked before the state branches, but after an issued barcode: once a label
  // exists the hold is historical and hiding it would confuse reconciliation.
  if (input.reserveIsHeld) {
    return {
      action: null,
      tone: "amber",
      label: "در مهلت رزرو — ارسال متوقف است",
      message:
        "این سفارش تا پایان مهلت رزرو یا آزادسازی زودهنگام توسط مشتری ارسال نمی‌شود. صدور بارکد پس از آن ممکن است.",
    };
  }

  if (input.state === "Pending") {
    return {
      action: "check",
      tone: "amber",
      label: "در انتظار آنیپو — بررسی وضعیت",
      message: input.lastError || input.providerMessage || "تأیید اپراتور آنیپو هنوز انجام نشده است",
    };
  }
  if (input.state === "NeedsAttention") {
    return {
      action: "check",
      tone: "red",
      label: "نیاز به بررسی — استعلام مجدد",
      message: input.lastError || input.providerMessage || "صدور بارکد بیش از هفت روز در انتظار مانده است",
    };
  }
  if (input.state === "Stopped") {
    return {
      action: null,
      tone: "slate",
      label: "پیگیری آنیپو متوقف شده",
      message: input.providerMessage || "وضعیت سفارش دیگر اجازه پیگیری خودکار را نمی‌دهد",
    };
  }
  if (input.state === "Voided") {
    return {
      action: null,
      tone: "slate",
      label: "بارکد در سایت باطل شده",
      message: input.providerMessage || undefined,
    };
  }

  if (input.shippingMethodCode?.toLowerCase() !== "post") {
    return {
      action: null,
      tone: "slate",
      label: "آنیپو فقط برای ارسال پستی",
    };
  }
  if (!ELIGIBLE_STATUSES.has(String(input.orderStatus || ""))) {
    return {
      action: null,
      tone: "slate",
      label: "ابتدا سفارش را آماده‌سازی کنید",
    };
  }

  return { action: "submit", tone: "amber", label: "ثبت سفارش در آنیپو" };
}
