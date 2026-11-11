"use client";

import ChevronLeftIcon from "@/components/Product/Icons/ChevronLeftIcon";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { submitOrderStepAtom } from "@/atoms/Order";
import ShoppingCartBillDeliveryOptions from "./DeliveryOptions";
import { useCart } from "@/contexts/CartContext";
import { useBaleCheckoutCart } from "@/contexts/BaleCheckoutCart";
import type { ShippingAddressContext, ShippingOption } from "@/services/shipping";
import { getAvailableShippingOptions } from "@/services/shipping";
import type { Control, UseFormSetValue } from "react-hook-form";
import type { FormData } from "./index";

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

type Props = {
  control: Control<FormData>;
  setValue: UseFormSetValue<FormData>;
  selectedShipping: ShippingOption | null;
  addressContext?: ShippingAddressContext;
  discountPreview?: {
    discount: number;
    summary: {
      subtotal: number;
      eligibleSubtotal: number;
      tax: number;
      shipping: number;
      total: number;
      taxPercent: number;
    };
  };
  /** The applied discount code, shown alongside the discount line. */
  discountCode?: string;
  /** True while the discount/total is being recomputed on the server. */
  previewLoading?: boolean;
  /**
   * The wallet tender card, rendered between the delivery section and the
   * totals. It belongs here rather than beside the bank gateways because
   * ticking it changes the figures directly below it, and a shopper should see
   * that happen without scrolling.
   */
  walletTender?: React.ReactNode;
  /**
   * Credit the ticked wallet will cover, in toman, as the checkout has already
   * resolved it. Passed in rather than recomputed so the figure below the totals
   * and the figure inside the wallet card can never disagree.
   */
  walletToman?: number;
  /** Shipping method chosen in the Bale bot, selected once it is offered here. */
  preferredShippingId?: number;
};

