"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSetAtom } from "jotai";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, CircleAlert, CircleX, Clock3, Truck } from "lucide-react";
import { OrderService } from "@/services";
import type { Order, OrderPaymentStatusResponse } from "@/services/order";
import OrderItemsList from "@/components/User/Orders/Detail/OrderItemsList";
import ReserveOutcomeNotice from "@/components/User/Orders/ReserveOutcomeNotice";
import { StorefrontContainer } from "@/components/storefront/StorefrontContainer";
import { useCart } from "@/contexts/CartContext";
import { currentOrderContextAtom } from "@/atoms/issueReportContext";
import { resolvePaymentGateway } from "@/utils/paymentGateways";
import { translateOrderStatus } from "@/utils/statusTranslations";
import {
  clearCheckoutIdentity,
  clearContinuableCheckoutIdentity,
  readContinuableCheckoutIdentity,
} from "@/lib/checkout-identity";
import { formatHoldDeadline } from "@/utils/walletHolds";

const TERMINAL = new Set(["Succeeded", "Failed", "Cancelled", "Expired"]);
const PAID_ORDER_STATUSES = new Set(["Started", "Shipment", "Done"]);
/** Quiet poll interval while settlement is in flight. */
const POLL_INTERVAL_MS = 2500;
/** ~50s window (20 × 2.5s) for card/redirect gateways once the interval is stable. */
const MAX_POLL_CHECKS = 20;
/** Covers SnappPay's 5-minute first unpaid retry plus a buffer. */
const SNAPPAY_POLL_BUDGET_MS = 8 * 60 * 1000;
/** POST reconcile every N quiet ticks so a delayed queue row gets pulled forward. */
const SNAPPAY_RECONCILE_EVERY = 4;

const isPaidOrderStatus = (status?: string | null): boolean =>
  PAID_ORDER_STATUSES.has(String(status || "").trim());

const isAuthoritativePaid = (
  result: Pick<OrderPaymentStatusResponse, "isPaid" | "status"> | null,
): boolean => Boolean(result && (result.isPaid || isPaidOrderStatus(result.status)));

/**
 * Whether this checkout is still sitting on the shopper's wallet credit.
 *
 * A SnappPay hold is the one kind that cannot be handed back on the checkout
 * path — the provider mints a transaction id immediately and keeps answering
 * `REGISTERED` long after the shopper has gone, so nothing local proves the
 * payment is dead. Until the shopper says so, that credit stays committed for
 * up to the reservation defer ceiling. This is the shopper saying so.
 */
/** A SnappPay hold is the only one the shopper's own claim can shorten. */
const MANUAL_RELEASE_GRACE_MS = 2 * 60 * 1000;

const canReleaseHeldWallet = (
  result: OrderPaymentStatusResponse | null,
): boolean => {
  if (
    !result ||
    result.walletHoldStatus !== "Active" ||
    isAuthoritativePaid(result) ||
    !result.paymentStatus ||
    TERMINAL.has(result.paymentStatus)
  ) {
    return false;
  }
  // Hidden for every gateway whose abandon call does nothing: the server
  // answers `not_applicable` for those, and a button that silently fails is
  // worse than no button.
  if (resolvePaymentGateway(result.paymentGateway)?.key !== "snappay") return false;
  // Only where the claim can actually authorize a revert.
  if (result.walletHoldState && result.walletHoldState !== "reclaimable") return false;
  // A shopper who was redirected seconds ago is probably still paying. Offering
  // to cancel their payment at that moment invites them to cancel a payment
  // they are about to complete.
  if (result.walletHeldAt) {
    const heldAtMs = new Date(result.walletHeldAt).getTime();
    if (Number.isFinite(heldAtMs) && Date.now() - heldAtMs < MANUAL_RELEASE_GRACE_MS) {
      return false;
    }
  }
  return true;
};

const pollDelayMs = (checksCompleted: number, snappay: boolean): number => {
  if (!snappay || checksCompleted < 8) return POLL_INTERVAL_MS;
  if (checksCompleted < 20) return 5_000;
  return 10_000;
};

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

