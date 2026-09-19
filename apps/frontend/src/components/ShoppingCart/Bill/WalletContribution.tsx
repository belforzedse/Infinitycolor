"use client";
import React, { useMemo } from "react";
import type { PaymentCapabilities } from "@repo/api/commerce";
import { priceFormatter } from "@/utils/price";
import { normalizeDigits } from "@/utils/faNum";

export interface WalletContributionProps {
  /** Order total in toman. */
  totalToman: number;
  /** Spendable now: posted balance minus anything a live checkout holds, in IRR. */
  availableIrr: number;
  /** Committed to another of this customer's checkouts, in IRR. */
  heldIrr: number;
  capabilities: PaymentCapabilities | null;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Raw text, so Persian digits survive until the server normalises them. */
  amountText: string;
  onAmountTextChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Parses the typed amount without ever coercing something ambiguous into a
 * number. The server re-validates; this only decides what to show.
 */
export const parseWalletAmount = (raw: string): number | null => {
  const normalized = normalizeDigits(raw).replace(/[,٬،\s]/g, "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** IRR to spendable toman, always rounding down — see the server's irrToSpendableToman. */
export const irrToToman = (amountIrr: number): number =>
  Math.max(0, Math.floor(Number(amountIrr || 0) / 10));

/**
 * Choosing how much of an order to pay from wallet credit.
 *
 * Wallet credit is a tender, not a discount: the order total never moves, and
 * whatever the wallet does not cover is charged to the selected gateway.
 */
export default function WalletContribution({
  totalToman,
  availableIrr,
  heldIrr,
  capabilities,
  enabled,
  onEnabledChange,
  amountText,
  onAmountTextChange,
  disabled = false,
}: WalletContributionProps) {
  const availableToman = irrToToman(availableIrr);
  const heldToman = irrToToman(heldIrr);
  const maxToman = Math.min(availableToman, Math.max(0, Math.round(totalToman)));
  const amount = useMemo(() => parseWalletAmount(amountText), [amountText]);

  const error = useMemo(() => {
    if (!enabled) return null;
    if (amountText.trim() === "") return null;
    if (amount === null) return "مبلغ را با عدد وارد کنید.";
    if (amount > availableToman) return "موجودی قابل استفاده کیف پول کافی نیست. مبلغ را تغییر دهید.";
    if (amount > totalToman) return "مبلغ کیف پول از مبلغ سفارش بیشتر است.";
    return null;
  }, [amount, amountText, availableToman, enabled, totalToman]);

  const walletToman = enabled && amount !== null && !error ? amount : 0;
  const gatewayToman = Math.max(0, Math.round(totalToman) - walletToman);
  const coversWholeOrder = walletToman > 0 && gatewayToman === 0;

  if (!capabilities?.walletEnabled || availableToman <= 0) return null;

  return (
    <section
      data-testid="wallet-contribution"
      className="flex flex-col gap-3 rounded-lg border border-stone-100 bg-stone-50 p-4"
      dir="rtl"
    >
      <label className="flex items-center justify-between gap-3">
        <span className="text-base text-neutral-800 lg:text-lg">استفاده از کیف پول</span>
        <input
          type="checkbox"
          data-testid="wallet-contribution-toggle"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          className="h-5 w-5 accent-infinity-primary disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>

      <p className="text-sm text-neutral-600">
        موجودی قابل استفاده: {priceFormatter(availableToman)} تومان
        {heldToman > 0 ? (
          <span className="block text-xs text-neutral-500">
            {priceFormatter(heldToman)} تومان برای یک پرداخت در حال انجام رزرو شده است.
          </span>
        ) : null}
      </p>

      {enabled ? (
        <>
          <div className="flex items-center gap-2">
            <input
              data-testid="wallet-contribution-input"
              inputMode="numeric"
              dir="ltr"
              value={amountText}
              disabled={disabled}
              onChange={(event) => onAmountTextChange(event.target.value)}
              aria-label="مبلغ پرداخت از کیف پول"
              aria-invalid={Boolean(error)}
              className="h-11 flex-1 rounded-lg border border-stone-200 bg-white text-center text-base text-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              data-testid="wallet-contribution-max"
              disabled={disabled || maxToman <= 0}
              onClick={() => onAmountTextChange(String(maxToman))}
              className="whitespace-nowrap rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              حداکثر موجودی
            </button>
          </div>

          {error ? (
            <p data-testid="wallet-contribution-error" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}

          {!capabilities.splitEnabled && walletToman > 0 && gatewayToman > 0 ? (
            <p className="text-sm text-amber-700">
              پرداخت ترکیبی کیف پول و درگاه در حال حاضر فعال نیست. برای استفاده از کیف پول، کل مبلغ
              سفارش را از موجودی خود بپردازید.
            </p>
          ) : null}

          <dl
            data-testid="wallet-contribution-summary"
            className="flex flex-col gap-1 border-t border-stone-200 pt-3 text-sm text-neutral-700"
          >
            <div className="flex justify-between">
              <dt>مبلغ سفارش</dt>
              <dd>{priceFormatter(totalToman)} تومان</dd>
            </div>
            <div className="flex justify-between">
              <dt>پرداخت از کیف پول</dt>
              <dd data-testid="wallet-contribution-wallet-leg">
                {priceFormatter(walletToman)} تومان
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>پرداخت از درگاه</dt>
              <dd data-testid="wallet-contribution-gateway-leg">
                {priceFormatter(gatewayToman)} تومان
              </dd>
            </div>
          </dl>

          {coversWholeOrder ? (
            <p className="text-sm text-neutral-600">
              موجودی کیف پول کل مبلغ سفارش را پوشش می‌دهد و نیازی به درگاه بانکی نیست.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
