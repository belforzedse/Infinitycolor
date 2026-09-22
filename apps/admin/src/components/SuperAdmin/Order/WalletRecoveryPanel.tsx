"use client";

import { useEffect, useState } from "react";
import {
  getWalletRecovery,
  type WalletRecoveryDiagnostics,
} from "@/services/super-admin/orders/walletRecovery";
import { priceFormatter, rialToToman } from "@/utils/price";

/**
 * Why this order's wallet credit is where it is.
 *
 * Operators previously had to reconstruct this from `provider_response`, which
 * is overwritten by every later observation — the reason 56 settled production
 * attempts still show a stale `providerCode: 1007` beside a successful settle.
 * The evidence rows below are append-only and are the actual record of any
 * automatic decision.
 */
export default function WalletRecoveryPanel({ orderId }: { orderId: number }) {
  const [data, setData] = useState<WalletRecoveryDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWalletRecovery(orderId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String((err as Error)?.message || err));
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (error) {
    return <p className="text-sm text-red-600">خطا در دریافت وضعیت کیف پول: {error}</p>;
  }
  if (!data) return <p className="text-sm text-neutral-500">در حال دریافت…</p>;
  if (!data.attempt) {
    return <p className="text-sm text-neutral-500">تلاش پرداختی برای این سفارش ثبت نشده است.</p>;
  }

  const { attempt, evidence } = data;
  const wallet = attempt.wallet;

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="wallet-recovery-panel">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <dt className="text-neutral-500">وضعیت رزرو کیف پول</dt>
        <dd>{wallet.holdStatus ?? "—"}{wallet.state ? ` (${wallet.state})` : ""}</dd>
        <dt className="text-neutral-500">مبلغ رزرو</dt>
        <dd className="tabular-nums">
          {wallet.amountIrr > 0
            ? `${priceFormatter(rialToToman(wallet.amountIrr))} تومان`
            : "—"}
        </dd>
        <dt className="text-neutral-500">علت آزادسازی</dt>
        <dd>{wallet.releaseReason ?? "—"}</dd>
        <dt className="text-neutral-500">وضعیت تلاش</dt>
        <dd>
          {attempt.status}
          {attempt.providerStatus ? ` / ${attempt.providerStatus}` : ""}
        </dd>
        <dt className="text-neutral-500">کد خطا</dt>
        <dd>{attempt.failureCode ?? "—"}</dd>
        <dt className="text-neutral-500">آخرین پاسخ درگاه</dt>
        <dd className="tabular-nums">
          {String(attempt.lastProviderRead.endpoint ?? "—")}
          {attempt.lastProviderRead.httpStatus
            ? ` · HTTP ${String(attempt.lastProviderRead.httpStatus)}`
            : ""}
          {attempt.lastProviderRead.providerCode
            ? ` · کد ${String(attempt.lastProviderRead.providerCode)}`
            : ""}
        </dd>
      </dl>

      <div>
        <h4 className="mb-2 font-medium">سوابق تصمیم‌های بازیابی</h4>
        {evidence.length === 0 ? (
          <p className="text-neutral-500">هیچ تصمیم بازیابی برای این تلاش ثبت نشده است.</p>
        ) : (
          <table className="w-full text-right text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-1">زمان</th>
                <th className="py-1">نوع</th>
                <th className="py-1">حالت</th>
                <th className="py-1">تصمیم</th>
                <th className="py-1">وضعیت درگاه</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((row) => (
                <tr key={row.id} className="border-t border-neutral-100">
                  <td className="py-1 tabular-nums">
                    {row.observedAt ? new Date(row.observedAt).toLocaleString("fa-IR") : "—"}
                  </td>
                  <td className="py-1">{row.kind}</td>
                  <td className="py-1">{row.mode}</td>
                  <td className="py-1">{row.decision}</td>
                  <td className="py-1">
                    {row.providerStatus ?? (row.providerCode ? `کد ${row.providerCode}` : "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
