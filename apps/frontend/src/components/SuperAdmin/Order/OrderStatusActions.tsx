"use client";

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import {
  changeOrderStatus,
  cancelOrder,
  type OrderLifecycleStatus,
} from "@/services/super-admin/orders/adjustItems";
import { getOrderStatusCategory, translateOrderStatus } from "@/utils/statusTranslations";
import { PersianOrderStatus } from "@/constants/enums";

type Props = {
  order: SuperAdminOrderDetail;
  onSuccess: () => void;
};

type PendingAction =
  | { kind: "status"; status: OrderLifecycleStatus; label: string }
  | { kind: "cancel" }
  | null;

// Quick status transitions offered as prominent buttons. Each targets a single
// backend Status; the bucket labels match the storefront categories.
const STATUS_ACTIONS: { status: OrderLifecycleStatus; label: string; bucket: PersianOrderStatus }[] =
  [
    { status: "Started", label: "در حال انجام", bucket: PersianOrderStatus.INPROGRESS },
    { status: "Done", label: "تکمیل شده", bucket: PersianOrderStatus.DELIVERED },
  ];

export default function OrderStatusActions({ order, onSuccess }: Props) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [loading, setLoading] = useState(false);

  const currentBucket = useMemo(
    () => getOrderStatusCategory(order.orderStatus),
    [order.orderStatus],
  );
  // SnappPay cancellations are irreversible — warn explicitly before cancelling.
  const isSnappPayOrder = Boolean(order.transactionId && order.paymentToken);
  const isCancelled = currentBucket === PersianOrderStatus.CANCELLED;

  const runAction = async () => {
    if (!pending || loading) return;
    setLoading(true);
    try {
      if (pending.kind === "status") {
        await changeOrderStatus(String(order.id), pending.status);
        toast.success(`وضعیت سفارش به «${pending.label}» تغییر کرد`);
      } else {
        await cancelOrder(order.id);
        toast.success("سفارش لغو شد");
      }
      setPending(null);
      onSuccess();
    } catch (error: unknown) {
      const message =
        (error as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        "عملیات با خطا مواجه شد";
      toast.error(typeof message === "string" ? message : "عملیات با خطا مواجه شد");
    } finally {
      setLoading(false);
    }
  };

  const confirmDescription = (() => {
    if (!pending) return "";
    if (pending.kind === "cancel") {
      const base =
        "این عملیات سفارش را لغو می‌کند، موجودی را بازمی‌گرداند و مبلغ پرداختی به مشتری بازگردانده می‌شود.";
      return isSnappPayOrder
        ? `${base} توجه: لغو سفارش‌های اسنپ‌پی «غیرقابل بازگشت» است؛ لطفاً از این تصمیم مطمئن شوید.`
        : base;
    }
    return `وضعیت سفارش از «${translateOrderStatus(order.orderStatus)}» به «${pending.label}» تغییر می‌کند.`;
  })();

  return (
    <div
      dir="rtl"
      className="mb-6 rounded-lg border border-slate-200 bg-white p-6 text-right shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-slate-900">مدیریت وضعیت سفارش</h3>
        <span className="text-sm text-slate-500">
          وضعیت فعلی: <span className="font-medium text-slate-800">{translateOrderStatus(order.orderStatus)}</span>
        </span>
      </div>

      <div className="flex flex-wrap gap-3">
        {STATUS_ACTIONS.map((action) => {
          const isCurrent = currentBucket === action.bucket;
          return (
            <button
              key={action.status}
              type="button"
              disabled={loading || isCurrent}
              onClick={() => setPending({ kind: "status", status: action.status, label: action.label })}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              title={isCurrent ? "سفارش هم‌اکنون در این وضعیت است" : undefined}
            >
              تغییر وضعیت به «{action.label}»
            </button>
          );
        })}

        <button
          type="button"
          disabled={loading || isCancelled}
          onClick={() => setPending({ kind: "cancel" })}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          title={isCancelled ? "این سفارش قبلاً لغو شده است" : undefined}
        >
          لغو سفارش
        </button>
      </div>

      <ConfirmDialog
        isOpen={!!pending}
        title={pending?.kind === "cancel" ? "تأیید لغو سفارش" : "تأیید تغییر وضعیت"}
        description={confirmDescription}
        confirmText={loading ? "در حال انجام..." : pending?.kind === "cancel" ? "لغو سفارش" : "تایید و ذخیره"}
        cancelText="انصراف"
        onConfirm={runAction}
        onCancel={() => {
          if (loading) return;
          setPending(null);
        }}
      />
    </div>
  );
}
