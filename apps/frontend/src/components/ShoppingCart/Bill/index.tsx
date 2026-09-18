"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import type { Option } from "@/components/Kits/Form/Select";
import ShoppingCartBillInformationForm from "./InformationForm";
import ShoppingCartBillDeliveryForm from "./DeliveryForm";
import ShoppingCartBillDiscountCoupon from "./DiscountCoupon";
import ShoppingCartBillPaymentGateway from "./PaymentGateway";
import CheckoutTermsAcceptance from "./CheckoutTermsAcceptance";
import ReserveShipping from "./ReserveShipping";
import ReserveFulfillmentChoice, {
  type ActiveReserveSummary,
} from "./ReserveFulfillmentChoice";
import CartStockNotice from "../CartStockNotice";
import { CheckoutProgress } from "../CheckoutProgress";
import { orderIdAtom, orderNumberAtom, submitOrderStepAtom } from "@/atoms/Order";
import { useAtom, useAtomValue } from "jotai";
import * as Sentry from "@sentry/nextjs";
import { SubmitOrderStep } from "@/types/Order";
import { currentBrowserFamily } from "@/lib/browser-family";
import { useRouter } from "next/navigation";
import type { ShippingAddressContext, ShippingOption } from "@/services/shipping";
import { CartService, OrderService } from "@/services";
import type {
  CartStockCheckResponse,
  CheckoutGatewayCode,
  ReserveDeliveryAddress,
} from "@/services/cart/types/cart";
import toast from "react-hot-toast";
import WalletService from "@/services/wallet";
import { useCart } from "@/contexts/CartContext";
import { currentUserAtom, userLoadingAtom } from "@/lib/atoms/auth";
import { centralAuth, centralLoginUrl } from "@/lib/central-auth";
import { getAnalyticsCorrelationId, trackFunnelStep, trackAnalyticsEvent } from "@/lib/analytics";
import { faNum, normalizeDigits } from "@/utils/faNum";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { isExpectedCheckoutSentryCode } from "@/lib/expected-checkout-sentry";
import { translateErrorMessage } from "@/lib/errorTranslations";
import { buildCartStockNoticeText } from "@/utils/cartStock";
import {
  clearCheckoutIdentity,
  clearContinuableCheckoutIdentity,
  persistCheckoutOrder,
  readCheckoutAttemptId,
  readCheckoutIdentity,
  readContinuableCheckoutIdentity,
  resolveCheckoutAttemptId,
  shouldResumeStoredCheckout,
  writeCheckoutIdentity,
  type CheckoutIdentity,
} from "@/lib/checkout-identity";
import {
  isCheckoutStatusRecoveryCode,
  orderIdFromCheckoutFailure,
  persistPendingPaymentResult,
} from "@/lib/checkout-status-recovery";

const SNAPPAY_MANUAL_REVIEW_COPY =
  "پرداخت اسنپ‌پی در حال بررسی دستی است. لطفاً وضعیت سفارش را کمی بعد بررسی کنید و دوباره پرداخت نکنید.";
const SNAPPAY_RECONCILIATION_PENDING_COPY =
  "پرداخت اسنپ‌پی هنوز در حال تطبیق است. لطفاً وضعیت سفارش را بررسی کنید و دوباره پرداخت نکنید.";
const ORDER_CANCELLED_COPY =
  "این سفارش لغو شده است. از پرداخت دوباره خودداری کنید و وضعیت سفارش را در حساب کاربری بررسی کنید.";
const RESERVATION_EXPIRED_COPY =
  "مهلت رزرو موجودی این سفارش تمام شده است. لطفاً وضعیت سفارش را بررسی کنید و در صورت نیاز دوباره سفارش دهید.";

function isLiveCheckoutHold(
  outcome: CartStockCheckResponse["reservationOutcome"],
): boolean {
  return outcome === "held";
}

function isDeadCheckoutHold(
  outcome: CartStockCheckResponse["reservationOutcome"],
): boolean {
  return outcome === "expired" || outcome === "released" || outcome === "ineligible";
}

function abandonDeadCheckoutHold(attemptId?: string) {
  const deadAttemptId = String(attemptId || readCheckoutAttemptId() || "").trim();
  clearCheckoutIdentity();
  const continuable = readContinuableCheckoutIdentity();
  if (deadAttemptId && continuable?.attemptId === deadAttemptId) {
    clearContinuableCheckoutIdentity();
  }
}

function leftoverCheckoutCopy(errorCode: string): string | undefined {
  switch (errorCode) {
    case "SNAPPAY_MANUAL_REVIEW":
      return SNAPPAY_MANUAL_REVIEW_COPY;
    case "SNAPPAY_RECONCILIATION_PENDING":
      return SNAPPAY_RECONCILIATION_PENDING_COPY;
    case "ORDER_CANCELLED":
      return ORDER_CANCELLED_COPY;
    default:
      return undefined;
  }
}

// Reserve ("ارسال رزروی" / 48h) ships enabled and is soft-locked by building
// with NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED="false" (a NEXT_PUBLIC_
// value is inlined at build time, so flipping it means a frontend rebuild, not
// a runtime env change). While disabled we never fetch an active reserve, never
// render the reserve UI, and never attach reserve data on submit, so checkout
// always proceeds as a normal (non-reserve) order. This is UI-only: the backend
// endpoints stay open, and the backend's `ENABLE_RESERVE_ORDER_EXPIRY_JOB` must
// stay on so groups opened before the lock still close on schedule.
const RESERVE_FEATURE_ENABLED =
  process.env.NEXT_PUBLIC_INFINITY_RESERVE_CHECKOUT_ENABLED !== "false";

export type FormData = {
  fullName: string;
  phoneNumber: string;
  address: Option | null;
  province: Option | null;
  city: Option | null;
  postalCode: string;
  fullAddress: string;
  addressDescription?: string;
  saveAddress: boolean;
  acceptTerms: boolean;
  shippingMethod: ShippingOption | null;
  notes?: string;
};

type Props = Record<string, never>;

/**
 * One-line destination for the inherited reserve address. Matches the label the
 * address picker already uses (`InformationForm`) so the shopper recognises it.
 */
const formatReserveDestination = (address?: ReserveDeliveryAddress | null): string | null => {
  if (!address) return null;
  const city = address.shipping_city?.Title?.trim();
  const province = address.shipping_city?.shipping_province?.Title?.trim();
  const full = address.FullAddress?.trim();
  const place = [city, province].filter(Boolean).join("، ");
  if (full && place) return `${full} - ${place}`;
  return full || place || null;
};

const buildAddressContextKey = (context?: ShippingAddressContext) => {
  if (context?.addressId) return `address:${context.addressId}`;
  const cityId = context?.addressPayload?.shipping_city;
  return cityId ? `city:${cityId}` : "none";
};

const buildCartSignature = (
  cartItems: Array<{
    cartItemId?: string;
    id?: string;
    variationId?: string;
    quantity?: number;
    price?: number;
  }>,
  totalItems: number,
  totalPrice: number,
) => {
  const itemKey = cartItems
    .map((item) =>
      [
        item.cartItemId || item.id || "",
        item.variationId || "",
        Number(item.quantity || 0),
        Number(item.price || 0),
      ].join(":"),
    )
    .sort()
    .join("|");

  return `${totalItems}:${Math.round(totalPrice)}:${itemKey}`;
};

const buildDiscountPreviewKey = ({
  code,
  shippingId,
  addressContextKey,
  cartSignature,
}: {
  code?: string;
  shippingId?: number;
  addressContextKey: string;
  cartSignature: string;
}) => `${String(code || "").trim()}:${shippingId || "none"}:${addressContextKey}:${cartSignature}`;