const isRateLimited = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  Number((error as { status: unknown }).status) === 429;

const needsSnappayReconcileKick = (status: OrderPaymentStatusResponse): boolean => {
  if (!status.paymentStatus || TERMINAL.has(status.paymentStatus)) return false;
  return resolvePaymentGateway(status.paymentGateway)?.key === "snappay";
};

const applyPaidSideEffects = async (
  next: OrderPaymentStatusResponse,
  clearCart: () => Promise<unknown>,
) => {
  if (!isAuthoritativePaid(next)) return;
  window.localStorage.removeItem("pendingCheckoutAttemptId");
  window.localStorage.removeItem("pendingCheckoutQuoteHash");
  window.localStorage.removeItem("pendingPaymentAttemptId");
  window.localStorage.removeItem("pendingOrderId");
  window.localStorage.removeItem("pendingRefId");
  await clearCart().catch(() => undefined);
};

export default function PaymentResultPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { clearCart } = useCart();
  const clearCartRef = useRef(clearCart);
  const hasResultRef = useRef(false);
  const snappayReconcileKickedRef = useRef(false);
  const orderIdParam =
    searchParams.get("orderId") ||
    searchParams.get("ResNum") ||
    searchParams.get("resNum") ||
    searchParams.get("order");
  const orderId = Number(orderIdParam);
  const [result, setResult] = useState<OrderPaymentStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  /** Sticky: the release is queued, so the confirmation must outlive the request. */
  const [abandonRequested, setAbandonRequested] = useState(false);
  /** Null until the server has answered the claim; false if it refused it. */
  const [abandonAccepted, setAbandonAccepted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Best-effort: the order's line items are a separate, session-authenticated
  // call from the payment-status one above, so a failure here (e.g. the
  // storefront session-restore 401 right after a gateway redirect) must not
  // block the payment status itself from rendering.
  const [orderDetail, setOrderDetail] = useState<Order | null>(null);
  const setCurrentOrderContext = useSetAtom(currentOrderContextAtom);

  useEffect(() => {
    clearCartRef.current = clearCart;
  }, [clearCart]);

  useEffect(() => {
    hasResultRef.current = result !== null;
  }, [result]);

  // Set as early as possible -- before the status fetch below, which is
  // exactly the call that can 401 on a broken session -- so a report filed
  // from this page still points at the right order.
  useEffect(() => {
    if (!Number.isInteger(orderId) || orderId <= 0) return;
    setCurrentOrderContext({ orderId });
    return () => setCurrentOrderContext(null);
  }, [orderId, setCurrentOrderContext]);

  const load = useCallback(
    async (
      mode:
        | "initial"
        | "poll"
        | "reconcile"
        | "quiet-reconcile"
        | "abandon" = "initial",
    ) => {
      if (!Number.isInteger(orderId) || orderId <= 0) return;
      // The shopper's own statement that they did not pay. It rides the same
      // reconcile request, so the answer is the same payment status — what
      // changes is that the server may now revert an uncommitted token, and the
      // wallet credit comes back with it a few seconds later.
      const isAbandon = mode === "abandon";
      const isReconcile = mode === "reconcile" || isAbandon;
      const isQuietReconcile = mode === "quiet-reconcile";
      const isPoll = mode === "poll" || isQuietReconcile;
      const skipGlobalLoader = isPoll || isReconcile;
      try {
        if (isAbandon) {
          setAbandonRequested(true);
        }
        if (isReconcile) {
          setChecking(true);
        } else if (!isPoll && !hasResultRef.current) {
          // Full-page spinner only on the first paint — never on quiet polls.
          setLoading(true);
        }
        if (!isPoll) {
          setError(null);
        }
        const next =
          isReconcile || isQuietReconcile
            ? await OrderService.reconcileOrderPayment(orderId, {
                ...(skipGlobalLoader ? { skipGlobalLoader: true } : {}),
                // Only ever on the deliberate action — never on a poll.
                ...(isAbandon ? { abandon: true } : {}),
              })
            : await OrderService.getOrderPaymentStatus(
                orderId,
                skipGlobalLoader ? { skipGlobalLoader: true } : undefined,
              );
        setResult(next);
        if (isAbandon) {
          // The server decides whether the claim was recorded: a shopper whose
          // own successful return already reached us is refused, and must not be
          // told a release is coming.
          setAbandonAccepted(next.walletReleaseRequested === true);
        }
        await applyPaidSideEffects(next, () => clearCartRef.current());
      } catch (err) {
        if (isReconcile && isRateLimited(err)) {
          // Throttle is expected under retry; keep the last good card.
          return;
        }
        if (isPoll && hasResultRef.current) {
          // Quiet poll failure must not blank the checking UI or trip the spinner.
          return;
        }
        setError("نتیجه پرداخت قابل دریافت نیست. اتصال خود را بررسی و دوباره تلاش کنید.");
      } finally {
        setLoading(false);
        setChecking(false);
      }
    },
    [orderId],
  );

  useEffect(() => {
    snappayReconcileKickedRef.current = false;
    setAbandonRequested(false);
    setAbandonAccepted(null);
  }, [orderId]);

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
    void load("initial");
  }, [load, orderId, router]);

  useEffect(() => {
    if (!Number.isInteger(orderId) || orderId <= 0) return;
    let cancelled = false;
    OrderService.getOrderDetail(orderId, { skipGlobalLoader: true })
      .then((detail) => {
        if (!cancelled) setOrderDetail(detail);
      })
      .catch(() => {
        // Silent: the status section above already covers the failure case.
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  // Kick SnappPay reconcile while the attempt is still non-terminal. GET
  // payment-status is read-only for SnappPay; POST pulls a delayed job forward.
  // The quiet poll loop repeats this every few ticks — this effect is the
  // immediate first kick so we do not wait for the first interval.
  useEffect(() => {
    if (!result || !needsSnappayReconcileKick(result)) return;
    if (isAuthoritativePaid(result)) return;
    if (snappayReconcileKickedRef.current) return;
    snappayReconcileKickedRef.current = true;
    void (async () => {
      try {
        const next = await OrderService.reconcileOrderPayment(orderId, {
          skipGlobalLoader: true,
        });
        setResult(next);
        await applyPaidSideEffects(next, () => clearCartRef.current());
      } catch (err) {
        if (isRateLimited(err)) return;
        // Leave the checking card; quiet GETs and the manual button remain.
      }
    })();
  }, [orderId, result?.paymentStatus, result?.paymentGateway, result?.nextAction]);

  // Quiet poll while non-terminal. Depend on paymentStatus (string), not the
  // whole result object, so setResult(same Pending) does not reset the counter.
  const paymentStatus = result?.paymentStatus;
  const orderStatus = result?.status;
  const resultIsPaid = Boolean(result?.isPaid);
  const isSnappayResult =
    resolvePaymentGateway(result?.paymentGateway)?.key === "snappay";
  useEffect(() => {
    if (!paymentStatus || TERMINAL.has(paymentStatus)) return;
    if (resultIsPaid || isPaidOrderStatus(orderStatus)) return;
    const budgetMs = isSnappayResult
      ? SNAPPAY_POLL_BUDGET_MS
      : POLL_INTERVAL_MS * MAX_POLL_CHECKS;
    const startedAt = Date.now();
    let checks = 0;
    let cancelled = false;
    let timer: number | undefined;

    const schedule = (delay: number) => {
      timer = window.setTimeout(runTick, delay);
    };

    const runTick = () => {
      if (cancelled) return;
      if (Date.now() - startedAt > budgetMs) return;
      if (typeof document !== "undefined" && document.hidden) {
        schedule(pollDelayMs(checks, isSnappayResult));
        return;
      }
      checks += 1;
      const shouldReconcile =
        isSnappayResult && checks % SNAPPAY_RECONCILE_EVERY === 0;
      void load(shouldReconcile ? "quiet-reconcile" : "poll");
      schedule(pollDelayMs(checks, isSnappayResult));
    };

    schedule(pollDelayMs(0, isSnappayResult));

    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void load("poll");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, paymentStatus, orderStatus, resultIsPaid, isSnappayResult]);

  const paid = isAuthoritativePaid(result);
  // Offered until the shopper asks, then replaced by the confirmation below so
  // they cannot queue the same abandonment twice while the worker runs.
  const walletReleaseOffered = !abandonRequested && canReleaseHeldWallet(result);
  const walletStillHeld = result?.walletHoldStatus === "Active";
  const presentation = useMemo(() => {
    if (paid) {
      return {
        title: "پرداخت با موفقیت ثبت شد",
        message: "سفارش شما پرداخت شده و برای پردازش آماده است.",
        tone: "border-emerald-200 bg-emerald-50 text-emerald-950",
        iconTone: "bg-emerald-100 text-emerald-700",
        icon: CheckCircle2,
      };
    }
    // SnappPay commits the shopper's installment credit when they pick a plan,
    // before the first instalment is paid, and releases it itself within about
    // an hour. Saying only "نتیجه پرداخت مشخص نیست" is what makes shoppers
    // report a deduction they believe is a charge — «از حساب اعتباریم کم شد
    // ولی پرداخت نشده است». Naming the reservation and its horizon is the
    // whole fix for the gateway-only checkout; a wallet split keeps its own
    // copy and release action below, so it is excluded here.
    //
    // Deliberately `Unknown` only, not every non-terminal state. `Pending` is
    // also where a shopper sits in the first couple of minutes while the
    // payment is still completing — reconciliation rescues that cohort at
    // roughly T+2m — and telling them their credit is locked for an hour would
    // be alarming and usually wrong. `Unknown` is the state the backend assigns
    // once recovery has actually failed to resolve the attempt, which is what
    // the reported orders carried.
    if (isSnappayResult && !walletStillHeld && result?.paymentStatus === "Unknown") {
      return {
        title: "پرداخت شما کامل نشد",
        message:
          "اعتبار اسنپ‌پی شما فقط رزرو شده و مبلغی از شما کسر نشده است. این رزرو حداکثر تا حدود یک ساعت آزاد می‌شود و پس از آن می‌توانید دوباره سفارش دهید. تا آن زمان دوباره پرداخت نکنید.",
        tone: "border-amber-200 bg-amber-50 text-amber-950",
        iconTone: "bg-amber-100 text-amber-700",
        icon: Clock3,
      };
    }
    // A wallet split whose credit is still committed. The one thing the shopper
    // needs told is that the money comes back by itself, and by when — that is
    // the whole customer-visible defect this recovery work exists to fix.
    // Without it the balance simply looks smaller and nothing explains why.
    if (walletStillHeld && !paid) {
      const deadline = formatHoldDeadline(result?.walletHoldBoundAt);
      return {
        title: "در انتظار تعیین وضعیت پرداخت",
        message: isSnappayResult
          ? `اگر پرداخت را کامل نکرده‌اید، اعتبار کیف پول شما پس از تأیید اسنپ‌پی به‌طور خودکار آزاد می‌شود (معمولاً ظرف ۳۰ دقیقه)${
              deadline ? ` و حداکثر تا ساعت ${deadline}` : ""
            }. نیازی به هیچ اقدامی نیست و دوباره پرداخت نکنید.`
          : `اعتبار کیف پول شما برای این پرداخت رزرو شده است و در صورت ناموفق بودن پرداخت به‌طور خودکار آزاد می‌شود${
              deadline ? ` (حداکثر تا ساعت ${deadline})` : ""
            }. نیازی به هیچ اقدامی نیست.`,
        tone: "border-amber-200 bg-amber-50 text-amber-950",
        iconTone: "bg-amber-100 text-amber-700",
        icon: Clock3,
      };
    }
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
  }, [paid, result?.paymentStatus, isSnappayResult, walletStillHeld]);

  const returnToCart = () => {
    // Clear the whole stored checkout identity, not two legacy keys.
    //
    // Leaving the attempt, quote, order, gateway and signature behind meant the
    // next checkout did not name this attempt as its predecessor, so the
    // supersession path — the one that hands the shopper their own held credit
    // straight back — never ran, and the money waited for the reservation
    // sweep instead.
    clearCheckoutIdentity();
    // The *continuable* set is only cleared when it names this very attempt,
    // mirroring `abandonDeadCheckoutHold` in the cart. A shopper can have a
    // second checkout in flight, and wiping its resume state because they left
    // an unrelated result page would strand it.
    const finishedAttemptId = String(result?.attemptId || "").trim();
    const continuable = readContinuableCheckoutIdentity();
    if (finishedAttemptId && continuable?.attemptId === finishedAttemptId) {
      clearContinuableCheckoutIdentity();
    }
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

            {orderDetail && orderDetail.order_items?.length > 0 && (
              <OrderItemsList order={orderDetail} />
            )}

            {paid && (
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
              <ReserveOutcomeNotice outcome={result} isPaid={paid} />
            )}

            {error && (
              <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-7 text-red-800">
                {error}
              </p>
            )}

            {!paid && walletReleaseOffered && (
              <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-7 text-amber-900">
                بخشی از مبلغ این سفارش از کیف پول شما کنار گذاشته شده و تا مشخص
                شدن نتیجهٔ پرداخت اسنپ‌پی قابل استفاده نیست. اگر پرداخت را انجام
                نداده‌اید، با دکمهٔ زیر این سفارش را لغو کنید تا اعتبارتان آزاد
                شود.
              </p>
            )}

            {abandonAccepted === true && !paid && (
              <p className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-7 text-sky-900">
                {walletStillHeld
                  ? "درخواست لغو ثبت شد. وضعیت پرداخت را از اسنپ‌پی می‌پرسیم و به محض پاسخ، اعتبار کیف پول شما آزاد می‌شود. این صفحه خودش به‌روز می‌شود."
                  : "اعتبار کیف پول شما آزاد شد و می‌توانید دوباره از آن استفاده کنید."}
              </p>
            )}

            {abandonAccepted === false && !paid && walletStillHeld && (
              <p className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm leading-7 text-sky-900">
                نتیجهٔ پرداخت شما از اسنپ‌پی دریافت شده و در حال بررسی است، بنابراین
                این سفارش لغو نشد. تا مشخص شدن نتیجه چند لحظه صبر کنید؛ این صفحه
                خودش به‌روز می‌شود.
              </p>
            )}

            <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:p-5">
              {paid && (
                <button
                  className="w-full rounded-xl bg-infinity-primary px-5 py-3 font-medium text-white transition-opacity hover:opacity-90 sm:w-auto"
                  onClick={() => router.push(`/orders/${orderId}`)}
                >
                  مشاهده سفارش
                </button>
              )}
              {result?.canRetry && !paid && (
                <button
                  className="w-full rounded-xl bg-infinity-primary px-5 py-3 font-medium text-white transition-opacity hover:opacity-90 sm:w-auto"
                  onClick={returnToCart}
                >
                  بازگشت به سبد و تلاش دوباره
                </button>
              )}
              {!paid && !result?.canRetry && (
                <button
                  className="w-full rounded-xl bg-infinity-primary px-5 py-3 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto"
                  disabled={checking}
                  onClick={() => void load("reconcile")}
                >
                  {checking ? "در حال بررسی…" : "بررسی دوباره نتیجه"}
                </button>
              )}
              {walletReleaseOffered && (
                <button
                  className="w-full rounded-xl border border-slate-300 px-5 py-3 font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60 sm:w-auto"
                  disabled={checking}
                  onClick={() => void load("abandon")}
                >
                  پرداخت نکردم؛ اعتبار کیف پولم آزاد شود
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
