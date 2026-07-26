import type { Metadata } from "next";
import { Suspense } from "react";
import PaymentResultPageClient from "./PaymentResultPageClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "نتیجه پرداخت",
  description: "نتیجه ثبت‌شده پرداخت و سفارش را بررسی کنید.",
  robots: { index: false, follow: false },
};

export default function PaymentResultPage() {
  return (
    <Suspense fallback={null}>
      <PaymentResultPageClient />
    </Suspense>
  );
}
