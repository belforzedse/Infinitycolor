"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, CircleAlert, CircleX, Clock3, Truck } from "lucide-react";
import { OrderService } from "@/services";
import type { OrderPaymentStatusResponse } from "@/services/order";
import ReserveOutcomeNotice from "@/components/User/Orders/ReserveOutcomeNotice";
import { StorefrontContainer } from "@/components/storefront/StorefrontContainer";
import { useCart } from "@/contexts/CartContext";
import { resolvePaymentGateway } from "@/utils/paymentGateways";
import { translateOrderStatus } from "@/utils/statusTranslations";

const TERMINAL = new Set(["Succeeded", "Failed", "Cancelled", "Expired"]);

const normalizeShippingMethod = (value?: string | null) =>
  (value ?? "")
    .toString()
    .trim()
    .toLocaleLowerCase("fa-IR")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

const getPreparationMessage = (
  code?: string | null,
  title?: string | null,
): string => {
  const method = `${normalizeShippingMethod(code)} ${normalizeShippingMethod(title)}`.trim();

  if (method.includes("tipax") || method.includes("تیپاکس")) {
    return "سفارش شما ۲۴ الی ۴۸ ساعت کاری پس از ثبت سفارش، تحویل تیپاکس خواهد شد.";
  }
  if (method.includes("post") || method.includes("پست")) {
    return "سفارش شما ۷۲ الی ۸۶ ساعت کاری پس از ثبت سفارش، تحویل اداره پست خواهد شد.";
  }
  if (
    method.includes("local courier") ||
    method.includes("courier") ||
    method.includes("پیک")
  ) {
    return "سفارش‌های گرگان حداکثر پس از ۲۴ ساعت کاری برای ارسال با پیک آماده خواهند بود.";
  }
  if (method.includes("pickup") || method.includes("حضوری")) {
    return "سفارش‌های گرگان حداکثر پس از ۲۴ ساعت کاری برای تحویل حضوری آماده خواهند بود.";
  }

  return "زمان آماده‌سازی سفارش بر اساس روش ارسال ثبت‌شده تعیین می‌شود.";
};

