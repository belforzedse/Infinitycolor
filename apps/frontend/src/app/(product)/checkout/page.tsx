import type { Metadata } from "next";
import { SITE_URL } from "@/config/site";
import CheckoutPageClient from "./CheckoutPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "تسویه حساب",
  description: "اطلاعات ارسال و پرداخت خود را برای نهایی‌سازی سفارش تکمیل کنید.",
  robots: {
    index: false,
    follow: false,
  },
  alternates: {
    canonical: `${SITE_URL}/checkout`,
  },
};

export default function CheckoutPage() {
  return <CheckoutPageClient />;
}
