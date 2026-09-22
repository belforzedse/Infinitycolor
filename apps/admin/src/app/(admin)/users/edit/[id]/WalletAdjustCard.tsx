"use client";

import { Fragment, useEffect, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { toast } from "react-hot-toast";
import WalletService, {
  type WalletAdjustMode,
  type WalletTransaction,
} from "@/services/wallet";
import { priceFormatter } from "@/utils/price";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

const MODE_LABELS: Record<WalletAdjustMode, string> = {
  credit: "افزایش موجودی",
  debit: "کاهش موجودی",
  set: "تنظیم به مقدار مشخص",
};

type Props = {
  userId: number;
  customerName?: string;
  customerPhone?: string | null;
  /** Backend still refuses self-adjust; hide the form when the target is the actor. */
  allowAdjust?: boolean;
};

/**
 * Founder/Superadmin wallet editor. Shows the current balance and fixed-projection
 * history, and permits credit/debit/set with a required reason. The backend
 * (`/local-user-wallet/admin/*`) validates the amount, prevents negative balances,
 * records a ledger transaction, and writes an admin audit entry.
 */
export default function WalletAdjustCard({
  userId,
  customerName,
  customerPhone,
  allowAdjust = true,
}: Props) {
  const [balanceToman, setBalanceToman] = useState<number | null>(null);
  // What a live checkout of this customer's has already committed. An operator
  // who cannot see it will read a refused debit as a bug.
  const [heldToman, setHeldToman] = useState<number>(0);
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
          setHeldToman(Number(res.data.heldToman ?? 0));
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

  const availableToman = Math.max(0, (balanceToman ?? 0) - heldToman);

  // Preview the resulting balance for the confirmation dialog.
  const projectedToman = (() => {
    if (balanceToman == null || !amountValid) return null;
    if (mode === "credit") return balanceToman + amountNum;
    if (mode === "debit") return balanceToman - amountNum;
    return amountNum; // set
  })();
  const projectedNegative = projectedToman != null && projectedToman < 0;
  // The server refuses any balance that would fall below what is held, so say
  // so here rather than letting the operator submit into a rejection.
  const projectedBelowHeld =
    projectedToman != null && !projectedNegative && heldToman > 0 && projectedToman < heldToman;

  const handleApply = async () => {
    if (!canSubmit || !allowAdjust) return;
    setSubmitting(true);
    try {
      const res = await WalletService.adminAdjustWallet(userId, {
        mode,
        amountToman: amountNum,
        reason: reason.trim(),
      });
      if (res?.success && res.data) {
        setBalanceToman(res.data.balanceToman);
        setHeldToman(Number(res.data.heldToman ?? 0));
        setAmount("");
        setReason("");
        setShowConfirm(false);
        const history = await WalletService.adminGetUserWalletHistory(userId);
        setTransactions(history?.data ?? []);
        toast.success("موجودی کیف پول با موفقیت بروزرسانی شد");
      } else {
        toast.error(
          getUserFacingErrorMessage(res, "خطا در بروزرسانی موجودی کیف پول. دوباره تلاش کنید."),
        );
      }
    } catch (err: unknown) {
      toast.error(
        getUserFacingErrorMessage(err, "خطا در بروزرسانی موجودی کیف پول. دوباره تلاش کنید."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white p-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold text-neutral-900">کیف پول کاربر</h2>
        {(customerName || customerPhone) && (
          <p className="mt-1 text-sm text-neutral-600" data-testid="wallet-adjust-customer">
            {customerName ? <span className="font-medium text-neutral-800">{customerName}</span> : null}
            {customerName && customerPhone ? " · " : null}
            {customerPhone ? (
              <span dir="ltr" className="inline-block">
                {customerPhone}
              </span>
            ) : null}
          </p>
        )}
      </div>

      <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-600">موجودی فعلی</span>
          <span className="text-lg font-bold text-neutral-900" data-testid="wallet-balance">
            {loadingBalance ? "..." : priceFormatter(balanceToman ?? 0, " تومان")}
          </span>
        </div>
        {!loadingBalance && heldToman > 0 ? (
          <>
            <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2">
              <span className="text-sm text-neutral-600">رزرو شده برای پرداخت در جریان</span>
              <span className="text-sm font-medium text-amber-700" data-testid="wallet-held">
                {priceFormatter(heldToman, " تومان")}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm text-neutral-600">قابل استفاده</span>
              <span className="text-sm font-medium text-neutral-900" data-testid="wallet-available">
                {priceFormatter(availableToman, " تومان")}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {allowAdjust ? (
        <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <label htmlFor="wallet-adjust-mode" className="mb-1 block text-sm text-neutral-600">
            نوع تغییر
          </label>
          <select
            id="wallet-adjust-mode"
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
          <label htmlFor="wallet-adjust-amount" className="mb-1 block text-sm text-neutral-600">
            مبلغ (تومان)
          </label>
          <input
            id="wallet-adjust-amount"
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
          <label htmlFor="wallet-adjust-reason" className="mb-1 block text-sm text-neutral-600">
            دلیل تغییر <span className="text-red-500">*</span>
          </label>
          <textarea
            id="wallet-adjust-reason"
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
        </>
      ) : (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          data-testid="wallet-self-adjust-notice"
        >
          تغییر موجودی کیف پول خودتان مجاز نیست.
        </p>
      )}

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

      <Transition appear show={showConfirm && allowAdjust} as={Fragment}>
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
                            projectedNegative || projectedBelowHeld
                              ? "text-red-600"
                              : "text-green-700"
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
                    {projectedBelowHeld && (
                      <p className="text-xs text-red-600" data-testid="wallet-below-held">
                        موجودی نمی‌تواند کمتر از مبلغ رزرو شده ({priceFormatter(heldToman, " تومان")})
                        شود؛ این درخواست رد خواهد شد.
                      </p>
                    )}
                    <p className="text-xs text-neutral-500">دلیل: {reason.trim()}</p>
                  </div>
                  <div className="flex items-center justify-start gap-3">
                    <button
                      type="button"
                      className="rounded-xl bg-actions-primary px-5 py-2.5 text-white hover:brightness-110 disabled:opacity-50"
                      onClick={handleApply}
                      disabled={submitting || projectedNegative || projectedBelowHeld}
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
