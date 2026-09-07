"use client";

import { Fragment, useEffect, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { toast } from "react-hot-toast";
import WalletService, {
  type WalletAdjustMode,
  type WalletTransaction,
} from "@/services/wallet";
import { priceFormatter } from "@/utils/price";

const MODE_LABELS: Record<WalletAdjustMode, string> = {
  credit: "افزایش موجودی",
  debit: "کاهش موجودی",
  set: "تنظیم به مقدار مشخص",
};

type Props = {
  userId: number;
};

/**
 * Founder/Superadmin wallet editor. Shows the current balance and fixed-projection
 * history, and permits credit/debit/set with a required reason. The backend
 * (`/local-user-wallet/admin/*`) validates the amount, prevents negative balances,
 * records a ledger transaction, and writes an admin audit entry.
 */
export default function WalletAdjustCard({ userId }: Props) {
  const [balanceToman, setBalanceToman] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [mode, setMode] = useState<WalletAdjustMode>("credit");
  const [amount, setAmount] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoadingBalance(true);
        const [res, history] = await Promise.all([
          WalletService.adminGetUserWallet(userId),
          WalletService.adminGetUserWalletHistory(userId),
        ]);
        if (!cancelled && res?.success && res.data) {
          setBalanceToman(res.data.balanceToman);
        }
        if (!cancelled) setTransactions(history?.data ?? []);
      } catch (err) {
        console.error("Failed to load wallet balance:", err);
      } finally {
        if (!cancelled) setLoadingBalance(false);
      }
    };
    if (userId) load();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && Number.isInteger(amountNum) && amountNum > 0;
  const reasonValid = reason.trim().length > 0;
  const canSubmit = amountValid && reasonValid && !submitting;

  // Preview the resulting balance for the confirmation dialog.
  const projectedToman = (() => {
    if (balanceToman == null || !amountValid) return null;
    if (mode === "credit") return balanceToman + amountNum;
    if (mode === "debit") return balanceToman - amountNum;
    return amountNum; // set
  })();
  const projectedNegative = projectedToman != null && projectedToman < 0;

  const handleApply = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await WalletService.adminAdjustWallet(userId, {
        mode,
        amountToman: amountNum,
        reason: reason.trim(),
      });
      if (res?.success && res.data) {
        setBalanceToman(res.data.balanceToman);
        setAmount("");
        setReason("");
        setShowConfirm(false);
        const history = await WalletService.adminGetUserWalletHistory(userId);
        setTransactions(history?.data ?? []);
        toast.success("موجودی کیف پول با موفقیت بروزرسانی شد");
      } else {
        toast.error(res?.message || "خطا در بروزرسانی موجودی کیف پول");
      }
    } catch (err: any) {
      const message =
        err?.response?.data?.message ||
        err?.data?.message ||
        err?.message ||
        "خطا در بروزرسانی موجودی کیف پول";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white p-6">
      <h2 className="mb-4 text-xl font-bold text-neutral-900">کیف پول کاربر</h2>

      <div className="mb-6 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <span className="text-sm text-neutral-600">موجودی فعلی</span>
        <span className="text-lg font-bold text-neutral-900">
          {loadingBalance
            ? "..."
            : priceFormatter(balanceToman ?? 0, " تومان")}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <label className="mb-1 block text-sm text-neutral-600">نوع تغییر</label>
          <select
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as WalletAdjustMode)}
            disabled={submitting}
          >
            {(Object.keys(MODE_LABELS) as WalletAdjustMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label className="mb-1 block text-sm text-neutral-600">
            مبلغ (تومان)
          </label>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder="مثلا ۵۰۰۰۰"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className="md:col-span-3">
          <label className="mb-1 block text-sm text-neutral-600">
            دلیل تغییر <span className="text-red-500">*</span>
          </label>
          <textarea
            rows={2}
            placeholder="مثلاً عودت وجه سفارش ۱۲۳۴۵"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          className="rounded-xl bg-actions-primary px-5 py-2 text-sm text-white disabled:opacity-50"
          onClick={() => setShowConfirm(true)}
          disabled={!canSubmit}
        >
          اعمال تغییر
        </button>
      </div>

      <section className="mt-6 border-t border-slate-200 pt-5">
        <h3 className="mb-3 text-base font-bold text-neutral-900">تاریخچه تراکنش‌ها</h3>
        {transactions.length === 0 ? (
          <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-neutral-500">
            تراکنشی ثبت نشده است.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-neutral-600">
                <tr>
                  <th className="px-3 py-2 text-right">نوع</th>
                  <th className="px-3 py-2 text-right">مبلغ</th>
                  <th className="px-3 py-2 text-right">دلیل</th>
                  <th className="px-3 py-2 text-right">تاریخ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td className="px-3 py-2">
                      {transaction.Type === "Add" ? "افزایش" : "کاهش"}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {priceFormatter(Math.round(Number(transaction.Amount || 0) / 10), " تومان")}
                    </td>
                    <td className="max-w-64 px-3 py-2 text-neutral-600">
                      {transaction.Note || transaction.Cause || "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                      {transaction.Date
                        ? new Intl.DateTimeFormat("fa-IR", {
                            dateStyle: "short",
                            timeStyle: "short",
                          }).format(new Date(transaction.Date))
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Transition appear show={showConfirm} as={Fragment}>
        <Dialog
          as="div"
          className="relative z-[1300]"
          onClose={() => {
            if (!submitting) setShowConfirm(false);
          }}
        >
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black bg-opacity-50" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-right">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 align-middle shadow-xl transition-all">
                  <Dialog.Title as="h3" className="mb-4 text-lg font-bold text-neutral-900">
                    تأیید تغییر موجودی
                  </Dialog.Title>
                  <div className="mb-6 space-y-2 text-sm text-neutral-700">
                    <p>
                      نوع تغییر: <span className="font-semibold">{MODE_LABELS[mode]}</span>
                    </p>
                    <p>
                      مبلغ:{" "}
                      <span className="font-semibold">
                        {priceFormatter(amountNum, " تومان")}
                      </span>
                    </p>
                    {projectedToman != null && (
                      <p>
                        موجودی پس از تغییر:{" "}
                        <span
                          className={`font-semibold ${
                            projectedNegative ? "text-red-600" : "text-green-700"
                          }`}
                        >
                          {priceFormatter(projectedToman, " تومان")}
                        </span>
                      </p>
                    )}
                    {projectedNegative && (
                      <p className="text-xs text-red-600">
                        موجودی نمی‌تواند منفی شود؛ این درخواست رد خواهد شد.
                      </p>
                    )}
                    <p className="text-xs text-neutral-500">دلیل: {reason.trim()}</p>
                  </div>
                  <div className="flex items-center justify-start gap-3">
                    <button
                      type="button"
                      className="rounded-xl bg-actions-primary px-5 py-2.5 text-white hover:brightness-110 disabled:opacity-50"
                      onClick={handleApply}
                      disabled={submitting || projectedNegative}
                    >
                      {submitting ? "در حال اعمال..." : "تأیید و اعمال"}
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border border-slate-200 px-5 py-2.5 text-neutral-700 hover:bg-slate-50 disabled:opacity-50"
                      onClick={() => setShowConfirm(false)}
                      disabled={submitting}
                    >
                      انصراف
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </div>
  );
}