const checkoutErrorPresentation = (
  errorCode: string,
): { displayError: string; clearAttempt: boolean } | null => {
  switch (errorCode) {
    case "RESERVATION_EXPIRED":
      return {
        displayError: RESERVATION_EXPIRED_COPY,
        clearAttempt: true,
      };
    case "RESERVATION_LOOKUP_FAILED":
      return {
        displayError:
          "وضعیت رزرو موجودی این سفارش الان مشخص نیست. لطفاً چند لحظه بعد دوباره تلاش کنید.",
        clearAttempt: false,
      };
    case "SNAPPAY_MANUAL_REVIEW":
      return { displayError: SNAPPAY_MANUAL_REVIEW_COPY, clearAttempt: false };
    case "SNAPPAY_RECONCILIATION_PENDING":
      return { displayError: SNAPPAY_RECONCILIATION_PENDING_COPY, clearAttempt: false };
    case "ORDER_CANCELLED":
      return { displayError: ORDER_CANCELLED_COPY, clearAttempt: true };
    case "PAYMENT_IN_PROGRESS":
      return {
        displayError:
          "پرداخت قبلی هنوز در حال بررسی است. لطفاً چند لحظه بعد وضعیت سفارش را بررسی کنید.",
        clearAttempt: false,
      };
    case "PAYMENT_UNKNOWN":
      return {
        displayError:
          "نتیجه شروع پرداخت هنوز مشخص نیست. برای جلوگیری از پرداخت تکراری، وضعیت سفارش را بررسی کنید.",
        clearAttempt: false,
      };
    case "SNAPPAY_INVALID_MOBILE":
      return {
        displayError:
          "شماره موبایل ثبت‌شده برای پرداخت اقساطی معتبر نیست. لطفاً شماره را در حساب کاربری بررسی کنید و دوباره تلاش کنید.",
        clearAttempt: true,
      };
    case "SNAPPAY_AMOUNT_MISMATCH":
      return {
        displayError: "مبلغ سفارش با درگاه همخوانی ندارد. لطفاً سبد خرید را بررسی و دوباره تلاش کنید.",
        clearAttempt: true,
      };
    case "SNAPPAY_CART_INVALID":
      return {
        displayError: "سبد خرید برای اسنپ‌پی نامعتبر است. لطفاً سبد را بررسی و دوباره تلاش کنید.",
        clearAttempt: true,
      };
    case "SNAPPAY_TOKEN_DUPLICATE":
      return {
        displayError:
          "پرداخت قبلی هنوز در حال بررسی است. برای جلوگیری از پرداخت تکراری، وضعیت سفارش را بررسی کنید.",
        clearAttempt: false,
      };
    case "SNAPPAY_MANUAL_REVIEW":
      return {
        displayError: SNAPPAY_MANUAL_REVIEW_COPY,
        clearAttempt: false,
      };
    case "SNAPPAY_RECONCILIATION_PENDING":
      return {
        displayError: SNAPPAY_RECONCILIATION_PENDING_COPY,
        clearAttempt: false,
      };
    default:
      if (errorCode.startsWith("SNAPPAY_TOKEN_")) {
        return {
          displayError: "شروع پرداخت اسنپ‌پی انجام نشد. لطفاً دوباره تلاش کنید.",
          clearAttempt: false,
        };
      }
      return null;
  }
};

