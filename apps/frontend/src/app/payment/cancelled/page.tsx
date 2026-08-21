import { Suspense } from "react";
import type { Metadata } from "next";
import PaymentCancelledPageClient from "./PaymentCancelledPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "پرداخت لغو شد",
  description: "فرآیند پرداخت لغو شد و مبلغی از حساب شما کسر نشده است.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/payment/cancelled" },
};

export default function PaymentCancelledPage() {
  return (
    <Suspense fallback={null}>
      <PaymentCancelledPageClient />
    </Suspense>
  );
}
