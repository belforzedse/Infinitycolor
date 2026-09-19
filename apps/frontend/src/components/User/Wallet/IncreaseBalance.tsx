"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { priceFormatter } from "@/utils/price";
import { normalizeDigits } from "@/utils/faNum";
import LeftUpArrowIcon from "../Icons/LeftUpArrowIcon";
import WalletService, { type WalletTopupOptions } from "@/services/wallet";
import { submitPaymentHandoff } from "@/utils/paymentHandoff";

interface IncreaseBalanceProps {
  options: WalletTopupOptions | null;
  loading?: boolean;
  /** Called once the customer is about to leave for the provider. */
  onTopupStarted?: (saleOrderId: string) => void;
  /**
   * How a plain redirect is performed. Injectable because `window.location` is
   * not writable under jsdom, and because the seam makes the redirect itself
   * assertable rather than inferred from side effects.
   */
  navigate?: (url: string) => void;
}

/**
 * Parses what the customer typed.
 *
 * Persian and Arabic-Indic digits arrive from Persian keyboards and from
 * pasted amounts, and thousand separators arrive from both. Anything else is
 * rejected rather than coerced — "۱۲a۳" must not quietly become 123.
 */
const parseAmount = (raw: string): number | null => {
  const normalized = normalizeDigits(raw).replace(/[,٬،\s]/g, "").trim();
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export { submitPaymentHandoff as goToProvider };

const IncreaseBalance = ({
  options,
  loading = false,
  onTopupStarted,
  navigate,
}: IncreaseBalanceProps) => {
  const presets = options?.presetsToman?.length
    ? options.presetsToman
    : [100_000, 200_000, 500_000, 1_000_000];
  const [amountText, setAmountText] = useState(String(presets[0] ?? 100_000));
  const [gateway, setGateway] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  // One key per intended payment. It survives re-renders and double taps, so a
  // repeated submission returns the original intent instead of opening a second
  // payment session.
  const idempotencyKey = useRef<string>("");

  useEffect(() => {
    if (!gateway && options?.gateways?.length) setGateway(options.gateways[0].code);
  }, [gateway, options]);

  const amount = useMemo(() => parseAmount(amountText), [amountText]);
  const disabled = !options?.enabled || loading || submitting;

  const validationError = useMemo(() => {
    if (!options?.enabled) return null;
    if (amountText.trim() === "") return null;
    if (amount === null) return "مبلغ را با عدد وارد کنید.";
    if (amount < options.minToman) {
      return `حداقل مبلغ شارژ ${priceFormatter(options.minToman)} تومان است.`;
    }
    if (amount > options.maxToman) {
      return `حداکثر مبلغ شارژ ${priceFormatter(options.maxToman)} تومان است.`;
    }
    return null;
  }, [amount, amountText, options]);

  const canSubmit = Boolean(options?.enabled) && amount !== null && !validationError && !disabled;

  const submit = async () => {
    if (!canSubmit || amount === null) return;
    if (!idempotencyKey.current) {
      idempotencyKey.current =
        globalThis.crypto?.randomUUID?.() ||
        `topup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    setSubmitting(true);
    try {
      const result = await WalletService.startTopup({
        amountToman: amount,
        gateway: gateway || undefined,
        idempotencyKey: idempotencyKey.current,
      });

      if (result.saleOrderId) onTopupStarted?.(result.saleOrderId);

      if (result.nextAction === "poll") {
        return;
      }
      if (result.nextAction === "complete") {
        toast.success("موجودی کیف پول به‌روزرسانی شد.");
        return;
      }
      if (!result.success || result.nextAction === "retry") {
        idempotencyKey.current = "";
        toast.error(result.message || "شروع پرداخت انجام نشد. لطفاً دوباره تلاش کنید.");
        return;
      }
      if (!submitPaymentHandoff(result, navigate)) {
        toast.error("آدرس درگاه پرداخت دریافت نشد. لطفاً دوباره تلاش کنید.");
      }
    } catch (error) {
      const payload = (error as {
        response?: {
          data?: {
            data?: {
              message?: string;
              nextAction?: "redirect" | "poll" | "complete" | "retry";
            };
          };
        };
      })?.response?.data?.data;
      // Strapi rejects 4xx responses at the HTTP client boundary. A provider
      // refusal still carries the same terminal replay contract, so discard
      // this key just as we do for a resolved `nextAction: retry` response.
      if (payload?.nextAction === "retry") idempotencyKey.current = "";
      toast.error(payload?.message || "شروع پرداخت انجام نشد. لطفاً دوباره تلاش کنید.");
      // A transport failure is ambiguous: retain the key so a retry asks the
      // server to replay the same durable intent instead of opening a second.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-wallet-topup className="flex w-full flex-col items-end gap-4 lg:w-3/5">
      <div className="h-fit w-full rounded-xl bg-slate-100 p-5">
        <span className="text-foreground-primary text-2xl lg:text-4xl">شارژ سریع کیف پول</span>

        <label
          htmlFor="wallet-topup-amount"
          className="mt-4 block text-sm text-slate-600 lg:text-base"
        >
          مبلغ شارژ (تومان)
        </label>
        <input
          id="wallet-topup-amount"
          data-testid="wallet-topup-amount"
          inputMode="numeric"
          dir="ltr"
          value={amountText}
          disabled={disabled}
          onChange={(event) => setAmountText(event.target.value)}
          className="mb-2 mt-1 h-14 w-full rounded-lg border border-slate-200 bg-white text-center text-lg text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 lg:text-3xl"
          aria-invalid={Boolean(validationError)}
          aria-describedby={validationError ? "wallet-topup-amount-error" : undefined}
        />
        {validationError ? (
          <p
            id="wallet-topup-amount-error"
            data-testid="wallet-topup-amount-error"
            className="mb-2 text-sm text-red-600"
          >
            {validationError}
          </p>
        ) : amount !== null ? (
          <p className="mb-2 text-sm text-slate-500">{priceFormatter(amount)} تومان</p>
        ) : null}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 lg:gap-3">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={disabled}
              onClick={() => setAmountText(String(preset))}
              className={`rounded-lg border bg-white px-3 py-2 ${
                amount === preset
                  ? "border-blue-500 text-lg text-blue-500 lg:text-xl"
                  : "border border-slate-100 text-slate-400 hover:border-blue-500 hover:text-blue-500"
              } text-center transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-slate-100 disabled:hover:text-slate-400`}
            >
              {priceFormatter(preset)} تومان
            </button>
          ))}
        </div>

        {(options?.gateways?.length ?? 0) > 1 ? (
          <div className="mt-4 flex flex-col gap-2">
            <span className="text-sm text-slate-600">درگاه پرداخت</span>
            <div className="flex flex-wrap gap-2">
              {options!.gateways.map((entry) => (
                <button
                  key={entry.code}
                  type="button"
                  disabled={disabled}
                  onClick={() => setGateway(entry.code)}
                  className={`rounded-lg border px-4 py-2 text-sm transition ${
                    gateway === entry.code
                      ? "border-blue-500 bg-white text-blue-600"
                      : "border-slate-200 bg-white text-slate-500 hover:border-blue-400"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        data-testid="wallet-topup-submit"
        disabled={!canSubmit}
        className="flex w-full items-center justify-center gap-1 rounded-lg bg-infinity-primary px-10 py-3 text-white disabled:cursor-not-allowed disabled:opacity-60 lg:w-fit"
        onClick={submit}
      >
        <span>{submitting ? "در حال انتقال به درگاه…" : "پرداخت آنلاین"}</span>
        <LeftUpArrowIcon />
      </button>
    </div>
  );
};

export default IncreaseBalance;
