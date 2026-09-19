"use client";
import React from "react";
import type { PaymentCapabilities } from "@repo/api/commerce";
import { priceFormatter } from "@/utils/price";

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
  disabled?: boolean;
}

/** IRR to spendable toman, always rounding down — see the server's irrToSpendableToman. */
export const irrToToman = (amountIrr: number): number =>
  Math.max(0, Math.floor(Number(amountIrr || 0) / 10));

/**
 * How much credit a ticked wallet box spends: as much of the order as the
 * shopper has, and no more.
 *
 * Deliberately not a free amount. A shopper choosing an exact figure has to
 * reason about two tenders at once, and every distinct figure is a distinct
 * quote and a distinct payment attempt. One decision — use my credit or don't —
 * keeps the arithmetic the store's job.
 */
export const walletContributionToman = (availableIrr: number, totalToman: number): number =>
  Math.min(irrToToman(availableIrr), Math.max(0, Math.round(totalToman)));

/**
 * The wallet as a tender the shopper ticks, above the bank gateways.
 *
 * Wallet credit is not a payment gateway: it is money already at the store, and
 * whatever it does not cover is charged to whichever bank the shopper picks
 * below. Presenting it as a fifth gateway made those mutually exclusive, which
 * they never were.
 */
export default function WalletContribution({
  totalToman,
  availableIrr,
  heldIrr,
  capabilities,
  enabled,
  onEnabledChange,
  disabled = false,
}: WalletContributionProps) {
  const availableToman = irrToToman(availableIrr);
  const heldToman = irrToToman(heldIrr);
  const walletToman = enabled ? walletContributionToman(availableIrr, totalToman) : 0;
  const gatewayToman = Math.max(0, Math.round(totalToman) - walletToman);
  const coversWholeOrder = walletToman > 0 && gatewayToman === 0;
  // A split the server will not accept is worth saying before the shopper
  // commits to it, not after the order is refused.
  const splitRefused = Boolean(
    walletToman > 0 && gatewayToman > 0 && capabilities && !capabilities.splitEnabled,
  );

  if (!capabilities?.walletEnabled || availableToman <= 0) return null;

  return (
    <section
      data-testid="wallet-contribution"
      className="flex flex-col gap-3 rounded-lg border border-stone-100 bg-stone-50 p-4"
      dir="rtl"
    >
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span className="flex flex-col gap-1">
          <span className="text-base text-neutral-800 lg:text-lg">استفاده از کیف پول</span>
          <span className="text-sm text-neutral-600" data-testid="wallet-contribution-available">
            موجودی قابل استفاده: {priceFormatter(availableToman)} تومان
          </span>
          {heldToman > 0 ? (
            <span className="text-xs text-neutral-500" data-testid="wallet-contribution-held">
              {priceFormatter(heldToman)} تومان برای یک پرداخت در حال انجام رزرو شده است.
            </span>
          ) : null}
        </span>
        <input
          type="checkbox"
          data-testid="wallet-contribution-toggle"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 accent-infinity-primary disabled:cursor-not-allowed disabled:opacity-60"
        />
      </label>

      {enabled ? (
        <>
          {splitRefused ? (
            <p className="text-sm text-amber-700" data-testid="wallet-contribution-split-refused">
              پرداخت ترکیبی کیف پول و درگاه در حال حاضر فعال نیست. برای استفاده از کیف پول، باید کل
              مبلغ سفارش از موجودی شما پرداخت شود.
            </p>
          ) : null}

          <dl
            data-testid="wallet-contribution-summary"
            className="flex flex-col gap-1 border-t border-stone-200 pt-3 text-sm text-neutral-700"
          >
            <div className="flex justify-between">
              <dt>مبلغ سفارش</dt>
              <dd>{priceFormatter(Math.max(0, Math.round(totalToman)))} تومان</dd>
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
