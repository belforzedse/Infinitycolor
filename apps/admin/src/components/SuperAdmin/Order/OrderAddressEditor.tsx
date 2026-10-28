"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import Modal from "@/components/Kits/Modal";
import ProvinceCityField from "@/components/SuperAdmin/UpsertPage/ContentWrapper/Fields/ProvinceCityField";
import { apiClient } from "@/services";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";

export type AddressUpdateResponse = {
  noChange: boolean;
  affectedOrderIds: number[];
  reserveGroupId: number | null;
  carrierSync: {
    required: boolean;
    status: "not_required" | "pending" | "synced" | "needs_attention";
  };
};

type Props = {
  isOpen: boolean;
  order: SuperAdminOrderDetail;
  onClose: () => void;
  onSaved: (result: AddressUpdateResponse) => Promise<void> | void;
};

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition focus:border-actions-primary focus:ring-2 focus:ring-actions-primary/10";

export default function OrderAddressEditor({ isOpen, order, onClose, onSaved }: Props) {
  const [provinceId, setProvinceId] = useState("");
  const [cityId, setCityId] = useState("");
  const [fullAddress, setFullAddress] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setProvinceId(order.shippingProvinceId ? String(order.shippingProvinceId) : "");
    setCityId(order.shippingCityId ? String(order.shippingCityId) : "");
    setFullAddress(order.addressLine || "");
    setPostalCode(order.postalCode || "");
    setRecipientName(order.recipientName || order.userName || "");
    setRecipientPhone(order.recipientPhone || order.phoneNumber || "");
  }, [isOpen, order]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cityId || !fullAddress.trim() || !postalCode.trim() || !recipientName.trim() || !recipientPhone.trim()) {
      toast.error("همه اطلاعات گیرنده را کامل کنید");
      return;
    }
    setSubmitting(true);
    try {
      const response = await apiClient.put(`/orders/${order.id}/admin/address`, {
        data: {
          shippingCityId: Number(cityId),
          fullAddress,
          postalCode,
          recipientName,
          recipientPhone,
        },
      });
      const body = (response as any)?.data?.data ?? (response as any)?.data;
      await onSaved(body as AddressUpdateResponse);
      onClose();
    } catch (error) {
      // The admin API client throws `{ status, message }` carrying the backend's
      // reason; reading `response.data` hid it behind the generic text.
      const value = error as any;
      toast.error(
        value?.message ||
          value?.response?.data?.error?.message ||
          "ویرایش اطلاعات گیرنده انجام نشد",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? () => undefined : onClose}
      title="ویرایش اطلاعات گیرنده"
      className="max-w-2xl"
      contentClassName="p-0"
    >
      <form onSubmit={submit} className="space-y-5 p-5 md:p-6" dir="rtl">
        {order.hasSharedReserveAddress || order.reserveGroupId ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            این نشانی برای همه سفارش‌های این ارسال رزروی تغییر می‌کند.
          </p>
        ) : null}

        {order.anipoSubmittedAt && !["Stopped", "Voided"].includes(order.anipoBarcodeState || "") ? (
          <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-800">
            اطلاعات جدید پس از ذخیره به‌صورت خودکار با آنیپو همگام می‌شود.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm text-slate-700">
            <span>نام گیرنده</span>
            <input
              className={inputClass}
              value={recipientName}
              maxLength={255}
              onChange={(event) => setRecipientName(event.target.value)}
              autoComplete="name"
            />
          </label>
          <label className="space-y-2 text-sm text-slate-700">
            <span>شماره تماس گیرنده</span>
            <input
              className={inputClass}
              value={recipientPhone}
              onChange={(event) => setRecipientPhone(event.target.value)}
              inputMode="tel"
              dir="ltr"
              autoComplete="tel"
            />
          </label>
        </div>

        <div className="space-y-2 text-sm text-slate-700">
          <span>استان و شهر</span>
          <ProvinceCityField
            provinceValue={provinceId}
            cityValue={cityId}
            onProvinceChange={setProvinceId}
            onCityChange={setCityId}
          />
        </div>

        <label className="block space-y-2 text-sm text-slate-700">
          <span>کدپستی</span>
          <input
            className={inputClass}
            value={postalCode}
            maxLength={10}
            onChange={(event) => setPostalCode(event.target.value)}
            inputMode="numeric"
            dir="ltr"
            autoComplete="postal-code"
          />
        </label>

        <label className="block space-y-2 text-sm text-slate-700">
          <span>آدرس ارسال</span>
          <textarea
            className={`${inputClass} min-h-28 resize-y leading-7`}
            value={fullAddress}
            maxLength={1000}
            onChange={(event) => setFullAddress(event.target.value)}
          />
        </label>

        <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-xl bg-slate-100 px-5 py-3 text-sm text-slate-700 disabled:opacity-50"
          >
            انصراف
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl bg-actions-primary px-5 py-3 text-sm text-white disabled:opacity-50"
          >
            {submitting ? "در حال ذخیره…" : "ذخیره تغییرات"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
