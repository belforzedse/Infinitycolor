"use client";
import toast from "react-hot-toast";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";

type Props = {
  order: SuperAdminOrderDetail;
  canEdit: boolean;
  onEdit: () => void;
};
export default function DeliveryAddressCard({ order, canEdit, onEdit }: Props) {
  const location = [order.shippingProvinceTitle, order.shippingCityTitle]
    .filter(Boolean)
    .join("، ");
  const copyText = [
    order.recipientName,
    order.recipientPhone,
    location,
    order.addressLine || order.address,
    order.postalCode ? `کد پستی: ${order.postalCode}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <section
      aria-label="آدرس ارسال"
      className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
      dir="rtl"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-900">آدرس ارسال</h2>
        <div className="flex flex-wrap gap-3 text-sm">
          {copyText && (
            <button
              type="button"
              className="min-h-10 text-actions-link"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(copyText);
                  toast.success("آدرس کپی شد");
                } catch {
                  toast.error("کپی آدرس انجام نشد");
                }
              }}
            >
              کپی آدرس
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="min-h-10 text-actions-link"
              onClick={onEdit}
            >
              ویرایش اطلاعات گیرنده
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
        {order.recipientName && (
          <p>
            <span className="text-slate-500">گیرنده: </span>
            {order.recipientName}
          </p>
        )}
        {order.recipientPhone && (
          <p>
            <span className="text-slate-500">شماره تماس: </span>
            <bdi dir="ltr">{order.recipientPhone}</bdi>
          </p>
        )}
        {location && <p className="sm:col-span-2">{location}</p>}
        <p className="whitespace-pre-wrap break-words leading-7 sm:col-span-2">
          {order.addressLine || order.address || "آدرس ارسال ثبت نشده است"}
        </p>
        {order.postalCode && (
          <p>
            <span className="text-slate-500">کد پستی: </span>
            <bdi dir="ltr">{order.postalCode}</bdi>
          </p>
        )}
      </div>
    </section>
  );
}
