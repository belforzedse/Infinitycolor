"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/services";
import { priceFormatter } from "@/utils/price";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

export type StrandedTopup = {
  id: number;
  saleOrderId: string;
  status: string;
  gateway: string;
  amountToman: number;
  userId: number | null;
  owner: string | null;
  providerReference: string | null;
  reconcileAttempts: number;
  lastProviderCode: number | string | null;
  lastProviderError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const formatMoment = (value: string | null): string => {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("fa-IR");
};

/**
 * Top-ups the reconciliation ladder gave up on.
 *
 * These are `Unknown` with nothing scheduled to look again: the provider never
 * answered in a way the store could act on, so the customer may or may not have
 * been charged. Nothing automatic will revisit them, which is the whole reason
 * they need a person. Resolving one means checking the provider's own records
 * and, if money did move, crediting the wallet by hand from the card below.
 */
export default function TopupReviewQueue({
  onSelectOwner,
}: {
  onSelectOwner?: (userId: number) => void;
}) {
  const [rows, setRows] = useState<StrandedTopup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<{
        data?: { topups?: StrandedTopup[] };
        topups?: StrandedTopup[];
      }>("/wallet/topups/admin/review?limit=50", { cache: "no-store" });
      const payload = response as any;
      setRows(payload?.data?.topups ?? payload?.topups ?? []);
    } catch (cause) {
      setRows([]);
      setError(
        getUserFacingErrorMessage(cause, "دریافت فهرست شارژهای بلاتکلیف ناموفق بود."),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      className="rounded-2xl border border-neutral-200 bg-white p-5"
      aria-label="شارژهای نیازمند بررسی"
      data-testid="topup-review-queue"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-neutral-900">شارژهای نیازمند بررسی</h2>
          <p className="mt-1 text-sm text-neutral-600">
            پیگیری خودکار این درخواست‌ها به نتیجه نرسیده است. وضعیت را در پنل درگاه بررسی کنید و در
            صورت کسر وجه، موجودی را دستی اصلاح کنید.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="shrink-0 rounded-xl border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? "در حال بارگذاری…" : "بروزرسانی"}
        </button>
      </div>

      {error ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : rows == null ? (
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-neutral-500">در حال بارگذاری…</p>
      ) : rows.length === 0 ? (
        <p
          className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-neutral-500"
          data-testid="topup-review-empty"
        >
          موردی برای بررسی وجود ندارد.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead className="text-neutral-500">
              <tr>
                <th className="py-2 font-medium">شناسه پرداخت</th>
                <th className="py-2 font-medium">مشتری</th>
                <th className="py-2 font-medium">مبلغ</th>
                <th className="py-2 font-medium">درگاه</th>
                <th className="py-2 font-medium">کد/خطای درگاه</th>
                <th className="py-2 font-medium">آخرین تلاش</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100" data-testid="topup-review-row">
                  <td className="py-2">
                    <span dir="ltr" className="inline-block text-neutral-800">
                      {row.saleOrderId || "—"}
                    </span>
                    {row.providerReference ? (
                      <span dir="ltr" className="block text-xs text-neutral-500">
                        {row.providerReference}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    {row.userId && onSelectOwner ? (
                      <button
                        type="button"
                        onClick={() => onSelectOwner(row.userId as number)}
                        className="text-blue-600 hover:underline"
                      >
                        {row.owner || `کاربر ${row.userId}`}
                      </button>
                    ) : (
                      <span className="text-neutral-700">{row.owner || "—"}</span>
                    )}
                  </td>
                  <td className="py-2 text-neutral-900">
                    {priceFormatter(row.amountToman, " تومان")}
                  </td>
                  <td className="py-2 text-neutral-700">{row.gateway || "—"}</td>
                  <td className="py-2 text-neutral-700">
                    {row.lastProviderCode ?? "—"}
                    {row.lastProviderError ? (
                      <span className="block text-xs text-neutral-500">{row.lastProviderError}</span>
                    ) : null}
                  </td>
                  <td className="py-2 text-neutral-600">
                    {formatMoment(row.updatedAt)}
                    <span className="block text-xs text-neutral-500">
                      {row.reconcileAttempts} تلاش
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
