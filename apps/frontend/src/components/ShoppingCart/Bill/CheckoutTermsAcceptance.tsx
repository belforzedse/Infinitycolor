"use client";

import Link from "next/link";
import { RETURNS_PATH } from "@/constants/legal";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  hasError?: boolean;
  disabled?: boolean;
}

/**
 * Required consent before payment. The policy link opens in a new tab so the
 * shopper does not lose checkout form state.
 */
function CheckoutTermsAcceptance({ checked, onChange, hasError, disabled }: Props) {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-3 ${
        hasError ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"
      }`}
      data-testid="checkout-terms"
    >
      <input
        type="checkbox"
        id="acceptTerms"
        name="acceptTerms"
        data-testid="checkout-accept-terms"
        className="mt-1 h-4 w-4 shrink-0 accent-infinity-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-required="true"
        aria-invalid={hasError || undefined}
      />
      <label htmlFor="acceptTerms" className="text-sm leading-6 text-neutral-700">
        <Link
          href={RETURNS_PATH}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-infinity-primary underline underline-offset-2"
          onClick={(event) => event.stopPropagation()}
        >
          قوانین و مقررات سایت
        </Link>{" "}
        را خوانده‌ام و قبول دارم
      </label>
    </div>
  );
}

export default CheckoutTermsAcceptance;
