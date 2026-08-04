"use client";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import Link from "next/link";

export default function DiscountsPage() {
  return (
    <ContentWrapper title="مدیریت تخفیف ها">
      <div className="flex flex-col gap-4">
        <Link href="/coupons" className="text-infinity-primary">
          کدهای تخفیف
        </Link>
        <Link href="/general-discounts" className="text-infinity-primary">
          تخفیفای عمومی
        </Link>
      </div>
    </ContentWrapper>
  );
}
