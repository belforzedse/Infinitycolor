"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import {
  changeOrderStatus,
  cancelOrder,
  formatSnappayOperationFailure,
  waitForPaymentOperation,
  type OrderLifecycleStatus,
} from "@/services/super-admin/orders/adjustItems";
import { getOrderStatusCategory, translateOrderStatus } from "@/utils/statusTranslations";
import { describeOrderTransitionError } from "@/utils/orderTransition";
import { PersianOrderStatus } from "@/constants/enums";
import { resolvePaymentGateway } from "@/utils/paymentGateways";

type Props = {
  order: SuperAdminOrderDetail;
  onSuccess: () => void;
  canChangeStatus: boolean;
  canCancel: boolean;
};

type PendingAction =
  | { kind: "status"; status: OrderLifecycleStatus; label: string }
  | { kind: "cancel" }
  | null;

// Quick status transitions offered as prominent buttons. Each targets a single
// backend Status; the bucket labels match the storefront categories.
const STATUS_ACTIONS: { status: OrderLifecycleStatus; label: string; bucket: PersianOrderStatus }[] =
  [
    { status: "Shipment", label: "تحویل به ارسال", bucket: PersianOrderStatus.INPROGRESS },
    { status: "Done", label: "تکمیل شده", bucket: PersianOrderStatus.DELIVERED },
  ];

export default function OrderStatusActions({
  order,
  onSuccess,
  canChangeStatus,
  canCancel,
}: Props) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [loading, setLoading] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const currentBucket = useMemo(
    () => getOrderStatusCategory(order.orderStatus),
    [order.orderStatus],
  );
  const isSnappPayOrder =
    resolvePaymentGateway(order.paymentGateway)?.key === "snappay";
  const isCancelled = currentBucket === PersianOrderStatus.CANCELLED;
  /*
   * The server refuses `Started -> Shipment` while the reserve window is open
   * (`RESERVE_HOLD_ACTIVE`). Disabling the button is presentation only -- the
   * guard that matters lives in `adminTransition` -- but an operator should see
   * why the action is unavailable instead of discovering it from an error toast.
   * Cancellation stays available: a held order can still be cancelled.
   */
  const isReserveHeld = Boolean(order.reserveIsHeld);

  const runAction = async () => {
    if (!pending || loading) return;
    const normalizedReason = cancelReason.trim();
    if (
      pending.kind === "cancel" &&
      isSnappPayOrder &&
      normalizedReason.length < 3
    ) {
      toast.error("دلیل لغو سفارش را وارد کنید.");
      return;
    }
    setLoading(true);
    try {
      if (pending.kind === "status") {
        await changeOrderStatus(String(order.id), pending.status);
        toast.success(`وضعیت سفارش به «${pending.label}» تغییر کرد`);
      } else {
        const result = await cancelOrder(
          order.id,
          normalizedReason || undefined,
        );
        if (result.status === "queued" && result.operationId) {
          toast.success("درخواست لغو برای اسنپ‌پی ثبت شد.");
          const operation = await waitForPaymentOperation(
            order.id,
            result.operationId,
          );
          if (operation.status === "Failed") {
            toast.error(
              formatSnappayOperationFailure(
                operation,
                "اسنپ‌پی درخواست لغو را نپذیرفت.",
              ),
            );
            onSuccess();
            return;
          }
          if (operation.status === "Unknown") {
            toast.error(
              formatSnappayOperationFailure(
                operation,
                "نتیجه لغو نامشخص است؛ درخواست را تکرار نکنید و آن را دستی بررسی کنید.",
              ),
            );
            onSuccess();
            return;
          }
          if (operation.status !== "Succeeded") {
            toast.success("لغو همچنان در پس‌زمینه در حال پیگیری است.");
            setPending(null);
            setCancelReason("");
            onSuccess();
            return;
          }
        }
        toast.success("سفارش لغو شد");
      }
      setPending(null);
      setCancelReason("");
      onSuccess();
    } catch (error: unknown) {
      // This read an axios-shaped `response.data.error`, but apiClient throws a
      // flat ApiError — so the lookup was always undefined and every failure,
      // including a refused status transition, showed the same fixed sentence.
      console.error("Order status action failed:", error);
      toast.error(describeOrderTransitionError(error));
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

  if (!canChangeStatus && !canCancel) return null;

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

      {isReserveHeld && (
        <div
          data-testid="order-reserve-hold-notice"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900"
        >
          این سفارش عضو یک بسته رزروی فعال است. تا پایان مهلت رزرو یا آزادسازی زودهنگام توسط
          مشتری، تحویل به ارسال و صدور بارکد برای آن انجام نمی‌شود.
          {order.reserveGroupId && (
            <>
              {" "}
              <Link
                href={`/orders/reserve/${encodeURIComponent(order.reserveGroupId)}`}
                className="underline"
              >
                مشاهده بسته رزروی
              </Link>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {canChangeStatus && STATUS_ACTIONS.map((action) => {
          const isCurrent = order.orderStatus === action.status;
          const isAllowed =
            (order.orderStatus === "Started" && action.status === "Shipment") ||
            (order.orderStatus === "Shipment" && action.status === "Done");
          const blockedByReserve = isReserveHeld && action.status === "Shipment";
          return (
            <button
              key={action.status}
              type="button"
              data-testid={`order-status-action-${action.status}`}
              disabled={loading || isCurrent || !isAllowed || blockedByReserve}
              onClick={() => setPending({ kind: "status", status: action.status, label: action.label })}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                blockedByReserve
                  ? "این سفارش در مهلت رزرو است و تا پایان مهلت ارسال نمی‌شود"
                  : isCurrent
                    ? "سفارش هم‌اکنون در این وضعیت است"
                    : undefined
              }
            >
              تغییر وضعیت به «{action.label}»
            </button>
          );
        })}

        {canCancel && (
          <button
            type="button"
            disabled={loading || isCancelled}
            onClick={() => setPending({ kind: "cancel" })}
            className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={isCancelled ? "این سفارش قبلاً لغو شده است" : undefined}
          >
            لغو سفارش
          </button>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!pending}
        title={pending?.kind === "cancel" ? "تأیید لغو سفارش" : "تأیید تغییر وضعیت"}
        description={confirmDescription}
        confirmText={loading ? "در حال انجام..." : pending?.kind === "cancel" ? "لغو سفارش" : "تأیید و ذخیره"}
        cancelText="انصراف"
        confirmDisabled={
          loading ||
          (pending?.kind === "cancel" &&
            isSnappPayOrder &&
            cancelReason.trim().length < 3)
        }
        onConfirm={runAction}
        onCancel={() => {
          if (loading) return;
          setPending(null);
          setCancelReason("");
        }}
      >
        {pending?.kind === "cancel" && isSnappPayOrder ? (
          <label className="block space-y-2 text-right">
            <span className="text-sm font-medium text-slate-800">
              دلیل لغو
            </span>
            <textarea
              value={cancelReason}
              onChange={(event) =>
                setCancelReason(event.target.value.slice(0, 500))
              }
              rows={3}
              maxLength={500}
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2"
              placeholder="حداقل ۳ نویسه"
            />
          </label>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