function ShoppingCartBillDeliveryForm({
  control,
  setValue,
  selectedShipping,
  addressContext,
  discountPreview,
  discountCode,
  previewLoading,
  walletTender,
  walletToman = 0,
  preferredShippingId,
}: Props) {
  const regularCart = useCart();
  const baleCart = useBaleCheckoutCart();
  const baleCheckoutId = baleCart?.checkoutId;
  const {
    totalPrice,
    totalItems,
    subtotalBeforeDiscount,
    cartDiscountTotal,
    cartItems = [],
  } = baleCart ?? regularCart;
  const [, _setSubmitOrderStep] = useAtom(submitOrderStepAtom);
  const [shippingMethods, setShippingMethods] = useState<ShippingOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  // Calculate totals (prefer backend preview when available)
  const shippingCost = selectedShipping?.price || 0;
  const subtotal = discountPreview?.summary?.subtotal ?? subtotalBeforeDiscount;
  const discountAmount = discountPreview?.discount ?? cartDiscountTotal;
  const taxAmount = discountPreview?.summary?.tax ?? 0;
  const effectiveShipping = discountPreview?.summary?.shipping ?? shippingCost;
  const finalTotal =
    discountPreview?.summary?.total ??
    Math.max(0, subtotal - discountAmount + taxAmount + effectiveShipping);
  /**
   * The wallet is spent against this order, so it belongs in the totals as a
   * deduction: "قابل پرداخت" is what the bank gateway will actually charge, not
   * the order total. Clamped to the total so a stale credit figure can never
   * show a negative amount due.
   */
  const walletApplied = Math.min(Math.max(0, Math.round(walletToman)), finalTotal);
  const payableTotal = Math.max(0, finalTotal - walletApplied);
  const addressContextKey = useMemo(() => buildAddressContextKey(addressContext), [addressContext]);
  const cartSignature = useMemo(
    () => buildCartSignature(cartItems, totalItems, totalPrice),
    [cartItems, totalItems, totalPrice],
  );
  const hasAddressContext = Boolean(addressContext?.addressId || addressContext?.addressPayload?.shipping_city);

  useEffect(() => {
    const fetchShippingMethods = async () => {
      if (!hasAddressContext) {
        requestSeqRef.current += 1;
        setShippingMethods([]);
        setValue("shippingMethod", null);
        setError(null);
        setLoading(false);
        return;
      }

      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      try {
        setLoading(true);
        setError(null);
        const methods = baleCheckoutId
          ? await getAvailableShippingOptions(addressContext, baleCheckoutId)
          : await getAvailableShippingOptions(addressContext);
        if (requestSeqRef.current !== requestSeq) return;
        setShippingMethods(methods);
        // No default selection - let user choose explicitly
      } catch (err) {
        if (requestSeqRef.current !== requestSeq) return;
        console.error("Failed to fetch shipping methods:", err);
        setError("خطا در دریافت روش‌های ارسال");
      } finally {
        if (requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      }
    };

    fetchShippingMethods();
  }, [addressContextKey, baleCheckoutId, cartSignature, hasAddressContext, setValue]);

  const preferredAppliedRef = useRef(false);
  useEffect(() => {
    if (preferredAppliedRef.current || !preferredShippingId || selectedShipping) return;
    const preferred = shippingMethods.find((method) => Number(method.id) === preferredShippingId);
    if (!preferred) return;
    preferredAppliedRef.current = true;
    setValue("shippingMethod", preferred);
  }, [preferredShippingId, selectedShipping, setValue, shippingMethods]);

  useEffect(() => {
    if (!selectedShipping) return;
    if (shippingMethods.length === 0) return;
    if (!shippingMethods.some((method) => method.id === selectedShipping.id)) {
      setValue("shippingMethod", null);
    }
  }, [selectedShipping, setValue, shippingMethods]);

  return (
    <div className="flex flex-col gap-5 rounded-2xl bg-stone-50 p-5">
      <span className="text-3xl text-neutral-800 lg:text-2xl">جمع کل سبد خرید</span>

      <div className="flex flex-col items-end justify-between border-b border-slate-200 pb-4 lg:flex-row lg:items-center">
        <span className="text-xl w-full text-neutral-800">مجموع سبد خرید</span>
        <div className="flex items-center gap-2">
          <span className="text-base text-nowrap text-black lg:text-sm">
            {totalPrice.toLocaleString()} تومان
          </span>
          {baleCheckoutId ? (
            <a href="#bale-checkout-items" className="whitespace-nowrap text-sm text-infinity-primary underline">
              اقلام سفارش
            </a>
          ) : (
            <button className="flex items-center" type="button" onClick={regularCart.openDrawer}>
              <span className="text-sm text-nowrap text-infinity-primary lg:text-xs">مشاهده سبد خرید</span>
              <ChevronLeftIcon className="h-4 w-4 text-infinity-primary" />
            </button>
          )}
        </div>
      </div>

      <div className="border-b border-slate-200 pb-5">
        <span className="text-xl text-neutral-800">حمل و نقل</span>
        <div className="mt-2">
          {loading ? (
            <div className="flex justify-center p-4">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary"></div>
            </div>
          ) : error ? (
            <div className="p-2 text-red-500">{error}</div>
          ) : (
            <ShoppingCartBillDeliveryOptions
              shippingMethods={shippingMethods}
              control={control}
              disabled={!hasAddressContext}
            />
          )}
        </div>
      </div>

      {/* <DisclosureItem
        title={
          <span className="text-neutral-800 text-xl">انتخاب زمان ارسال</span>
        }
        className="border-b border-slate-200 pb-5"
      >
        <ShoppingCartBillDeliveryTime />
      </DisclosureItem> */}

      {walletTender}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-600 lg:text-base">جمع جزء</span>
          <span className="text-sm text-neutral-800 lg:text-base">
            {subtotal.toLocaleString()} تومان
          </span>
        </div>

        {discountAmount > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-600 lg:text-base">
              تخفیف
              {discountCode ? (
                <span className="mr-1 text-xs text-neutral-500">({discountCode})</span>
              ) : null}
            </span>
            <span className="text-sm text-green-600 lg:text-base">
              -{discountAmount.toLocaleString()} تومان
            </span>
          </div>
        )}

        {taxAmount > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-600 lg:text-base">مالیات</span>
            <span className="text-sm text-neutral-800 lg:text-base">
              {taxAmount.toLocaleString()} تومان
            </span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-600 lg:text-base">هزینه ارسال</span>
          <span className="text-sm text-neutral-800 lg:text-base">
            {effectiveShipping.toLocaleString()} تومان
          </span>
        </div>

        {walletApplied > 0 && (
          <div className="flex items-center justify-between" data-testid="checkout-wallet-deduction">
            <span className="text-sm text-neutral-600 lg:text-base">پرداخت از کیف پول</span>
            <span className="text-sm text-green-600 lg:text-base">
              -{walletApplied.toLocaleString()} تومان
            </span>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <span className="text-lg text-neutral-800 lg:text-xl">قابل پرداخت</span>
          {previewLoading ? (
            <span
              className="flex items-center gap-2 text-sm text-neutral-500"
              data-testid="checkout-total-loading"
            >
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary" />
              در حال محاسبه...
            </span>
          ) : (
            <span className="text-2xl text-infinity-primary" data-testid="checkout-payable-total">
              {payableTotal.toLocaleString()} تومان
            </span>
          )}
        </div>

        {effectiveShipping > 0 && (
          <div className="text-xs text-left text-gray-500">
            * شامل {effectiveShipping.toLocaleString()} تومان هزینه ارسال
          </div>
        )}
      </div>
    </div>
  );
}

export default ShoppingCartBillDeliveryForm;
