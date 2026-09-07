"use client";

import type { UpsertPageConfigType } from "@/components/SuperAdmin/UpsertPage/ContentWrapper/index";
import { type Coupon } from "./page";
import { apiClient } from "@/services";

export const config: UpsertPageConfigType<Coupon> = {
  headTitle: "کد تخفیف جدید",
  isActiveBox: {
    key: "isActive",
    header: "وضیعت کد تخفیف",
    label: (value) => (value ? "فعال" : "غیرفعال"),
  },
  actionButtons: (props) => (
    <>
      <button
        className="text-sm flex-1 rounded-xl bg-slate-200 px-5 py-2 text-slate-500 md:flex-none"
        onClick={props.onCancel}
      >
        بیخیال شدن
      </button>

      <button
        className="text-sm flex-1 rounded-xl bg-actions-primary px-5 py-2 text-white md:flex-none"
        onClick={props.onSubmit}
      >
        ذخیره
      </button>
    </>
  ),
  config: [
    {
      title: "قانون تخفیف",
      sections: [
        {
          fields: [
            {
              name: "code",
              type: "text",
              label: "کد تخفیف",
              placeholder: "مثلاً NOWRUZ1405",
              helper: () => "فقط حروف انگلیسی و عدد، بدون فاصله.",
              colSpan: 4,
              mobileColSpan: 12,
            },
            {
              name: "type",
              type: "dropdown",
              label: "نوع تخفیف",
              colSpan: 4,
              mobileColSpan: 12,
              options: [
                {
                  label: "درصدی",
                  value: "Discount",
                },
                {
                  label: "مبلغی",
                  value: "Cash",
                },
              ],
            },
            {
              name: "amount",
              type: "text",
              label: "میزان تخفیف",
              placeholder: "مثلاً 20",
              helper: () =>
                "برای تخفیف درصدی، عددی بین ۱ تا ۱۰۰ و برای تخفیف مبلغی، مبلغ به تومان.",
              colSpan: 4,
              mobileColSpan: 12,
            },
            {
              name: "limit",
              type: "text",
              label: "محدودیت استفاده",
              placeholder: "مثلاً 2",
              helper: () =>
                "حداکثر تعداد استفاده از این کد. خالی بماند یعنی بدون محدودیت.",
              colSpan: 6,
              mobileColSpan: 12,
            },
            {
              name: "maxAmount",
              type: "text",
              label: "سقف مبلغی تخفیف",
              placeholder: "مثلاً 150000",
              helper: () =>
                "سقف مبلغ تخفیف به تومان. برای تخفیف درصدی کاربرد دارد.",
              colSpan: 6,
              mobileColSpan: 12,
            },
            {
              name: "startDate",
              type: "date",
              label: "شروع",
              colSpan: 6,
              mobileColSpan: 12,
            },
            {
              name: "endDate",
              type: "date",
              label: "انقضا",
              colSpan: 6,
              mobileColSpan: 12,
            },
          ],
        },
        {
          header: {
            title: "شرایط پیشرفته",
          },
          fields: [
            {
              name: "minCartTotal",
              type: "text",
              label: "حداقل مبلغ سبد (تومان)",
              placeholder: "مثلاً 500000",
              colSpan: 6,
              mobileColSpan: 12,
            },
            {
              name: "maxCartTotal",
              type: "text",
              label: "حداکثر مبلغ سبد (تومان)",
              placeholder: "خالی بماند یعنی بدون محدودیت",
              colSpan: 6,
              mobileColSpan: 12,
            },
          ],
        },
      ],
    },
  ],
};
