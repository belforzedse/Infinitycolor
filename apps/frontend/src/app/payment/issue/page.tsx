import { Suspense } from "react";
import type { Metadata } from "next";
import PaymentIssuePageClient from "./PaymentIssuePageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "مشکل در تکمیل سفارش",
  description: "پرداخت یا تکمیل سفارش با مشکل مواجه شد.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/payment/issue" },
};

export default function PaymentIssuePage() {
  return (
    <Suspense fallback={null}>
      <PaymentIssuePageClient />
    </Suspense>
  );
}
