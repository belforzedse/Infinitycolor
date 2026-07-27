"use client";

import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import {
  changeOrderStatus,
  cancelOrder,
  formatSnappayOperationFailure,
  revealSnappaySupportToken,
  waitForPaymentOperation,
  type OrderLifecycleStatus,
  type SnappaySupportToken,
} from "@/services/super-admin/orders/adjustItems";
import { getOrderStatusCategory, translateOrderStatus } from "@/utils/statusTranslations";
import { PersianOrderStatus } from "@/constants/enums";
import { resolvePaymentGateway } from "@/utils/paymentGateways";

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
    { status: "Shipment", label: "تحویل به ارسال", bucket: PersianOrderStatus.INPROGRESS },
    { status: "Done", label: "تکمیل شده", bucket: PersianOrderStatus.DELIVERED },
  ];

export default function OrderStatusActions({ order, onSuccess }: Props) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [loading, setLoading] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [supportToken, setSupportToken] =
    useState<SnappaySupportToken | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);

  const currentBucket = useMemo(
    () => getOrderStatusCategory(order.orderStatus),
    [order.orderStatus],
  );
  const isSnappPayOrder =
    resolvePaymentGateway(order.paymentGateway)?.key === "snappay";
  const isCancelled = currentBucket === PersianOrderStatus.CANCELLED;

  const revealSupportToken = async () => {
    if (tokenLoading) return;
    setTokenLoading(true);
    try {
      setSupportToken(await revealSnappaySupportToken(order.id));
      toast.success("توکن اسنپ‌پی نمایش داده شد و این دسترسی ثبت شد.");
    } catch {
      toast.error("توکن اسنپ‌پی برای این سفارش در دسترس نیست.");
    } finally {
      setTokenLoading(false);
    }
  };

  const copySupportToken = async () => {
    if (!supportToken?.paymentToken) return;
    try {
      await navigator.clipboard.writeText(supportToken.paymentToken);
      toast.success("توکن اسنپ‌پی کپی شد.");
    } catch {
      toast.error("کپی خودکار انجام نشد؛ توکن را دستی کپی کنید.");
    }
  };

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
          const isCurrent = order.orderStatus === action.status;
          const isAllowed =
            (order.orderStatus === "Started" && action.status === "Shipment") ||
            (order.orderStatus === "Shipment" && action.status === "Done");
          return (
            <button
              key={action.status}
              type="button"
              disabled={loading || isCurrent || !isAllowed}
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

      {isSnappPayOrder ? (
        <div className="mt-5 rounded-md border border-blue-200 bg-blue-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold text-blue-950">
                توکن پشتیبانی اسنپ‌پی
              </h4>
              <p className="mt-1 text-xs text-blue-800">
                برای ارسال به پشتیبانی اسنپ‌پی، توکن را فقط هنگام نیاز نمایش
                دهید. هر بار نمایش در گزارش فعالیت ثبت می‌شود.
              </p>
            </div>
            {!supportToken ? (
              <button
                type="button"
                disabled={tokenLoading}
                onClick={revealSupportToken}
                className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {tokenLoading ? "در حال دریافت..." : "نمایش توکن"}
              </button>
            ) : null}
          </div>

          {supportToken ? (
            <div className="mt-4 space-y-3">
              <code
                dir="ltr"
                className="block select-all break-all rounded border border-blue-200 bg-white p-3 text-left text-sm text-slate-900"
              >
                {supportToken.paymentToken}
              </code>
              <div className="flex flex-wrap items-center gap-2 text-xs text-blue-900">
                {supportToken.transactionId ? (
                  <span>شناسه تراکنش: {supportToken.transactionId}</span>
                ) : null}
                {supportToken.providerStatus ? (
                  <span>وضعیت: {supportToken.providerStatus}</span>
                ) : null}
                {supportToken.fingerprint ? (
                  <span>اثر انگشت: {supportToken.fingerprint}</span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copySupportToken}
                  className="rounded-md bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-800"
                >
                  کپی توکن
                </button>
                <button
                  type="button"
                  onClick={() => setSupportToken(null)}
                  className="rounded-md border border-blue-300 bg-white px-3 py-2 text-sm text-blue-900"
                >
                  پنهان کردن
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        isOpen={!!pending}
        title={pending?.kind === "cancel" ? "تأیید لغو سفارش" : "تأیید تغییر وضعیت"}
        description={confirmDescription}
        confirmText={loading ? "در حال انجام..." : pending?.kind === "cancel" ? "لغو سفارش" : "تایید و ذخیره"}
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