export default function PaymentResultPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { clearCart } = useCart();
  const clearCartRef = useRef(clearCart);
  const orderIdParam =
    searchParams.get("orderId") ||
    searchParams.get("ResNum") ||
    searchParams.get("resNum") ||
    searchParams.get("order");
  const orderId = Number(orderIdParam);
  const [result, setResult] = useState<OrderPaymentStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    clearCartRef.current = clearCart;
  }, [clearCart]);

  const load = useCallback(
    async (reconcile = false) => {
      if (!Number.isInteger(orderId) || orderId <= 0) return;
      try {
        if (reconcile) {
          setChecking(true);
        } else {
          setLoading(true);
        }
        setError(null);
        const next = reconcile
          ? await OrderService.reconcileOrderPayment(orderId)
          : await OrderService.getOrderPaymentStatus(orderId);
        setResult(next);
        if (next.isPaid) {
          window.localStorage.removeItem("pendingCheckoutAttemptId");
          window.localStorage.removeItem("pendingPaymentAttemptId");
          window.localStorage.removeItem("pendingOrderId");
          window.localStorage.removeItem("pendingRefId");
          await clearCartRef.current().catch(() => undefined);
        }
      } catch {
        setError("نتیجه پرداخت قابل دریافت نیست. اتصال خود را بررسی و دوباره تلاش کنید.");
      } finally {
        setLoading(false);
        setChecking(false);
      }
    },
    [orderId],
  );

  useEffect(() => {
    if (!Number.isInteger(orderId) || orderId <= 0) {
      const pendingOrderId = window.localStorage.getItem("pendingOrderId");
      if (pendingOrderId) {
        router.replace(`/payment/result?orderId=${encodeURIComponent(pendingOrderId)}`);
      } else {
        setLoading(false);
        setError("شناسه سفارش یافت نشد.");
      }
      return;
    }
    void load(false);
  }, [load, orderId, router]);

  useEffect(() => {
    if (!result?.paymentStatus || TERMINAL.has(result.paymentStatus)) return;
    let checks = 0;
    const timer = window.setInterval(() => {
      checks += 1;
      if (checks > 5) {
        window.clearInterval(timer);
        return;
      }
      void load(false);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [load, result]);

  const presentation = useMemo(() => {
    switch (result?.paymentStatus) {
      case "Succeeded":
        return {
          title: "پرداخت با موفقیت ثبت شد",
          message: "سفارش شما پرداخت شده و برای پردازش آماده است.",
          tone: "border-emerald-200 bg-emerald-50 text-emerald-950",
          iconTone: "bg-emerald-100 text-emerald-700",
          icon: CheckCircle2,
        };
      case "Failed":
        return {
          title: "پرداخت تکمیل نشد",
          message: "سفارش قبلی لغو شده و سبد خرید برای تلاش دوباره حفظ شده است.",
          tone: "border-red-200 bg-red-50 text-red-950",
          iconTone: "bg-red-100 text-red-700",
          icon: CircleX,
        };
      case "Cancelled":
        return {
          title: "پرداخت لغو شد",
          message: "مبلغی برای این تلاش تأیید نشده است و می‌توانید از سبد خرید دوباره اقدام کنید.",
          tone: "border-orange-200 bg-orange-50 text-orange-950",
          iconTone: "bg-orange-100 text-orange-700",
          icon: CircleX,
        };
      case "Expired":
        return {
          title: "مهلت پرداخت پایان یافت",
          message: "رزرو این سفارش آزاد شده است. موجودی و مبلغ را در سبد خرید دوباره بررسی کنید.",
          tone: "border-orange-200 bg-orange-50 text-orange-950",
          iconTone: "bg-orange-100 text-orange-700",
          icon: Clock3,
        };
      case "Unknown":
        return {
          title: "نتیجه پرداخت هنوز مشخص نیست",
          message: "برای جلوگیری از پرداخت تکراری، فعلاً دوباره پرداخت نکنید و نتیجه را بررسی کنید.",
          tone: "border-amber-200 bg-amber-50 text-amber-950",
          iconTone: "bg-amber-100 text-amber-700",
          icon: CircleAlert,
        };
      default:
        return {
          title: "در حال بررسی نتیجه پرداخت",
          message: "نتیجه از سرور و وضعیت ثبت‌شده سفارش بررسی می‌شود.",
          tone: "border-sky-200 bg-sky-50 text-sky-950",
          iconTone: "bg-sky-100 text-sky-700",
          icon: Clock3,
        };
    }
  }, [result?.paymentStatus]);

  const returnToCart = () => {
    window.localStorage.removeItem("pendingCheckoutAttemptId");
    window.localStorage.removeItem("pendingPaymentAttemptId");
    router.push("/cart");
  };

  const PresentationIcon = presentation.icon;
  const paymentGatewayLabel =
    resolvePaymentGateway(result?.paymentGateway)?.label ?? "نامشخص";
  const orderStatusLabel = translateOrderStatus(result?.status);
  const preparationMessage = getPreparationMessage(
    result?.shippingMethodCode,
    result?.shippingMethodTitle,
  );

  return (
    <StorefrontContainer className="py-6 sm:py-12" dir="rtl">
      <main className="mx-auto max-w-3xl">
        {loading ? (
          <div
            className="flex min-h-72 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm"
            aria-live="polite"
          >
            <span className="sr-only">در حال دریافت نتیجه پرداخت</span>
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary motion-reduce:animate-none" />
          </div>
        ) : (
          <div className="space-y-5" data-testid="payment-result">
            <section
              className={`rounded-2xl border p-5 shadow-sm sm:p-7 ${presentation.tone}`}
              aria-live="polite"
            >
              <div className="flex items-start gap-4">
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full sm:h-12 sm:w-12 ${presentation.iconTone}`}
                  aria-hidden="true"
                >
                  <PresentationIcon className="h-6 w-6" strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <h1 className="text-xl font-bold sm:text-2xl">{presentation.title}</h1>
                  <p className="mt-2 text-sm leading-7 sm:text-base">{presentation.message}</p>
                </div>
              </div>
            </section>

            {result && (
              <dl className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-2 sm:p-5">
                <div className="rounded-xl bg-slate-50 p-4">
                  <dt className="text-slate-500">شماره سفارش</dt>
                  <dd className="mt-1 font-semibold text-slate-900">
                    <bdi dir="ltr">#{result.orderId}</bdi>
                  </dd>
                </div>
                <div className="rounded-xl bg-slate-50 p-4">
                  <dt className="text-slate-500">روش پرداخت</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{paymentGatewayLabel}</dd>
                </div>
                <div className="rounded-xl bg-slate-50 p-4">
                  <dt className="text-slate-500">وضعیت سفارش</dt>
                  <dd className="mt-1 font-semibold text-slate-900">{orderStatusLabel}</dd>
                </div>
                {result.transactionId && (
                  <div className="rounded-xl bg-slate-50 p-4">
                    <dt className="text-slate-500">شناسه پیگیری</dt>
                    <dd className="mt-1 break-all font-semibold text-slate-900">
                      <bdi dir="ltr">{result.transactionId}</bdi>
                    </dd>
                  </div>
                )}
              </dl>
            )}

            {result?.isPaid && (
              <section className="rounded-2xl border border-sky-200 bg-sky-50/70 p-5 text-slate-800 shadow-sm sm:p-6">
                <div className="flex items-start gap-3">
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-sky-700 shadow-sm"
                    aria-hidden="true"
                  >
                    <Truck className="h-5 w-5" strokeWidth={1.8} />
                  </span>
                  <div className="min-w-0">
                    <h2 className="font-bold text-slate-950 sm:text-lg">
                      زمان آماده‌سازی و ارسال سفارش
                    </h2>
                    <p className="mt-2 text-sm leading-7 sm:text-base">{preparationMessage}</p>
                  </div>
                </div>
                <div className="mt-4 border-t border-sky-200 pt-4 text-sm leading-7 text-slate-600">
                  <p>زمان رسیدن سفارش پس از ارسال، بسته به روش ارسال و مقصد متفاوت است.</p>
                  <p className="mt-1">
                    برای اطلاع از جزئیات بیشتر و پاسخ به سایر سؤال‌ها، با{" "}
                    <Link
                      href="/contact"
                      className="font-semibold text-infinity-primary underline decoration-infinity-primary/30 underline-offset-4 hover:decoration-infinity-primary"
                    >
                      پشتیبانی
                    </Link>{" "}
                    در ارتباط باشید.
                  </p>
                </div>
              </section>
            )}

            {result?.reserveGroupId && (
              <ReserveOutcomeNotice outcome={result} isPaid={Boolean(result.isPaid)} />
            )}

            {error && (
              <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-7 text-red-800">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:p-5">
              {result?.isPaid && (
                <button
                  className="w-full rounded-xl bg-infinity-primary px-5 py-3 font-medium text-white transition-opacity hover:opacity-90 sm:w-auto"
                  onClick={() => router.push(`/orders/${orderId}`)}
                >
                  مشاهده سفارش
                </button>
              )}
              {result?.canRetry && (
                <button
                  className="w-full rounded-xl bg-infinity-primary px-5 py-3 font-medium text-white transition-opacity hover:opacity-90 sm:w-auto"
                  onClick={returnToCart}
                >
                  بازگشت به سبد و تلاش دوباره
                </button>
              )}
              {!result?.isPaid && !result?.canRetry && (
                <button
                  className="w-full rounded-xl bg-infinity-primary px-5 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto"
                  disabled={checking}
                  onClick={() => void load(true)}
                >
                  {checking ? "در حال بررسی…" : "بررسی دوباره نتیجه"}
                </button>
              )}
              <button
                className="w-full rounded-xl border border-slate-300 px-5 py-3 font-medium text-slate-700 transition-colors hover:bg-slate-50 sm:w-auto"
                onClick={() => router.push("/contact")}
              >
                تماس با پشتیبانی
              </button>
            </div>
          </div>
        )}
      </main>
    </StorefrontContainer>
  );
}
