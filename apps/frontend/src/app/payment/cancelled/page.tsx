import { Suspense } from "react";
import type { Metadata } from "next";
import PaymentCancelledPageClient from "./PaymentCancelledPageClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
