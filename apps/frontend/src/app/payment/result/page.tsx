import type { Metadata } from "next";
import { Suspense } from "react";
import PaymentResultPageClient from "./PaymentResultPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

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