function ShoppingCartBillForm({}: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitInProgressRef = React.useRef(false);
  const lastDiscountPreviewKeyRef = React.useRef<string | null>(null);
  const discountPreviewSeqRef = React.useRef(0);
  const lastSnappEligibilityKeyRef = React.useRef<string | null>(null);
  const snappEligibilitySeqRef = React.useRef(0);
  const stockReconcileInFlightRef = React.useRef(false);
  const [_submitOrderStep, setSubmitOrderStep] = useAtom(submitOrderStepAtom);
  const [_, setOrderId] = useAtom(orderIdAtom);
  const [__, setOrderNumber] = useAtom(orderNumberAtom);
  const router = useRouter();
  const currentUser = useAtomValue(currentUserAtom);
  const userLoading = useAtomValue(userLoadingAtom);
  const [hasRedirected, setHasRedirected] = useState(false);
  const [hasAccessToken, setHasAccessToken] = useState(false);
  const [isAuthTokenReady, setIsAuthTokenReady] = useState(false);
  const canLoadProtectedCheckoutData = isAuthTokenReady && Boolean(currentUser || hasAccessToken);

  // A gateway redirect (SnappPay/SamanKish/ZarinPal) sets `window.location.href` and
  // this component is never unmounted for it -- the tab simply navigates away mid
  // "submitting" state. If the browser restores this exact page from bfcache on
  // back-navigation (iOS Safari does this routinely for cross-origin history nav),
  // React state is frozen at whatever it was the instant navigation began, not
  // whatever `finally` in submitOrder normally leaves it at. `pageshow` with
  // `persisted: true` is the one reliable signal that happened, so unconditionally
  // clear the in-flight guard here rather than trusting it survived the round trip
  // -- a customer stuck on a frozen "already submitting" ref sees پرداخت do nothing.
  // Stock re-check on restore is registered later (needs cart helpers).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      submitInProgressRef.current = false;
      setIsSubmitting(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // Check authentication on mount - redirect to login if not authenticated.
  // Wait for global auth loading to finish so we don't redirect while user is still being fetched
  // (avoids loop when returning from auth with valid token).
  useEffect(() => {
    if (typeof window === "undefined") return;

    const currentPath = window.location.pathname;
    if (!currentPath.includes("/checkout")) {
      setHasRedirected(false);
      setHasAccessToken(false);
      setIsAuthTokenReady(true);
      return;
    }

    let cancelled = false;
    centralAuth.tokenManager
      .getToken()
      .then((token) => {
        if (cancelled) return;
        setHasAccessToken(Boolean(token));
        setIsAuthTokenReady(true);
        if (userLoading || currentUser || hasRedirected || token) return;
        setHasRedirected(true);
        window.location.href = centralLoginUrl("/checkout");
      })
      .catch(() => {
        if (!cancelled) setIsAuthTokenReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser, userLoading, hasRedirected]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: {
      saveAddress: true,
      acceptTerms: false,
    },
  });

  const watchShippingMethod = watch("shippingMethod");
  const watchAddress = watch("address");
  const watchCity = watch("city");
  const watchProvince = watch("province");
  const watchPostalCode = watch("postalCode");
  const watchFullAddress = watch("fullAddress");
  const watchSaveAddress = watch("saveAddress");
  const shippingId = watchShippingMethod ? Number(watchShippingMethod.id) : undefined;
  const shippingCost = watchShippingMethod ? Number(watchShippingMethod.price || 0) : undefined;
  const addressId = watchAddress ? Number(watchAddress?.id) : undefined;
  const shippingAddressContext = useMemo<ShippingAddressContext | undefined>(() => {
    if (addressId) return { addressId };
    const inlineCityId = watchCity?.id ? Number(watchCity.id) : undefined;
    if (inlineCityId) return { addressPayload: { shipping_city: inlineCityId } };
    return undefined;
  }, [addressId, watchCity?.id]);

  // Gateway selection state
  const [gateway, setGateway] = useState<CheckoutGatewayCode>("samankish");
  const [availableGateways, setAvailableGateways] = useState<CheckoutGatewayCode[]>([]);
  const [snappEligible, setSnappEligible] = useState<boolean | undefined>(undefined);
  const [snappTitle, setSnappTitle] = useState<string | undefined>(undefined);
  const [snappDescription, setSnappDescription] = useState<string | undefined>(undefined);
  const [discountCode, setDiscountCode] = useState<string | undefined>(undefined);
  const [discountPreview, setDiscountPreview] = useState<
    | {
        discount: number;
        summary: {
          subtotal: number;
          eligibleSubtotal: number;
          tax: number;
          shipping: number;
          total: number;
          taxPercent: number;
        };
      }
    | undefined
  >(undefined);
  const [discountPreviewLoading, setDiscountPreviewLoading] = useState(false);
  const [walletBalanceIrr, setWalletBalanceIrr] = useState<number>(0);
  const [reserveShipping, setReserveShipping] = useState(false);
  const [reviewedServerQuote, setReviewedServerQuote] = useState<{
    quoteHash: string;
    total: number;
  } | null>(null);
  const [activeReserve, setActiveReserve] = useState<ActiveReserveSummary | null>(null);
  // Set when the window closes while the shopper is still on this page, so the
  // fallback to normal shipping is explained rather than silently applied.
  const [reserveWindowClosed, setReserveWindowClosed] = useState(false);
  const [mergeChoice, setMergeChoice] = useState<"merge" | "new" | null>(null);
  const { totalPrice, totalItems, clearCart, cartItems, refreshCart, setStockNotice } = useCart();
  const cartItemsRef = React.useRef(cartItems);
  cartItemsRef.current = cartItems;
  const totalItemsRef = React.useRef(totalItems);
  totalItemsRef.current = totalItems;
  const refreshCartRef = React.useRef(refreshCart);
  refreshCartRef.current = refreshCart;
  const setStockNoticeRef = React.useRef(setStockNotice);
  setStockNoticeRef.current = setStockNotice;
  // null: a stored attempt exists and check-stock has not confirmed the hold yet.
  // Empty-cart continuation is only valid while this is true.
  const [liveCheckoutHold, setLiveCheckoutHold] = useState<boolean | null>(() =>
    typeof window !== "undefined" && Boolean(readCheckoutIdentity()?.attemptId) ? null : false,
  );
  // `snappEligible` is tri-state, and this must read `undefined` the same way
  // PaymentGateway's `showSnappay` does (`!== false`). It used to reject it as
  // falsy while the card was still rendered and selected, so a submit during any
  // re-check — or after a transient eligibility failure, which resets the value
  // to undefined — hit the "gateway not available" guard and failed with a banner
  // the shopper never saw. Unknown means unknown: the quote re-checks eligibility
  // server-side and now reports SNAPPAY_INELIGIBLE with a specific message.
  const selectableGateways = useMemo(
    () => availableGateways.filter((gw) => gw !== "snappay" || snappEligible !== false),
    [availableGateways, snappEligible],
  );

  const shippingToman = shippingCost ?? 0;
  const discountToman = discountPreview?.discount ?? 0;
  const subtotalToman = totalPrice;
  const totalToman = Math.max(0, Math.round(subtotalToman - discountToman + shippingToman));
  const addressContextKey = useMemo(
    () => buildAddressContextKey(shippingAddressContext),
    [shippingAddressContext],
  );
  const cartSignature = useMemo(
    () => buildCartSignature(cartItems, totalItems, totalPrice),
    [cartItems, totalItems, totalPrice],
  );
  const discountPreviewKey = useMemo(
    () =>
      buildDiscountPreviewKey({
        code: discountCode,
        shippingId,
        addressContextKey,
        cartSignature,
      }),
    [addressContextKey, cartSignature, discountCode, shippingId],
  );

  useEffect(() => {
    setReviewedServerQuote(null);
  }, [cartSignature, discountPreviewKey, gateway, mergeChoice]);

  // Persist/restore discount code
  useEffect(() => {
    try {
      const saved = localStorage.getItem("discountCode");
      if (saved) setDiscountCode(saved);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      if (discountCode) localStorage.setItem("discountCode", discountCode);
      else localStorage.removeItem("discountCode");
    } catch {}
  }, [discountCode]);

  // Keyed on the user ID, not the `currentUser` object: AuthInitializer's
  // restore() hands out a fresh object on every auth event, so an object dep
  // refetches constantly -- and each refetch used to clear the shopper's
  // merge/separate selection mid-checkout.
  const currentUserId = currentUser?.id;
  const activeReserveGroupIdRef = React.useRef<string | null>(null);

  const loadActiveReserve = React.useCallback(async () => {
    if (!RESERVE_FEATURE_ENABLED) return;
    if (!currentUserId) return;
    try {
      const res = await OrderService.getActiveReserve();
      const d = res?.data;
      if (d?.reserveGroupId) {
        // Only a *different* window resets the choice. Re-reading the same one
        // must leave a selection the shopper already made alone.
        const sameGroup = activeReserveGroupIdRef.current === d.reserveGroupId;
        activeReserveGroupIdRef.current = d.reserveGroupId;
        setActiveReserve({
          reserveGroupId: d.reserveGroupId,
          reserveExpiresAt: d.reserveExpiresAt ?? null,
          orderCount: d.orderCount,
          shippingMethodTitle: d.shippingMethodTitle ?? null,
          destination: formatReserveDestination(d.deliveryAddress),
          rootOrderId: d.rootOrderId ?? null,
        });
        if (!sameGroup) setMergeChoice(null);
        setReserveWindowClosed(false);
        // A second window cannot be opened while this one is open.
        setReserveShipping(false);
      } else {
        activeReserveGroupIdRef.current = null;
        setActiveReserve(null);
        setMergeChoice(null);
      }
    } catch {
      activeReserveGroupIdRef.current = null;
      setActiveReserve(null);
    }
  }, [currentUserId]);

  useEffect(() => {
    loadActiveReserve();
  }, [loadActiveReserve]);

  useEffect(() => {
    if (!canLoadProtectedCheckoutData) {
      setAvailableGateways([]);
      return;
    }

    const loadAvailableGateways = async () => {
      try {
        const gateways = await CartService.getAvailableGateways();
        setAvailableGateways(gateways);
      } catch {
        setAvailableGateways([]);
      }
    };

    loadAvailableGateways();
  }, [canLoadProtectedCheckoutData]);

  useEffect(() => {
    const hasStoredCheckout = Boolean(readCheckoutIdentity()?.attemptId);
    setError((prev) =>
      selectableGateways.length === 0 && !hasStoredCheckout
        ? EMPTY_GATEWAYS_ERROR
        : prev === EMPTY_GATEWAYS_ERROR
          ? null
          : prev,
    );
    setGateway((prev) =>
      selectableGateways.length > 0 && !selectableGateways.includes(prev)
        ? selectableGateways[0]
        : prev,
    );
  }, [selectableGateways]);

  // Refresh discount preview when code or shipping changes (stable deps).
  // Also re-validates a code restored from localStorage: if it is no longer
  // valid (expired/used), it is dropped and the shopper is told (M4) so the
  // displayed total never silently assumes a discount the backend will reject.
  useEffect(() => {
    const run = async () => {
      if (!discountCode) {
        discountPreviewSeqRef.current += 1;
        setDiscountPreview(undefined);
        lastDiscountPreviewKeyRef.current = null;
        return;
      }
      if (lastDiscountPreviewKeyRef.current === discountPreviewKey && discountPreview) {
        return;
      }
      const requestSeq = discountPreviewSeqRef.current + 1;
      discountPreviewSeqRef.current = requestSeq;
      const requestKey = discountPreviewKey;
      setDiscountPreviewLoading(true);
      try {
        const res = await CartService.applyDiscount({
          code: discountCode,
          shippingId,
          ...shippingAddressContext,
        });
        if (discountPreviewSeqRef.current !== requestSeq) return;
        if (res?.success) {
          setDiscountPreview({ discount: res.discount, summary: res.summary });
          lastDiscountPreviewKeyRef.current = requestKey;
        } else {
          setDiscountPreview(undefined);
          setDiscountCode(undefined);
          lastDiscountPreviewKeyRef.current = null;
          try {
            localStorage.removeItem("discountCode");
          } catch {}
          toast.error("کد تخفیف شما دیگر معتبر نیست و حذف شد");
        }
      } catch (e) {
        if (discountPreviewSeqRef.current !== requestSeq) return;
        const errorMsg = getUserFacingErrorMessage(e, "خطا در اعمال کد تخفیف. دوباره تلاش کنید.");
        console.error("applyDiscount failed:", errorMsg, e);
      } finally {
        if (discountPreviewSeqRef.current === requestSeq) {
          setDiscountPreviewLoading(false);
        }
      }
    };
    run();
  }, [discountCode, discountPreview, discountPreviewKey, shippingId, shippingAddressContext]);

  // Check SnappPay as soon as authenticated checkout data can load, then refresh
  // whenever an input to the payable checkout state changes. The backend accepts
  // the current payable amount even before a delivery method has been selected.
  //
  // A transient failure (network blip, momentary auth refresh, etc.) used to
  // leave SnappPay silently disqualified until the shopper happened to touch
  // the cart/discount/shipping/address -- the only things that change
  // `eligibilityKey` and trigger a re-check. A stale cart left untouched just
  // sat disqualified forever with no visible error. Retrying with backoff
  // here means the check self-heals on its own instead of depending on the
  // shopper stumbling into a state change.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_RETRIES = 4;

    const run = async (attempt: number) => {
      if (cancelled) return;
      let requestSeq = 0;

      try {
        if (!canLoadProtectedCheckoutData) {
          snappEligibilitySeqRef.current += 1;
          lastSnappEligibilityKeyRef.current = null;
          setSnappEligible(undefined);
          setSnappTitle(undefined);
          setSnappDescription(undefined);
          return;
        }

        const isMergeMode = mergeChoice === "merge";
        const eligibilityKey = [
          isMergeMode ? "merge" : "new",
          cartSignature,
          discountCode || "no-discount",
          shippingId || "no-shipping",
          addressContextKey,
          Math.round(totalToman),
        ].join(":");
        if (totalToman <= 0) {
          snappEligibilitySeqRef.current += 1;
          lastSnappEligibilityKeyRef.current = null;
          setSnappEligible(undefined);
          setSnappTitle(undefined);
          setSnappDescription(undefined);
          return;
        }
        if (attempt === 0 && lastSnappEligibilityKeyRef.current === eligibilityKey) {
          return;
        }

        requestSeq = snappEligibilitySeqRef.current + 1;
        snappEligibilitySeqRef.current = requestSeq;
        const res = await CartService.getSnappEligible({
          amount: totalToman,
        });
        if (cancelled || snappEligibilitySeqRef.current !== requestSeq) return;
        lastSnappEligibilityKeyRef.current = eligibilityKey;
        setSnappEligible(!!res.eligible);
        setSnappTitle(res.title);
        setSnappDescription(res.description);
      } catch {
        if (cancelled) return;
        if (requestSeq > 0 && snappEligibilitySeqRef.current !== requestSeq) return;

        lastSnappEligibilityKeyRef.current = null;
        setSnappEligible(undefined);
        setSnappTitle(undefined);
        setSnappDescription(undefined);

        if (attempt < MAX_RETRIES) {
          const delayMs = 2000 * Math.pow(2, attempt);
          retryTimer = setTimeout(() => run(attempt + 1), delayMs);
        }
      }
    };
    run(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    addressContextKey,
    canLoadProtectedCheckoutData,
    cartSignature,
    discountCode,
    shippingId,
    totalToman,
    mergeChoice,
  ]);

  // Load wallet balance once
  useEffect(() => {
    if (!canLoadProtectedCheckoutData) {
      setWalletBalanceIrr(0);
      return;
    }

    const run = async () => {
      try {
        const res = await WalletService.getMyWallet();
        if (res?.success && res.data) setWalletBalanceIrr(Number(res.data.balance || 0));
      } catch {}
    };
    run();
  }, [canLoadProtectedCheckoutData]);

  // Validate cart has items and total price on mount
  const EMPTY_GATEWAYS_ERROR = "در حال حاضر هیچ درگاه پرداختی فعال نیست";
  const EMPTY_CART_ERROR = "سبد خرید شما خالی است یا مبلغ نامعتبر است";
  const TERMS_ACCEPTANCE_ERROR = "برای ثبت سفارش باید قوانین و مقررات سایت را بپذیرید";
  useEffect(() => {
    if (!currentUser) {
      return;
    }

    if (totalPrice > 0 || totalItems > 0) {
      setError((prev) => (prev === EMPTY_CART_ERROR ? null : prev));
      return;
    }

    if (liveCheckoutHold === true) {
      setError((prev) => (prev === EMPTY_CART_ERROR ? null : prev));
      return;
    }

    if (liveCheckoutHold === null) {
      return;
    }

    if (totalPrice <= 0 && totalItems === 0) {
      setError((prev) => (prev === RESERVATION_EXPIRED_COPY ? prev : EMPTY_CART_ERROR));
    }
  }, [totalPrice, totalItems, currentUser, liveCheckoutHold]);

  const clearCartSafely = async () => {
    try {
      await clearCart();
    } catch (clearError) {
      console.error("[ShoppingCart] Failed to refresh cart after successful checkout:", clearError);
    }
  };

  const trackCheckoutError = (errorCode?: string) => {
    // Analytics stays dimensionless per the storefront telemetry contract, so the
    // code goes to Sentry instead — without it every failed checkout looks alike
    // and the generic Persian banner cannot be traced back to a cause.
    trackAnalyticsEvent({
      category: "checkout",
      action: "error",
    });
    if (isExpectedCheckoutSentryCode(errorCode)) {
      return;
    }
    try {
      Sentry.captureMessage(`checkout.error:${errorCode || "UNSPECIFIED"}`, {
        // Unmapped backend copy is still worth a breadcrumb, but it is not an
        // application crash — empty-cart leftovers used this path before the
        // server started sending CART_EMPTY.
        level: errorCode === "BACKEND_MESSAGE" ? "warning" : "error",
        tags: {
          area: "checkout",
          stage: "storefront",
          reasonCode: errorCode || "UNSPECIFIED",
          browser: currentBrowserFamily(),
          gateway: gateway || "none",
        },
        extra: { hasDiscountCode: Boolean(discountCode) },
      });
    } catch {
      // Reporting must never block the shopper's retry.
    }
  };

  /**
   * The notice renders above the checkout form, so a shopper who tapped "pay"
   * at the bottom of a long page would otherwise see the button simply go idle.
   * Deferred a frame because the element only exists after the state commit.
   */
  const scrollStockNoticeIntoView = () => {
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const notice = document.getElementById("cart-stock-notice");
      // jsdom (and older Safari) do not implement scrollIntoView.
      if (typeof notice?.scrollIntoView !== "function") return;
      notice.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  // Resolve a human product name for a stock-change entry. Prefer the backend
  // title, then the (still-current) cart snapshot, then a generic fallback —
  // the backend `message` is English so it is never shown to the user.
  const resolveStockItemName = React.useCallback(
    (it: {
      cartItemId: number;
      productVariationId?: number;
      productTitle?: string;
    }): string => {
      if (it.productTitle) return it.productTitle;
      const items = cartItemsRef.current;
      const byCartItem = items.find((ci) => ci.cartItemId === String(it.cartItemId));
      if (byCartItem?.name) return byCartItem.name;
      if (it.productVariationId != null) {
        const byVariation = items.find((ci) => ci.variationId === String(it.productVariationId));
        if (byVariation?.name) return byVariation.name;
      }
      return "این کالا";
    },
    [],
  );

  /**
   * The reserve window ended while the shopper was on this page (countdown hit
   * zero, or the server refused the attach). Drop the group, restore the normal
   * shipping flow and keep every other checkout input intact.
   */
  const handleReserveWindowClosed = React.useCallback(() => {
    setActiveReserve(null);
    setMergeChoice(null);
    setReserveWindowClosed(true);
    setReviewedServerQuote(null);
  }, []);

  // Checkout errors used to be inline-only. On a phone the error box sits above
  // the fold while the pay button is at the bottom, so a rejected submit looked
  // like the button had simply done nothing -- which is exactly how shoppers
  // reported it. Toast it as well so the failure is visible where they tapped.
  // A fixed id means repeated taps replace the toast instead of stacking.
  const failPayment = React.useCallback((message: string) => {
    setError(message);
    toast.error(message, { id: "checkout-error" });
    // The banner renders at the top of a long form while «پرداخت» sits at the
    // bottom, and the toast carries a fixed id so a repeat of the same error
    // updates the existing toast instead of showing a new one. Without this the
    // shopper taps پرداخت and sees nothing change at all.
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const banner = document.getElementById("checkout-form-error");
      // jsdom (and older Safari) do not implement scrollIntoView; the banner is
      // still rendered and announced, so never let this break the error path.
      if (typeof banner?.scrollIntoView !== "function") return;
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  /**
   * Ambiguous SnapPay start used to leave a "check the order" banner whose retry
   * button only dismissed the message. The payment-result page already polls and
   * reconciles; send the shopper there whenever the failed finalize named an order.
   */
  const recoverInFlightPayment = React.useCallback(
    (errorCode: string | undefined, source: unknown, attemptId?: string) => {
      if (!isCheckoutStatusRecoveryCode(errorCode)) return false;
      const recoveryOrderId = orderIdFromCheckoutFailure(source);
      if (!recoveryOrderId) return false;
      const path = persistPendingPaymentResult(
        recoveryOrderId,
        attemptId || readCheckoutAttemptId(),
      );
      toast.success("در حال بررسی نتیجه پرداخت...", { id: "checkout-error" });
      router.push(path);
      return true;
    },
    [router],
  );

  /**
   * Apply a server stock correction to the checkout UI. On submit we also toast
   * via failPayment so پرداخت never looks idle; on mount/pageshow we only show
   * the amber notice (no toast spam just for landing on the page).
   *
   * Cart helpers are read from refs: `refreshCart` is a new function on every
   * CartContext render, and putting it (or `cartItems`) in these deps is what
   * turned a failed stock mutation into an infinite check → refresh → remount
   * flicker after an unpaid hold left the last unit reserved.
   */
  const applyCheckoutStockCorrection = React.useCallback(
    async (
      stockResult: Pick<
        CartStockCheckResponse,
        "cartIsEmpty" | "itemsAdjusted" | "itemsRemoved" | "errorCode"
      >,
      options: { announce: boolean },
    ): Promise<boolean> => {
      // A lookup failure is not "item unavailable". Do not strip the line or
      // empty-cart-banner as if free stock were zero.
      if (stockResult.errorCode === "RESERVATION_LOOKUP_FAILED") {
        return false;
      }
      const adjustedCartItemIds = (stockResult.itemsAdjusted ?? []).map((it) =>
        String(it.cartItemId),
      );
      const removedNames = (stockResult.itemsRemoved ?? []).map((it) =>
        resolveStockItemName(it),
      );
      const hadNamedChanges = adjustedCartItemIds.length > 0 || removedNames.length > 0;

      if (!hadNamedChanges && !stockResult.cartIsEmpty) {
        return false;
      }

      await refreshCartRef.current({ silent: true });
      if (hadNamedChanges) {
        setStockNoticeRef.current({ adjustedCartItemIds, removedNames });
        scrollStockNoticeIntoView();
      }

      if (options.announce) {
        if (stockResult.cartIsEmpty) {
          failPayment("سبد خرید شما خالی است");
        } else if (hadNamedChanges) {
          failPayment(buildCartStockNoticeText({ adjustedCartItemIds, removedNames }));
        } else {
          failPayment("موجودی سبد خرید تغییر کرده است. لطفاً دوباره تلاش کنید.");
        }
      }
      return true;
    },
    [failPayment, resolveStockItemName],
  );

  const reconcileCheckoutStock = React.useCallback(async () => {
    if (!canLoadProtectedCheckoutData) return;
    if (stockReconcileInFlightRef.current) return;
    stockReconcileInFlightRef.current = true;
    try {
      const stockResult = await CartService.checkCartStock(readCheckoutAttemptId());
      if (stockResult.errorCode === "RESERVATION_LOOKUP_FAILED") {
        return;
      }
      if (isLiveCheckoutHold(stockResult.reservationOutcome)) {
        setLiveCheckoutHold(true);
      } else if (isDeadCheckoutHold(stockResult.reservationOutcome)) {
        const attemptId = readCheckoutAttemptId();
        abandonDeadCheckoutHold(attemptId);
        setLiveCheckoutHold(false);
        if (totalItemsRef.current <= 0) {
          setError(RESERVATION_EXPIRED_COPY);
        }
      } else {
        setLiveCheckoutHold(false);
      }
      if (!stockResult.valid) {
        await applyCheckoutStockCorrection(stockResult, { announce: false });
      }
    } catch {
      // A failed stock poll must not block checkout; submit still re-checks.
    } finally {
      stockReconcileInFlightRef.current = false;
    }
  }, [applyCheckoutStockCorrection, canLoadProtectedCheckoutData]);

  // Drop lines held by an earlier unpaid reservation as soon as checkout loads,
  // and again when bfcache restores the page after a gateway back-nav.
  useEffect(() => {
    void reconcileCheckoutStock();
  }, [reconcileCheckoutStock]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      void reconcileCheckoutStock();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [reconcileCheckoutStock]);

  const submitOrder = async (data: FormData, continuation?: CheckoutIdentity) => {
    setError(null);

    const pendingIdentity = continuation || readCheckoutIdentity();
    const continuableIdentity = continuation ? null : readContinuableCheckoutIdentity();
    const cartIsEmpty = totalItems <= 0 || cartItems.length === 0;
    const resumeIdentity =
      continuation ||
      (shouldResumeStoredCheckout({
        stored: pendingIdentity,
        selectedGateway: gateway,
        selectableGateways,
        cartIsEmpty,
      })
        ? pendingIdentity
        : shouldResumeStoredCheckout({
            stored: continuableIdentity,
            selectedGateway: gateway,
            selectableGateways,
            cartIsEmpty,
          })
          ? continuableIdentity
          : null);
    const continuationCandidate = Boolean(
      resumeIdentity?.attemptId && resumeIdentity.quoteHash && (cartIsEmpty || continuation),
    );

    const selectedAddressId = data.address?.id ? Number(data.address.id) : undefined;
    const inlineAddressFieldsFilled =
      !!watchProvince && !!watchCity && !!watchPostalCode && !!watchFullAddress;
    const isMergeMode = mergeChoice === "merge";

    // An open window must never attach by default: the shopper picks combined or
    // separate fulfillment explicitly.
    if (RESERVE_FEATURE_ENABLED && activeReserve && mergeChoice === null && !continuationCandidate) {
      failPayment("لطفاً مشخص کنید این سفارش به بسته رزروی اضافه شود یا جداگانه ارسال شود");
      return;
    }

    if (!continuationCandidate && !isMergeMode) {
      if (!selectedAddressId && !inlineAddressFieldsFilled) {
        failPayment("لطفاً یک آدرس ذخیره شده را انتخاب یا آدرس جدید وارد کنید");
        return;
      }
      if (!data.shippingMethod) {
        failPayment("لطفاً روش ارسال را انتخاب کنید");
        return;
      }
    }

    if (!continuationCandidate && (!data.phoneNumber || data.phoneNumber.trim() === "")) {
      failPayment("لطفاً شماره تماس خود را وارد کنید");
      return;
    }

    // Validate phone number format (basic check). Persian/Arabic-Indic digits
    // (common on Iranian keyboards) must be normalized before the ASCII-only
    // \D strip, or they're stripped as "non-digits" and the field reads empty.
    const cleanPhone = continuationCandidate
      ? ""
      : normalizeDigits(data.phoneNumber || "").replace(/\D/g, "");
    if (!continuationCandidate && cleanPhone.length < 10) {
      failPayment("شماره تماس وارد شده معتبر نیست");
      return;
    }

    if (!continuationCandidate && !isMergeMode && !selectedAddressId) {
      if (!watchProvince || !watchCity) {
        failPayment("لطفاً استان و شهر را انتخاب کنید");
        return;
      }
      const postal = normalizeDigits(watchPostalCode || "").replace(/\D/g, "");
      if (postal.length !== 10) {
        failPayment("کد پستی باید ۱۰ رقم باشد");
        return;
      }
      if (!watchFullAddress || watchFullAddress.trim().length < 5) {
        failPayment("لطفاً آدرس دقیق را وارد کنید");
        return;
      }
    }

    // Validate total price is positive unless we are continuing a held unpaid order
    // whose mutable cart was emptied by the reservation-unaware stock check.
    if (totalPrice <= 0 && !continuationCandidate) {
      failPayment("مبلغ سفارش باید بیشتر از صفر باشد");
      return;
    }

    const resumeGateway = (
      continuationCandidate
        ? String(resumeIdentity?.gateway || gateway).toLowerCase()
        : gateway
    ) as typeof gateway;

    if (
      !continuationCandidate &&
      (selectableGateways.length === 0 || !selectableGateways.includes(gateway))
    ) {
      failPayment("درگاه پرداخت انتخاب شده در دسترس نیست");
      return;
    }

    if (!data.acceptTerms) {
      failPayment(TERMS_ACCEPTANCE_ERROR);
      return;
    }

    // Prevent duplicate submissions while one is in flight. This must never be a
    // silent no-op -- if it trips, tapping پرداخت has to visibly explain why
    // nothing moved instead of looking broken (the pageshow handler above is the
    // primary defense against this guard getting stuck; this is the fallback if
    // it still does).
    if (submitInProgressRef.current) {
      console.warn("Submit already in progress, ignoring duplicate submission");
      toast("در حال پردازش سفارش قبلی هستیم. لطفاً چند لحظه صبر کنید.", { id: "checkout-error" });
      return;
    }

    try {
      submitInProgressRef.current = true;
      setIsSubmitting(true);
      trackAnalyticsEvent({
        category: "checkout",
        action: "place_order_attempt",
        valueToman: totalToman,
        properties: { gateway: resumeGateway, quantity: totalItems },
      });

      // Always re-checked: the shopper's previous attempt may itself be what
      // corrected the cart, and nothing is allowed to pay past this guard.
      const stockValid = await CartService.checkCartStock(
        continuationCandidate ? resumeIdentity?.attemptId : undefined,
      );

      if (stockValid.errorCode === "RESERVATION_LOOKUP_FAILED") {
        failPayment(checkoutErrorPresentation("RESERVATION_LOOKUP_FAILED")!.displayError);
        return;
      }

      const holdIsLive = isLiveCheckoutHold(stockValid.reservationOutcome);
      if (continuationCandidate && !holdIsLive) {
        if (isDeadCheckoutHold(stockValid.reservationOutcome)) {
          abandonDeadCheckoutHold(resumeIdentity?.attemptId);
          setLiveCheckoutHold(false);
          failPayment(RESERVATION_EXPIRED_COPY);
          return;
        }
        failPayment(EMPTY_CART_ERROR);
        return;
      }

      const canContinuePendingCheckout = Boolean(continuationCandidate && holdIsLive);
      if (canContinuePendingCheckout) {
        setLiveCheckoutHold(true);
      }

      if (!stockValid.valid && !canContinuePendingCheckout) {
        const applied = await applyCheckoutStockCorrection(stockValid, { announce: true });
        if (applied) return;
        failPayment("موجودی سبد خرید تغییر کرده است. لطفاً دوباره تلاش کنید.");
        return;
      }

      let checkoutAttemptId: string | undefined;
      let cartResponse;

      if (canContinuePendingCheckout && resumeIdentity) {
        if (resumeIdentity !== pendingIdentity) {
          writeCheckoutIdentity(resumeIdentity);
        }
        checkoutAttemptId = resumeIdentity.attemptId;
        cartResponse = await CartService.finalizeCart({
          gateway: resumeGateway,
          attemptId: resumeIdentity.attemptId,
          quoteHash: resumeIdentity.quoteHash,
          analyticsCorrelationId: getAnalyticsCorrelationId(),
        } as never);
      } else {
      const addressPayload =
        isMergeMode || selectedAddressId
          ? undefined
          : {
              shipping_city: Number(watchCity?.id),
              PostalCode: normalizeDigits(watchPostalCode || "").replace(/\D/g, ""),
              FullAddress: (watchFullAddress || "").trim(),
              Description: data.addressDescription?.trim() || undefined,
              save: watchSaveAddress,
              // Recipient info the shopper may have overridden (e.g. ordering on
              // someone else's behalf) — kept separate from the account's own name.
              FullName: (data.fullName || "").trim() || undefined,
              Phone: cleanPhone || undefined,
            };

      const finalizeData: Record<string, unknown> = isMergeMode
        ? {
            reserveGroupId: activeReserve?.reserveGroupId,
            callbackURL: "/orders/payment-callback",
            gateway,
            mobile: normalizeDigits(data.phoneNumber || "").replace(/\D/g, ""),
            discountCode: discountCode || localStorage.getItem("discountCode") || undefined,
            note: data.notes || undefined,
          }
        : {
            shipping: Number(data.shippingMethod!.id),
            note: data.notes || undefined,
            callbackURL: "/orders/payment-callback",
            addressId: selectedAddressId,
            addressPayload,
            gateway,
            mobile: normalizeDigits(data.phoneNumber || "").replace(/\D/g, ""),
            discountCode: discountCode || localStorage.getItem("discountCode") || undefined,
            reserveShipping: reserveShipping || undefined,
          };

      const quote = await CartService.getCheckoutQuote(finalizeData as never);

      // The quote now succeeds even when SnappPay's eligibility check fails, so
      // one slow gateway no longer takes the whole checkout down. The shopper
      // keeps their computed totals and is asked to pick another gateway.
      if ((quote as any).gatewayAvailable === false) {
        trackCheckoutError(String((quote as any).gatewayErrorCode || "SNAPPAY_UNAVAILABLE"));
        failPayment(
          String(
            (quote as any).gatewayNotice ||
              "پرداخت اقساطی اسنپ‌پی موقتاً در دسترس نیست. لطفاً روش پرداخت دیگری انتخاب کنید.",
          ),
        );
        return;
      }

      const quoteTotal = Number(quote.financialSummary?.total || 0);
      const shopperVisibleTotal = isMergeMode
        ? Math.max(0, Math.round(totalPrice - discountToman))
        : totalToman;
      const quoteWasReviewed =
        reviewedServerQuote?.quoteHash === quote.quoteHash &&
        reviewedServerQuote.total === quoteTotal;

      if (quoteTotal !== shopperVisibleTotal && !quoteWasReviewed) {
        setReviewedServerQuote({ quoteHash: quote.quoteHash, total: quoteTotal });
        failPayment(
          `مبلغ نهایی توسط فروشگاه به ${quoteTotal.toLocaleString("fa-IR")} تومان به‌روزرسانی شد. لطفاً مبلغ را بررسی و دوباره ثبت سفارش را انتخاب کنید.`,
        );
        return;
      }

      const resolvedAttempt = resolveCheckoutAttemptId({
        quoteHash: quote.quoteHash,
        cartSignature,
        cartIsEmpty: false,
        gateway,
      });
      checkoutAttemptId = resolvedAttempt.attemptId;
      cartResponse = await CartService.finalizeCart({
        ...finalizeData,
        gateway: resolvedAttempt.gateway || gateway,
        attemptId: checkoutAttemptId,
        quoteHash: resolvedAttempt.quoteHash,
        // Keep anonymous attribution ephemeral in the browser, but carry the
        // active opaque analytics identity into authoritative order creation.
        analyticsCorrelationId: getAnalyticsCorrelationId(),
      } as never);
      }

      if (!cartResponse.success) {
        console.error("❌ Cart finalization failed:", cartResponse);

        // Extract detailed error information from response
        const errorCode = (cartResponse as any).errorCode;
        const errorMessage = (cartResponse as any).message || cartResponse.message;
        const errorDetails = (cartResponse as any).details;

        // Stock moved between the guard above and the server's own re-check, so the
        // server corrected the cart and refused the order. It answers without an
        // errorCode and in English, which the translator cannot map — that is how
        // this became the generic "try again" banner. Show the same inline notice
        // the pre-flight guard uses instead, naming what actually changed.
        const lateStock = cartResponse as unknown as Pick<
          CartStockCheckResponse,
          "itemsAdjusted" | "itemsRemoved" | "cartIsEmpty"
        >;
        const lateAdjusted = lateStock.itemsAdjusted ?? [];
        const lateRemoved = lateStock.itemsRemoved ?? [];
        if (lateAdjusted.length || lateRemoved.length || lateStock.cartIsEmpty) {
          trackCheckoutError("STOCK_CHANGED");
          const applied = await applyCheckoutStockCorrection(lateStock, { announce: true });
          if (applied) return;
        }

        // Map error codes to user-friendly messages
        let displayError = "خطا در ثبت سفارش. لطفاً مجددا تلاش کنید.";

        if (errorCode) {
          trackCheckoutError(String(errorCode));
          if (recoverInFlightPayment(String(errorCode), cartResponse, checkoutAttemptId)) {
            return;
          }
          const mappedCheckoutError = checkoutErrorPresentation(String(errorCode));
          if (mappedCheckoutError) {
            displayError = mappedCheckoutError.displayError;
            if (mappedCheckoutError.clearAttempt) {
              clearCheckoutIdentity();
            }
          } else {
            switch (errorCode) {
            case "PAYMENT_INITIATION_FAILED":
            case "WALLET_DEBIT_FAILED":
              displayError = "شروع پرداخت کامل نشد. می‌توانید دوباره تلاش کنید.";
              clearCheckoutIdentity();
              break;
            case "CART_EMPTY":
              displayError = "سبد خرید شما خالی است";
              break;
            case "INVALID_ITEM":
              displayError =
                "برخی از کالاهای سبد خرید معتبر نیستند. لطفاً سبد خرید خود را بررسی کنید";
              break;
            case "MISSING_PRODUCT_TITLE":
            case "MISSING_PRODUCT_SKU":
              displayError = "اطلاعات برخی از کالاها ناقص است. لطفاً با پشتیبانی تماس بگیرید";
              break;
            case "INVALID_PRICE":
              displayError =
                "قیمت برخی از کالاها نامعتبر است. لطفاً سبد خرید خود را بروزرسانی کنید";
              break;
            case "ORDER_ITEM_CREATION_FAILED":
              displayError = "خطا در ثبت اقلام سفارش. لطفاً مجدداً تلاش کنید";
              break;
            case "CONTRACT_CREATION_FAILED":
              displayError = "خطا در ایجاد قرارداد. لطفاً مجدداً تلاش کنید";
              break;
            case "INVALID_AMOUNT":
              displayError = "مبلغ سفارش نامعتبر است";
              break;
            case "SHIPPING_REQUIRED":
              displayError = "لطفاً روش ارسال را انتخاب کنید";
              break;
            case "ADDRESS_REQUIRED":
              displayError = "لطفاً آدرس تحویل را انتخاب کنید";
              break;
            case "INVALID_SHIPPING":
              displayError = "روش ارسال انتخاب شده معتبر نیست";
              break;
            case "ADDRESS_NOT_FOUND":
              displayError = "آدرس انتخاب شده یافت نشد. لطفاً آدرس دیگری انتخاب کنید";
              break;
            case "RESERVE_NOT_FOUND":
            case "RESERVE_WINDOW_CLOSED":
              // The window closed between page load and submit. Keep the cart and
              // fall back to normal shipping instead of retrying against a dead
              // group; the server timestamp is authoritative, not our countdown.
              handleReserveWindowClosed();
              displayError =
                "مهلت افزودن سفارش به بسته رزروی به پایان رسید. این سفارش جداگانه ارسال می‌شود؛ لطفاً آدرس و روش ارسال را انتخاب کنید.";
              break;
            case "RESERVE_ALREADY_ACTIVE":
              // The window exists but this client did not know about it, so the
              // attach card is not on screen and the message below names two
              // controls the shopper cannot see. Refetch to surface them --
              // otherwise a reload is the only way out.
              void loadActiveReserve();
              displayError =
                "شما یک سفارش رزروی فعال دارید. این سفارش را به همان بسته اضافه کنید یا آن را جداگانه ثبت کنید.";
              break;
            // The codes below reach the storefront but had no case, so each one
            // rendered as the generic banner and told the shopper nothing they
            // could act on.
            case "STOCK_RESERVATION_FAILED":
              displayError =
                "موجودی برخی از کالاها همین حالا تمام شد. لطفاً سبد خرید را بررسی و دوباره تلاش کنید.";
              break;
            case "DISCOUNT_USAGE_EXHAUSTED":
              displayError =
                "ظرفیت استفاده از این کد تخفیف تکمیل شده است. کد را بردارید یا کد دیگری وارد کنید.";
              break;
            case "CHECKOUT_QUOTE_CHANGED":
              displayError =
                "قیمت یا موجودی سبد خرید تغییر کرد. لطفاً مبلغ نهایی را بررسی و دوباره ثبت سفارش کنید.";
              break;
            case "CHECKOUT_ATTEMPT_CONFLICT":
            case "CHECKOUT_ATTEMPT_REQUIRED":
            case "CHECKOUT_QUOTE_REQUIRED":
              // The stored attempt id belongs to an older basket. Dropping it lets
              // the next tap start a clean attempt instead of failing the same way.
              clearCheckoutIdentity();
              displayError = "سفارش شما تازه‌سازی شد. لطفاً یک بار دیگر ثبت سفارش را بزنید.";
              break;
            case "PAYMENT_GATEWAY_DISABLED":
            case "SNAPPAY_GATEWAY_RECORD_MISSING":
              displayError =
                "درگاه پرداخت انتخاب‌شده در دسترس نیست. لطفاً درگاه دیگری را انتخاب کنید.";
              break;
            case "INVALID_RESERVATION":
              displayError = "رزرو موجودی انجام نشد. لطفاً دوباره تلاش کنید.";
              break;
            case "SNAPPAY_MANUAL_REVIEW":
            case "SNAPPAY_RECONCILIATION_PENDING":
            case "ORDER_CANCELLED": {
              const leftover = leftoverCheckoutCopy(String(errorCode));
              if (leftover) displayError = leftover;
              clearCheckoutIdentity();
              break;
            }
            default:
              // Use backend message translated to Persian (never show raw)
              if (errorMessage && typeof errorMessage === "string") {
                displayError = translateErrorMessage(
                  errorMessage,
                  "خطا در ثبت سفارش. لطفاً مجددا تلاش کنید.",
                );
              }
          }
          }
        } else if (errorMessage && typeof errorMessage === "string") {
          trackCheckoutError("BACKEND_MESSAGE");
          displayError = translateErrorMessage(
            errorMessage,
            "خطا در ثبت سفارش. لطفاً مجددا تلاش کنید.",
          );
        } else {
          trackCheckoutError("FINALIZE_FAILED");
        }

        // Log error details for debugging
        if (process.env.NODE_ENV === "development" && errorDetails) {
          console.error("Error details:", errorDetails);
        }

        failPayment(displayError);
        return;
      }

      setOrderId(cartResponse.orderId);
      setOrderNumber(cartResponse.orderId.toString());
      persistCheckoutOrder(cartResponse.orderId);

      if (cartResponse.redirectUrl && cartResponse.redirectUrl.trim() !== "") {
        trackAnalyticsEvent({
          category: "checkout",
          action: "payment_redirect",
          valueToman: totalToman,
          properties: { gateway },
        });
        toast.success("در حال انتقال به درگاه پرداخت...");
        localStorage.setItem("pendingOrderId", cartResponse.orderId.toString());
        localStorage.setItem("pendingRefId", cartResponse.refId || "");
        if (checkoutAttemptId) {
          localStorage.setItem(
            "pendingPaymentAttemptId",
            cartResponse.attemptId || checkoutAttemptId,
          );
        }

        // Handle different gateway redirect methods
        if (gateway === "mellat" && cartResponse.refId) {
          // Mellat requires POST with RefId (similar to wallet topup flow)
          const form = document.createElement("form");
          form.method = "POST";
          form.action = cartResponse.redirectUrl;
          form.style.display = "none";
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = "RefId";
          input.value = String(cartResponse.refId);
          form.appendChild(input);
          document.body.appendChild(form);
          form.submit();
        } else if (gateway === "snappay" || gateway === "samankish" || gateway === "zarinpal") {
          // These gateways use GET redirect with token/authority in URL
          window.location.href = cartResponse.redirectUrl!;
        } else if (gateway === "wallet") {
          trackAnalyticsEvent({
            category: "checkout",
            action: "payment_completed",
            valueToman: totalToman,
            properties: { gateway: "wallet" },
          });
          // Wallet settles immediately; show the same authoritative result surface
          // used by provider callbacks so fulfillment details stay consistent.
          await clearCartSafely();
          clearCheckoutIdentity();
          setSubmitOrderStep(SubmitOrderStep.Success);
          router.push(`/payment/result?orderId=${encodeURIComponent(cartResponse.orderId)}`);
        }
      } else {
        trackAnalyticsEvent({
          category: "checkout",
          action: "payment_completed",
          valueToman: totalToman,
          properties: { gateway: "direct" },
        });
        await clearCartSafely();
        if (gateway !== "snappay") {
          clearCheckoutIdentity();
        }
        setSubmitOrderStep(SubmitOrderStep.Success);
        router.push(`/payment/result?orderId=${encodeURIComponent(cartResponse.orderId)}`);
      }
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : JSON.stringify(err);
      console.error("Error creating order:", errorMsg, err);

      // Extract error information from the error object
      let displayError = "خطا در ثبت سفارش. لطفاً مجددا تلاش کنید.";

      // The shared fetch client exposes Strapi product details on `data`;
      // retain the Axios fallback for older callers during migration.
      const responseData = err?.data || err?.details?.data || err?.response?.data || null;
      if (responseData) {
        const errorCode = err?.errorCode || responseData.errorCode;
        const errorMessage = responseData.message || err?.message;

        if (errorCode) {
          trackCheckoutError(String(errorCode));
          if (recoverInFlightPayment(String(errorCode), responseData || err, readCheckoutAttemptId())) {
            return;
          }
          const mappedCheckoutError = checkoutErrorPresentation(String(errorCode));
          if (mappedCheckoutError) {
            displayError = mappedCheckoutError.displayError;
            if (mappedCheckoutError.clearAttempt) {
              clearCheckoutIdentity();
            }
          } else {
            switch (errorCode) {
            case "CHECKOUT_QUOTE_CHANGED": {
              const nextTotal = Number(responseData.quote?.financialSummary?.total || 0);
              if (nextTotal > 0 && responseData.quote?.quoteHash) {
                setReviewedServerQuote({
                  quoteHash: String(responseData.quote.quoteHash),
                  total: nextTotal,
                });
              }
              displayError =
                nextTotal > 0
                  ? `مبلغ نهایی به ${nextTotal.toLocaleString("fa-IR")} تومان تغییر کرده است. لطفاً دوباره تلاش کنید.`
                  : "قیمت یا موجودی سبد خرید تغییر کرده است. لطفاً دوباره تلاش کنید.";
              clearCheckoutIdentity();
              break;
            }
            case "CHECKOUT_ATTEMPT_CONFLICT":
              displayError =
                "این تلاش پرداخت دیگر معتبر نیست. لطفاً دوباره ثبت سفارش را انتخاب کنید.";
              clearCheckoutIdentity();
              break;
            case "PAYMENT_INITIATION_FAILED":
            case "WALLET_DEBIT_FAILED":
              displayError = "شروع پرداخت کامل نشد. می‌توانید دوباره تلاش کنید.";
              clearCheckoutIdentity();
              break;
            case "CART_EMPTY":
              displayError = "سبد خرید شما خالی است";
              break;
            case "SHIPPING_REQUIRED":
              displayError = "لطفاً روش ارسال را انتخاب کنید";
              break;
            case "ADDRESS_REQUIRED":
              displayError = "لطفاً آدرس تحویل را انتخاب کنید";
              break;
            case "INVALID_SHIPPING":
              displayError = "روش ارسال انتخاب شده معتبر نیست";
              break;
            case "ADDRESS_NOT_FOUND":
              displayError = "آدرس انتخاب شده یافت نشد";
              break;
            case "SHIPPING_VALIDATION_FAILED":
              displayError = "خطا در بررسی روش ارسال";
              break;
            case "ADDRESS_VALIDATION_FAILED":
              displayError = "خطا در بررسی آدرس";
              break;
            // SnappPay decides eligibility from the payable amount, so this is a
            // cart problem the shopper can act on — not something to retry. Left
            // unmapped it fell through to `default`, where an untranslatable
            // "SNAPPAY_INELIGIBLE:<code>" produced the generic
            // «خطا در ثبت سفارش» and told the shopper nothing.
            case "SNAPPAY_INELIGIBLE":
              setSnappEligible(false);
              displayError =
                "پرداخت اقساطی اسنپ‌پی برای مبلغ این سفارش امکان‌پذیر نیست. لطفاً درگاه دیگری را انتخاب کنید یا مبلغ سبد خرید را تغییر دهید.";
              break;
            case "SNAPPAY_UNAVAILABLE":
              displayError =
                "پرداخت اقساطی اسنپ‌پی موقتاً در دسترس نیست. لطفاً درگاه دیگری را انتخاب کنید.";
              break;
            case "CHECKOUT_QUOTE_FAILED":
              displayError =
                "محاسبه مبلغ نهایی سفارش ممکن نشد. لطفاً روش ارسال و آدرس را بررسی کرده و دوباره تلاش کنید.";
              break;
            case "STOCK_RESERVATION_FAILED":
              displayError =
                "موجودی برخی از کالاها همین حالا تمام شد. لطفاً سبد خرید را بررسی و دوباره تلاش کنید.";
              break;
            case "DISCOUNT_USAGE_EXHAUSTED":
              displayError =
                "ظرفیت استفاده از این کد تخفیف تکمیل شده است. کد را بردارید یا کد دیگری وارد کنید.";
              break;
            case "SNAPPAY_MANUAL_REVIEW":
            case "SNAPPAY_RECONCILIATION_PENDING":
            case "ORDER_CANCELLED": {
              const leftover = leftoverCheckoutCopy(String(errorCode));
              if (leftover) displayError = leftover;
              clearCheckoutIdentity();
              break;
            }
            default:
              if (errorMessage && typeof errorMessage === "string") {
                displayError = translateErrorMessage(
                  errorMessage,
                  "خطا در ثبت سفارش. لطفاً مجددا تلاش کنید.",
                );
              }
            }
          }
        } else if (errorMessage && typeof errorMessage === "string") {
          trackCheckoutError("BACKEND_MESSAGE");
          displayError = translateErrorMessage(
            errorMessage,
            "خطا در ثبت سفارش. لطفاً مجددا تلاش کنید.",
          );
        }
      } else {
        const normalizedError = err?.message ? String(err.message).toLowerCase() : "";
        trackCheckoutError(normalizedError.includes("network") ? "NETWORK_ERROR" : "UNKNOWN_ERROR");
        displayError = getUserFacingErrorMessage(err, "خطا در ثبت سفارش. لطفاً مجددا تلاش کنید.");
      }

      failPayment(displayError);
    } finally {
      submitInProgressRef.current = false;
      setIsSubmitting(false);
    }
  };

  const onSubmit = (data: FormData) => submitOrder(data);

  const requiredAmountIrr = totalToman * 10;
  const submitOrderStep = useAtomValue(submitOrderStepAtom);

  useEffect(() => {
    if (!currentUser || totalItems <= 0 || totalPrice <= 0) return;
    trackFunnelStep("begin_checkout", {
      valueToman: totalToman,
      properties: { quantity: totalItems },
      onceKey: `begin-checkout:${Math.round(totalPrice)}:${totalItems}`,
    });
  }, [currentUser, totalItems, totalPrice, totalToman]);

  useEffect(() => {
    if (!shippingId) return;
    trackAnalyticsEvent({
      category: "checkout",
      action: "add_shipping_info",
      valueToman: shippingCost || 0,
      onceKey: `shipping-info:${shippingId}:${addressId || "new"}`,
    });
  }, [shippingId, shippingCost, addressId]);

  useEffect(() => {
    if (!gateway) return;
    trackAnalyticsEvent({
      category: "checkout",
      action: "add_payment_info",
      properties: { gateway },
      onceKey: `payment-info:${gateway}:${shippingId || "none"}`,
    });
  }, [gateway, shippingId]);

  const isMergeMode = mergeChoice === "merge";

  if (!isAuthTokenReady || userLoading || hasRedirected || (!currentUser && !hasAccessToken)) {
    return <div className="min-h-[40vh]" aria-live="polite" data-testid="checkout-auth-gate" />;
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <span className="text-lg text-neutral-800 lg:text-3xl">اطلاعات صورت حساب</span>
      {/* <CheckoutProgress
        currentStep={submitOrderStep}
        steps={["Information", "Delivery", "Payment"]}
      /> */}
      <CartStockNotice />
      {error && (
        <div
          id="checkout-form-error"
          className="flex flex-col gap-2 rounded-lg bg-red-50 p-3 text-red-600 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
          data-testid="checkout-form-error"
        >
          <span>{error}</span>
          {error !== EMPTY_CART_ERROR && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                void handleSubmit(onSubmit)();
              }}
              disabled={isSubmitting}
              data-testid="checkout-error-retry"
              className="shrink-0 self-start rounded-lg border border-red-300 bg-white px-4 py-1.5 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50 sm:self-auto"
            >
              تلاش دوباره
            </button>
          )}
        </div>
      )}

      {RESERVE_FEATURE_ENABLED && activeReserve && (
        <ReserveFulfillmentChoice
          reserve={activeReserve}
          value={mergeChoice}
          onChange={(choice) => {
            setMergeChoice(choice);
            if (choice === "merge") setReserveShipping(false);
          }}
          onExpired={handleReserveWindowClosed}
          disabled={isSubmitting}
        />
      )}

      {RESERVE_FEATURE_ENABLED && reserveWindowClosed && (
        <div
          role="status"
          data-testid="reserve-window-closed-notice"
          className="rounded-panel border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"
        >
          مهلت افزودن سفارش به بسته رزروی شما به پایان رسید. این سفارش جداگانه ارسال می‌شود؛ لطفاً
          آدرس و روش ارسال را انتخاب کنید. سبد خرید شما دست‌نخورده باقی مانده است.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ShoppingCartBillInformationForm
          register={register}
          errors={errors}
          control={control}
          setValue={setValue}
          hideAddressFields={isMergeMode}
        />

        <div className="mb-20 flex flex-col gap-6">
          {isMergeMode ? (
            <div className="flex flex-col gap-3 rounded-2xl bg-stone-50 p-5">
              <p className="text-sm leading-6 text-neutral-800">
                این اقلام به بسته رزروی شما اضافه می‌شوند و همراه سفارش‌های قبلی ارسال خواهند شد.
              </p>
              <dl className="flex flex-col gap-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-neutral-600">جمع اقلام</dt>
                  <dd className="text-neutral-900">{faNum(totalPrice)} تومان</dd>
                </div>
                {discountToman > 0 && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-neutral-600">تخفیف</dt>
                    <dd className="text-emerald-700">{faNum(discountToman)} تومان</dd>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-neutral-600">هزینه ارسال</dt>
                  <dd data-testid="reserve-merge-shipping" className="font-medium text-emerald-700">
                    ۰ تومان
                  </dd>
                </div>
              </dl>
              <p className="border-t border-stone-200 pt-3 text-lg font-medium text-infinity-primary">
                قابل پرداخت: {faNum(Math.max(0, totalPrice - discountToman))} تومان
              </p>
              <p className="text-xs leading-5 text-neutral-500">
                هزینه ارسال این بسته قبلاً با سفارش رزروی پرداخت شده است.
              </p>
            </div>
          ) : (
            <>
              <ShoppingCartBillDeliveryForm
                control={control}
                setValue={setValue}
                selectedShipping={watchShippingMethod}
                discountPreview={discountPreview}
                discountCode={discountCode}
                previewLoading={discountPreviewLoading}
                addressContext={shippingAddressContext}
              />
              {/*
                Opening a window is offered only when none is open. One active
                window per customer is a backend invariant, so showing the option
                to someone who already has a group would invite a checkout that
                `RESERVE_ALREADY_ACTIVE` is guaranteed to refuse.
              */}
              {RESERVE_FEATURE_ENABLED && !activeReserve && (
                <ReserveShipping
                  checked={reserveShipping}
                  onChange={setReserveShipping}
                  disabled={isSubmitting}
                  shippingCost={shippingToman}
                />
              )}
              {RESERVE_FEATURE_ENABLED && activeReserve && mergeChoice === "new" && (
                <p className="rounded-control border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-neutral-600">
                  چون یک بسته رزروی فعال دارید، نمی‌توانید همزمان بسته رزروی دیگری باز کنید. این
                  سفارش جداگانه و با هزینه ارسال عادی فرستاده می‌شود.
                </p>
              )}
            </>
          )}
          <ShoppingCartBillDiscountCoupon
            shippingId={watchShippingMethod ? Number(watchShippingMethod.id) : undefined}
            addressContext={shippingAddressContext}
            onApplied={(code, preview) => {
              lastDiscountPreviewKeyRef.current = buildDiscountPreviewKey({
                code,
                shippingId,
                addressContextKey,
                cartSignature,
              });
              setDiscountCode(code);
              setDiscountPreview(preview);
            }}
            appliedCode={discountCode}
            onRemove={() => {
              lastDiscountPreviewKeyRef.current = null;
              setDiscountCode(undefined);
              setDiscountPreview(undefined);
              try {
                localStorage.removeItem("discountCode");
              } catch {}
            }}
          />
          <ShoppingCartBillPaymentGateway
            selected={gateway}
            onChange={setGateway}
            availableGateways={availableGateways}
            snappEligible={snappEligible}
            snappTitle={snappTitle}
            snappDescription={snappDescription}
            walletBalanceIrr={walletBalanceIrr}
            requiredAmountIrr={requiredAmountIrr}
          />
          <Controller
            name="acceptTerms"
            control={control}
            render={({ field }) => (
              <CheckoutTermsAcceptance
                checked={!!field.value}
                onChange={(checked) => {
                  field.onChange(checked);
                  if (checked) {
                    setError((prev) => (prev === TERMS_ACCEPTANCE_ERROR ? null : prev));
                  }
                }}
                hasError={error === TERMS_ACCEPTANCE_ERROR}
                disabled={isSubmitting}
              />
            )}
          />
          <button
            type="submit"
            data-testid="checkout-submit"
            disabled={isSubmitting}
            className={
              "w-full text-nowrap rounded-lg bg-infinity-primary py-3 text-xl text-white lg:py-4 lg:text-base " +
              (isSubmitting ? "cursor-not-allowed opacity-70" : "")
            }
          >
            {isSubmitting ? "در حال پردازش..." : "پرداخت"}
          </button>
        </div>
      </div>
    </form>
  );
}

export default ShoppingCartBillForm;
