"use client";

import { useEffect, useState } from "react";
import { DatePicker, TimePicker } from "zaman";
import toast from "react-hot-toast";
import { apiClient } from "@/services";

type Props = {
  productId: string | number;
  /** Current LastEditedByAdminAt (ISO string) used to sort products in admin lists. */
  initialDate?: string | null;
};

// Products are ordered in the admin panel by LastEditedByAdminAt (the «آخرین ویرایش»
// timestamp). Letting an admin set that timestamp — Persian (Jalali) date + a 24h
// hour/minute clock — lets them rearrange products by date & time, WooCommerce-style.
// The dedicated endpoint accepts only this timestamp: the product lifecycle diff ignores
// LastEditedByAdminAt, so afterUpdate never re-stamps it to "now" and the chosen instant is
// preserved without granting the caller broad product-update permission.
export default function ProductDisplayDateCard({ productId, initialDate }: Props) {
  const [date, setDate] = useState<Date>(() => (initialDate ? new Date(initialDate) : new Date()));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initialDate) setDate(new Date(initialDate));
  }, [initialDate]);

  const handleDateChange = (payload: { value: Date }) => {
    const picked = payload?.value instanceof Date ? payload.value : new Date(payload as unknown as Date);
    setDate((prev) => {
      const next = new Date(prev);
      // Keep the time-of-day; only move the calendar day/month/year.
      next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
      return next;
    });
  };

  const handleTimeChange = (payload: { hour: number; minute: number }) => {
    setDate((prev) => {
      const next = new Date(prev);
      next.setHours(payload.hour, payload.minute, 0, 0);
      return next;
    });
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Local Date → ISO (UTC) so the stored instant round-trips back to the same
      // wall-clock time when re-displayed in the admin's timezone.
      await apiClient.put(`/products/${productId}/display-date`, {
        data: { displayAt: date.toISOString() },
      });
      toast.success("تاریخ و ساعت نمایش محصول ثبت شد");
    } catch {
      toast.error("خطا در ثبت تاریخ و ساعت");
    } finally {
      setSaving(false);
    }
  };

  const formatted = date.toLocaleString("fa-IR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div
      dir="rtl"
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-right shadow-sm"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-slate-900">تاریخ و ساعت نمایش</h3>
        <p className="text-xs leading-5 text-slate-500">
          با تنظیم تاریخ و ساعت، جایگاه محصول در فهرست مرتب‌شده بر اساس «آخرین ویرایش» جابه‌جا می‌شود.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-600">تاریخ</label>
        <DatePicker
          inputClass="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
          defaultValue={date}
          onChange={handleDateChange}
          accentColor="#7c3aed"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-600">ساعت (۲۴ ساعته)</label>
        <TimePicker
          inputClass="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm"
          defaultValue={date}
          clockTime={24}
          onChange={handleTimeChange}
          accentColor="#7c3aed"
        />
      </div>

      <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        مقدار انتخاب‌شده: <span className="font-medium text-slate-800">{formatted}</span>
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="rounded-lg bg-actions-primary px-4 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "در حال ثبت..." : "ثبت تاریخ و ساعت"}
      </button>
    </div>
  );
}
