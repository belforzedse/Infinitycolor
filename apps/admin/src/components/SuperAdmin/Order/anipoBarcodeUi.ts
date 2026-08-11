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
};

const ELIGIBLE_STATUSES = new Set(["Started", "Shipment"]);

export function getAnipoBarcodeUi(input: AnipoBarcodeUiInput): AnipoBarcodeUi {
  if (input.shippingBarcode?.trim()) {
    return { action: null, tone: "green", label: "بارکد صادر شده" };
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
