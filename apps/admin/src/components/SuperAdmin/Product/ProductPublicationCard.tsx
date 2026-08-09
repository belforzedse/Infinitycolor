"use client";

import { useEffect, useMemo, useState } from "react";
import { DatePicker, TimePicker } from "zaman";
import toast from "react-hot-toast";
import {
  changeProductPublication,
  PRODUCT_PUBLICATION_TIMEZONE,
  type ProductPublicationAction,
  type ProductPublicationResponse,
} from "@/services/super-admin/product/publication";
import {
  formatTehranPublication,
  instantToTehranWallTime,
  pickerToTehranIso,
  tehranPickerDate,
} from "@/utils/tehranPublicationTime";

type Props = {
  productId: string | number;
  status: "Active" | "InActive" | "Scheduled";
  scheduledPublishAt?: string | null;
  scheduledPublishLastError?: string | null;
  scheduledPublishFailureKind?: "Transient" | "Permanent" | null;
  canPublish: boolean;
  canSchedule: boolean;
  beforeAction?: (action: ProductPublicationAction) => Promise<boolean>;
  onChanged: (result: ProductPublicationResponse) => void | Promise<void>;
};

function initialPickerDate(scheduledPublishAt?: string | null): Date {
  return tehranPickerDate(scheduledPublishAt || new Date(Date.now() + 10 * 60_000));
}

