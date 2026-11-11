"use client";

import type { BaleRecipient } from "@/contexts/BaleCheckoutCart";
import { faNum } from "@/utils/faNum";

/**
 * The recipient and address the shopper entered in the Bale bot. They are part
 * of the order the bot quoted, so the site shows them instead of asking again;
 * a different address means a new link from the bot.
 */
export default function BaleRecipientSummary({ recipient }: { recipient: BaleRecipient }) {
  const rows: Array<[string, string]> = [
    ["گیرنده", recipient.fullName],
    ["شماره تماس", faNum(recipient.phone)],
    ["استان و شهر", `${recipient.provinceTitle}، ${recipient.cityTitle}`],
    ["آدرس", recipient.address],
    ["کد پستی", faNum(recipient.postalCode)],
  ];
  return (
    <section
      aria-labelledby="bale-recipient-title"
      className="mb-6 flex flex-col gap-3 rounded-2xl bg-stone-50 p-5"
    >
      <h2 id="bale-recipient-title" className="text-xl text-neutral-800">
        اطلاعات گیرنده
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm leading-6">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-neutral-600">{label}</dt>
            <dd className="break-words text-neutral-900">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-5 text-neutral-600">
        این اطلاعات را در ربات بله وارد کرده‌اید. برای تغییر آن، از ربات لینک تازه بگیرید.
      </p>
    </section>
  );
}
