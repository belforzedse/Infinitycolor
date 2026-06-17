import type { Metadata } from "next";
import PaymentIssuePageClient from "./PaymentIssuePageClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "مشکل در تکمیل سفارش",
  description: "پرداخت یا تکمیل سفارش با مشکل مواجه شد.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/payment/issue" },
};

export default function PaymentIssuePage() {
  return <PaymentIssuePageClient />;
}
