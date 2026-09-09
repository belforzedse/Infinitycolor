"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { OrderService } from "@/services";
import type { OrderPaymentStatusResponse } from "@/services/order";
import ReserveOutcomeNotice from "@/components/User/Orders/ReserveOutcomeNotice";
import { StorefrontContainer } from "@/components/storefront";
import { useCart } from "@/contexts/CartContext";

const TERMINAL = new Set(["Succeeded", "Failed", "Cancelled", "Expired"]);

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
        reconcile ? setChecking(true) : setLoading(true);
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
          tone: "border-green-200 bg-green-50 text-green-800",
        };
      case "Failed":
        return {
          title: "پرداخت تکمیل نشد",
          message: "سفارش قبلی لغو شده و سبد خرید برای تلاش دوباره حفظ شده است.",
          tone: "border-red-200 bg-red-50 text-red-800",
        };
      case "Cancelled":
        return {
          title: "پرداخت لغو شد",
          message: "مبلغی برای این تلاش تأیید نشده است و می‌توانید از سبد خرید دوباره اقدام کنید.",
          tone: "border-orange-200 bg-orange-50 text-orange-800",
        };
      case "Expired":
        return {
          title: "مهلت پرداخت پایان یافت",
          message: "رزرو این سفارش آزاد شده است. موجودی و مبلغ را در سبد خرید دوباره بررسی کنید.",
          tone: "border-orange-200 bg-orange-50 text-orange-800",
        };
      case "Unknown":
        return {
          title: "نتیجه پرداخت هنوز مشخص نیست",
          message: "برای جلوگیری از پرداخت تکراری، فعلاً دوباره پرداخت نکنید و نتیجه را بررسی کنید.",
          tone: "border-amber-200 bg-amber-50 text-amber-900",
        };
      default:
        return {
          title: "در حال بررسی نتیجه پرداخت",
          message: "نتیجه از سرور و وضعیت ثبت‌شده سفارش بررسی می‌شود.",
          tone: "border-blue-200 bg-blue-50 text-blue-800",
        };
    }
  }, [result?.paymentStatus]);

  const returnToCart = () => {
    window.localStorage.removeItem("pendingCheckoutAttemptId");
    window.localStorage.removeItem("pendingPaymentAttemptId");
    router.push("/cart");
  };

  return (
    <StorefrontContainer className="py-8 sm:py-12" dir="rtl">
      <main className="mx-auto max-w-2xl rounded-xl bg-white p-5 shadow-sm sm:p-8">
        {loading ? (
          <div className="flex min-h-56 items-center justify-center" aria-live="polite">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary" />
          </div>
        ) : (
          <div className="space-y-6" data-testid="payment-result">
            <section className={`rounded-lg border p-5 ${presentation.tone}`} aria-live="polite">
              <h1 className="text-xl font-bold sm:text-2xl">{presentation.title}</h1>
              <p className="mt-2 leading-7">{presentation.message}</p>
            </section>

            {result && (
              <dl className="grid gap-3 rounded-lg border border-slate-200 p-4 text-sm sm:grid-cols-2">
                <div><dt className="text-slate-500">شماره سفارش</dt><dd className="font-semibold">#{result.orderId}</dd></div>
                <div><dt className="text-slate-500">روش پرداخت</dt><dd className="font-semibold">{result.paymentGateway || "نامشخص"}</dd></div>
                <div><dt className="text-slate-500">وضعیت سفارش</dt><dd className="font-semibold">{result.status}</dd></div>
                {result.transactionId && (
                  <div><dt className="text-slate-500">شناسه پیگیری</dt><dd className="break-all font-semibold">{result.transactionId}</dd></div>
                )}
              </dl>
            )}

            {result?.reserveGroupId && (
              <ReserveOutcomeNotice outcome={result} isPaid={Boolean(result.isPaid)} />
            )}

            {error && <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{error}</p>}

            <div className="flex flex-col gap-3 sm:flex-row">
              {result?.isPaid && (
                <button className="rounded-lg bg-infinity-primary px-5 py-3 text-white" onClick={() => router.push(`/orders/${orderId}`)}>
                  مشاهده سفارش
                </button>
              )}
              {result?.canRetry && (
                <button className="rounded-lg bg-infinity-primary px-5 py-3 text-white" onClick={returnToCart}>
                  بازگشت به سبد و تلاش دوباره
                </button>
              )}
              {!result?.isPaid && !result?.canRetry && (
                <button className="rounded-lg bg-infinity-primary px-5 py-3 text-white disabled:opacity-60" disabled={checking} onClick={() => void load(true)}>
                  {checking ? "در حال بررسی…" : "بررسی دوباره نتیجه"}
                </button>
              )}
              <button className="rounded-lg border border-slate-300 px-5 py-3 text-slate-700" onClick={() => router.push("/contact")}>
                تماس با پشتیبانی
              </button>
            </div>
          </div>
        )}
      </main>
    </StorefrontContainer>
  );
}