export default function ProductPublicationCard({
  productId,
  status,
  scheduledPublishAt,
  scheduledPublishLastError,
  scheduledPublishFailureKind,
  canPublish,
  canSchedule,
  beforeAction,
  onChanged,
}: Props) {
  const [showSchedule, setShowSchedule] = useState(false);
  const [date, setDate] = useState<Date>(() => initialPickerDate(scheduledPublishAt));
  const initialParts = useMemo(
    () => instantToTehranWallTime(scheduledPublishAt || new Date(Date.now() + 10 * 60_000)),
    [scheduledPublishAt],
  );
  const [time, setTime] = useState({ hour: initialParts.hour, minute: initialParts.minute });
  const [savingAction, setSavingAction] = useState<ProductPublicationAction | null>(null);

  useEffect(() => {
    if (!scheduledPublishAt) return;
    setDate(initialPickerDate(scheduledPublishAt));
    const parts = instantToTehranWallTime(scheduledPublishAt);
    setTime({ hour: parts.hour, minute: parts.minute });
  }, [scheduledPublishAt]);

  const act = async (
    action: ProductPublicationAction,
    extra?: { publishAt?: string; timezone?: string },
  ) => {
    if (savingAction) return;
    setSavingAction(action);
    try {
      if (
        beforeAction &&
        (action === "schedule" || action === "publish-now" || action === "retry") &&
        !(await beforeAction(action))
      ) {
        return;
      }
      const result = await changeProductPublication(productId, { action, ...extra });
      await onChanged(result);
      if (result.queueState === "pending-reconciliation") {
        toast.success("وضعیت ذخیره شد؛ تکمیل صف و کش به‌صورت خودکار بازیابی می‌شود");
      } else {
        toast.success(
          action === "schedule"
            ? "زمان انتشار ثبت شد"
            : action === "cancel"
              ? "زمان‌بندی لغو شد"
              : action === "unpublish"
                ? "محصول از انتشار خارج شد"
                : "وضعیت انتشار محصول به‌روزرسانی شد",
        );
      }
      if (action === "schedule") setShowSchedule(false);
    } catch (error: any) {
      const code =
        error?.details?.code ||
        error?.errorCode ||
        error?.response?.data?.error?.code ||
        error?.response?.data?.error?.details?.code ||
        error?.message;
      toast.error(
        code === "INVALID_PUBLICATION_TIME"
          ? "زمان انتشار باید در آینده باشد"
          : code === "PRODUCT_SLUG_REQUIRED"
            ? "قبل از انتشار، نامک محصول را ذخیره کنید"
            : "عملیات انتشار انجام نشد",
      );
    } finally {
      setSavingAction(null);
    }
  };

  const schedule = async () => {
    try {
      const publishAt = pickerToTehranIso(date, time.hour, time.minute);
      if (Date.parse(publishAt) <= Date.now()) {
        toast.error("زمان انتشار باید در آینده باشد");
        return;
      }
      await act("schedule", { publishAt, timezone: PRODUCT_PUBLICATION_TIMEZONE });
    } catch {
      toast.error("تاریخ یا ساعت انتخاب‌شده معتبر نیست");
    }
  };

  const statusLabel =
    status === "Active" ? "منتشر شده" : status === "Scheduled" ? "زمان‌بندی شده" : "پیش‌نویس";

  return (
    <section dir="rtl" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 text-right shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">انتشار محصول</h3>
          <p className="mt-1 text-xs text-slate-500">منطقه زمانی: تهران (Asia/Tehran)</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            status === "Active"
              ? "bg-green-100 text-green-700"
              : status === "Scheduled"
                ? "bg-blue-100 text-blue-700"
                : "bg-slate-100 text-slate-600"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      {status === "Scheduled" && scheduledPublishAt ? (
        <div className="rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-900">
          انتشار در: <strong>{formatTehranPublication(scheduledPublishAt)}</strong>
        </div>
      ) : null}

      {scheduledPublishLastError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <strong>خطای انتشار{scheduledPublishFailureKind === "Permanent" ? " پایدار" : ""}:</strong>{" "}
          {scheduledPublishLastError}
        </div>
      ) : null}

      {canSchedule && showSchedule ? (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label className="block text-xs text-slate-600">
            تاریخ انتشار
            <DatePicker
              key={date.toISOString()}
              defaultValue={date}
              inputClass="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm"
              onChange={(payload: any) => {
                const picked = payload?.value instanceof Date ? payload.value : new Date(payload);
                if (!Number.isNaN(picked.getTime())) setDate(picked);
              }}
              accentColor="#7c3aed"
            />
          </label>
          <label className="block text-xs text-slate-600">
            ساعت تهران (۲۴ ساعته)
            <TimePicker
              key={`${time.hour}:${time.minute}`}
              defaultValue={new Date(2020, 0, 1, time.hour, time.minute)}
              clockTime={24}
              inputClass="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm"
              onChange={(value: { hour: number; minute: number }) => setTime(value)}
              accentColor="#7c3aed"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={Boolean(savingAction)}
              onClick={() => void schedule()}
              className="rounded-lg bg-infinity-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              ثبت زمان‌بندی
            </button>
            <button
              type="button"
              onClick={() => setShowSchedule(false)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600"
            >
              انصراف
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canPublish && (status !== "Active" ? (
          <button
            type="button"
            disabled={Boolean(savingAction)}
            onClick={() => void act("publish-now")}
            className="rounded-lg bg-actions-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            انتشار فوری
          </button>
        ) : (
          <button
            type="button"
            disabled={Boolean(savingAction)}
            onClick={() => void act("unpublish")}
            className="rounded-lg border border-amber-300 px-3 py-2 text-xs text-amber-700 disabled:opacity-50"
          >
            لغو انتشار
          </button>
        ))}
        {canSchedule && status !== "Active" ? (
          <button
            type="button"
            onClick={() => setShowSchedule(true)}
            className="rounded-lg border border-blue-300 px-3 py-2 text-xs text-blue-700"
          >
            {status === "Scheduled" ? "تغییر زمان" : "زمان‌بندی انتشار"}
          </button>
        ) : null}
        {canSchedule && status === "Scheduled" ? (
          <button
            type="button"
            disabled={Boolean(savingAction)}
            onClick={() => void act("cancel")}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 disabled:opacity-50"
          >
            لغو زمان‌بندی
          </button>
        ) : null}
        {canSchedule && status === "Scheduled" && scheduledPublishLastError ? (
          <button
            type="button"
            disabled={Boolean(savingAction)}
            onClick={() => void act("retry")}
            className="rounded-lg border border-red-300 px-3 py-2 text-xs text-red-700 disabled:opacity-50"
          >
            تلاش دوباره
          </button>
        ) : null}
      </div>
    </section>
  );
}
