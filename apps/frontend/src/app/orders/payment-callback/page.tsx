import { Suspense } from "react";
import type { Metadata } from "next";
import PaymentCallbackPageClient from "./PaymentCallbackPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "بررسی وضعیت پرداخت",
  description: "وضعیت پرداخت سفارش در حال بررسی است.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/orders/payment-callback" },
};

export default function PaymentCallbackPage() {
  return (
    <Suspense fallback={null}>
      <PaymentCallbackPageClient />
    </Suspense>
  );
}
