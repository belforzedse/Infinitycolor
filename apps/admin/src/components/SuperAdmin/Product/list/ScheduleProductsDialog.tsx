"use client";

import { useState } from "react";
import { DatePicker, TimePicker } from "zaman";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import {
  instantToTehranWallTime,
  pickerToTehranIso,
  tehranPickerDate,
} from "@/utils/tehranPublicationTime";
import { faNum } from "@/utils/faNum";

function defaultInstant(current?: string | null): string {
  if (current && Date.parse(current) > Date.now()) return current;
  // Next full hour, at least ten minutes ahead.
  const next = new Date(Date.now() + 10 * 60_000);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next.toISOString();
}

/**
 * Picks a publication moment in Tehran time and hands back the UTC instant.
 * Used for Schedule, Reschedule and bulk scheduling; the server stores UTC and
 * refuses anything not in the future. Mount it per request (the caller renders
 * it only while a schedule is being chosen), so it always starts from the
 * product's current schedule.
 */
export default function ScheduleProductsDialog({
  isOpen,
  productCount,
  productTitle,
  currentPublishAt,
  busy,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  productCount: number;
  /** Named in the dialog when a single product is scheduled. */
  productTitle?: string;
  currentPublishAt?: string | null;
  busy?: boolean;
  onConfirm: (publishAt: string) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState<Date>(() => tehranPickerDate(defaultInstant(currentPublishAt)));
  const [time, setTime] = useState(() => {
    const parts = instantToTehranWallTime(defaultInstant(currentPublishAt));
    return { hour: parts.hour, minute: parts.minute };
  });
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    try {
      const publishAt = pickerToTehranIso(date, time.hour, time.minute);
      if (Date.parse(publishAt) <= Date.now() + 60_000) {
        setError("زمان انتشار باید دست‌کم یک دقیقه بعد باشد.");
        return;
      }
      onConfirm(publishAt);
    } catch {
      setError("تاریخ یا ساعت انتخاب‌شده معتبر نیست.");
    }
  };

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={currentPublishAt ? "تغییر زمان انتشار" : "زمان‌بندی انتشار"}
      description={
        productCount === 1 && productTitle
          ? `محصول «${productTitle}» در زمان انتخاب‌شده به‌طور خودکار منتشر می‌شود.`
          : `${faNum(productCount)} محصول در زمان انتخاب‌شده به‌طور خودکار منتشر می‌شوند. محصولات منتشرشده تغییری نمی‌کنند.`
      }
      confirmText="ثبت زمان‌بندی"
      confirmDisabled={busy}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      <div className="space-y-3" data-testid="admin-product-schedule-dialog">
        <label className="block text-xs text-slate-600">
          تاریخ انتشار
          <DatePicker
            key={date.toISOString()}
            defaultValue={date}
            inputClass="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm"
            onChange={(payload: unknown) => {
              const value = (payload as { value?: unknown } | null)?.value;
              const picked = value instanceof Date ? value : new Date(payload as string);
              if (!Number.isNaN(picked.getTime())) setDate(picked);
            }}
            accentColor="#7c3aed"
          />
        </label>
        <label className="block text-xs text-slate-600">
          ساعت (۲۴ ساعته)
          <TimePicker
            key={`${time.hour}:${time.minute}`}
            defaultValue={new Date(2020, 0, 1, time.hour, time.minute)}
            clockTime={24}
            inputClass="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm"
            onChange={(value: { hour: number; minute: number }) => setTime(value)}
            accentColor="#7c3aed"
          />
        </label>
        <p className="text-xs text-slate-500">منطقهٔ زمانی: تهران (Asia/Tehran)</p>
        {error && (
          <p className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}
