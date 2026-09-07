"use client";

import React, { Suspense, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { OrderService } from "@/services";
import { StorefrontContainer } from "@/components/storefront";
import {
  orderIdAtom,
  orderNumberAtom,
  submitOrderStepAtom,
  transactionIdAtom,
} from "@/atoms/Order";
import { useAtom } from "jotai";
import { SubmitOrderStep } from "@/types/Order";
import { useCart } from "@/contexts/CartContext";
import { trackAnalyticsEvent } from "@/lib/analytics";

/** Type guard for object with optional code string (e.g. PaymentError). */
function hasCode(x: unknown): x is { code: string } {
  return (
    typeof x === "object" &&
    x !== null &&
    "code" in x &&
    typeof (x as { code: unknown }).code === "string"
  );
}

/**
 * Derive a stable error code from payment callback errors.
 * Prefers error.code when present; falls back to message-based detection.
 */
function getPaymentCallbackErrorCode(error: unknown): string {
  if (hasCode(error)) return error.code;
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (message.includes("ناقص")) return "MISSING_PARAMS";
  if (message.includes("network")) return "NETWORK_ERROR";
  if (message.includes("timeout")) return "TIMEOUT";
  return "UNKNOWN_ERROR";
}

function PaymentCallbackContent() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [_, setOrderId] = useAtom(orderIdAtom);
  const [__, setOrderNumber] = useAtom(orderNumberAtom);
  const [___, setSubmitOrderStep] = useAtom(submitOrderStepAtom);
  const [____, setTransactionId] = useAtom(transactionIdAtom);
  const { clearCart } = useCart();
  const searchParams = useSearchParams();
  const router = useRouter();

  const navigateToSuccess = useCallback(
    async (completedOrderId?: number) => {
      try {
        await clearCart();
      } catch (error) {
        console.error("[PaymentCallback] Failed to refresh cart after payment:", error);
      }
      if (completedOrderId) {
        // Purchase revenue is emitted exactly once by the backend after
        // authoritative payment settlement. The browser records only the
        // callback outcome, so retries or duplicate tabs cannot create a
        // client-side conversion.
        trackAnalyticsEvent({
          category: "checkout",
          action: "payment_callback_success",
          onceKey: `payment-callback-success:${completedOrderId}`,
        });
      }
      setSubmitOrderStep(SubmitOrderStep.Success);
      router.push("/orders/success");
    },
    [clearCart, router, setSubmitOrderStep],
  );

  useEffect(() => {
    const handlePaymentCallback = async () => {
      let orderIdToVerify: string | null = null;
      try {
        setLoading(true);
        setTransactionId(null);

        // Get parameters from URL
        const resNum = searchParams.get("ResNum"); // Order ID
        const refNum = searchParams.get("RefNum"); // Payment reference number

        // Check localStorage for backup data
        const pendingOrderId = localStorage.getItem("pendingOrderId");
        const pendingRefId = localStorage.getItem("pendingRefId");

        if (!resNum || !refNum) {
          // Try to use localStorage data as fallback
          if (!(pendingOrderId && pendingRefId)) {
            throw new Error("اطلاعات پرداخت ناقص است");
          }
        }

        orderIdToVerify = resNum || pendingOrderId;
        const refIdToVerify = refNum || pendingRefId;

        if (!orderIdToVerify || !refIdToVerify) {
          throw new Error("اطلاعات پرداخت ناقص است");
        }

        // Verify payment with backend
        const verificationResult = await OrderService.verifyPayment(
          Number(orderIdToVerify!),
          refIdToVerify,
        );

        // Store order information in atoms
        setOrderId(verificationResult.orderId);
        setOrderNumber(verificationResult.orderNumber);
        setTransactionId(
          verificationResult.transactionId ? String(verificationResult.transactionId) : null,
        );

        // Clear localStorage backup data on successful verification
        localStorage.removeItem("pendingOrderId");
        localStorage.removeItem("pendingRefId");

        // Double-check payment status
        try {
          const paymentStatus = await OrderService.getOrderPaymentStatus(
            verificationResult.orderId,
          );

          if (paymentStatus.transactionId) {
            setTransactionId(String(paymentStatus.transactionId));
          }

          // Set step based on payment status from direct API check
          if (paymentStatus.isPaid) {
            await navigateToSuccess(verificationResult.orderId);
            return;
          }
        } catch {
          // If payment status cannot be confirmed, fall back to verification result
        }

        // If we couldn't check or payment is not verified, use the verification result
        if (verificationResult.success) {
          await navigateToSuccess(verificationResult.orderId);
        } else {
          trackAnalyticsEvent({
            category: "checkout",
            action: "payment_callback_failed",
            onceKey: `payment-callback-failed:${verificationResult.orderId || orderIdToVerify}`,
          });
          setSubmitOrderStep(SubmitOrderStep.Failure);
          router.push("/orders/failure");
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : "خطا در بررسی وضعیت پرداخت";
        trackAnalyticsEvent({
          category: "checkout",
          action: "payment_callback_error",
          onceKey: `payment-callback-error:${orderIdToVerify ?? "unknown"}:${getPaymentCallbackErrorCode(err)}`,
        });
        setError(errorMessage);
        setSubmitOrderStep(SubmitOrderStep.Failure);
        setTransactionId(null);
        router.push("/orders/failure");
      } finally {
        setLoading(false);
      }
    };

    handlePaymentCallback();
  }, [
    searchParams,
    router,
    setOrderId,
    setOrderNumber,
    setSubmitOrderStep,
    setTransactionId,
    navigateToSuccess,
  ]);

  return (
    <StorefrontContainer className="py-10" dir="rtl">
      <div className="mx-auto max-w-2xl rounded-lg bg-white p-8 shadow-md">
        {loading ? (
          <div
            className="flex flex-col items-center text-center"
            data-testid="payment-callback-loading"
          >
            <div className="flex h-40 items-center justify-center">
              <div className="h-12 w-12 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary"></div>
            </div>
            <p className="text-lg">در حال بررسی وضعیت پرداخت...</p>
            <p className="mt-2 text-sm text-gray-500">لطفاً صفحه را نبندید</p>
          </div>
        ) : error ? (
          <div
            className="flex flex-col items-center text-center"
            data-testid="payment-callback-error"
          >
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-red-100">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-10 w-10 text-red-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>

            <h1 className="mb-4 text-2xl font-bold text-red-600">خطا در پردازش پرداخت</h1>

            <p className="mb-6 text-gray-700">{error}</p>

            <div className="flex w-full max-w-xs flex-col gap-4 sm:flex-row">
              <Link
                href="/cart"
                prefetch={false}
                className="rounded-lg bg-infinity-primary px-6 py-3 text-center text-white transition-colors hover:bg-infinity-primary"
              >
                بازگشت به سبد خرید
              </Link>
              <Link
                href="/"
                className="rounded-lg bg-gray-100 px-6 py-3 text-center text-gray-800 transition-colors hover:bg-gray-200"
              >
                بازگشت به فروشگاه
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </StorefrontContainer>
  );
}

export default function PaymentCallback() {
  return (
    <Suspense
      fallback={
        <StorefrontContainer className="py-10">
          <div className="mx-auto max-w-2xl rounded-lg bg-white p-8 shadow-md">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-40 items-center justify-center">
                <div className="h-12 w-12 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary"></div>
              </div>
              <p className="text-lg">در حال بارگذاری...</p>
            </div>
          </div>
        </StorefrontContainer>
      }
    >
      <PaymentCallbackContent />
    </Suspense>
  );
}
