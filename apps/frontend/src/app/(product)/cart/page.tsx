import type { Metadata } from "next";
import { SITE_URL } from "@/config/site";
import CartPageClient from "./CartPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "سبد خرید",
  description: "محصولات انتخاب‌شده خود را بازبینی و برای تکمیل خرید آماده شوید.",
  robots: {
    index: false,
    follow: false,
  },
  alternates: {
    canonical: `${SITE_URL}/cart`,
  },
};

export default function CartPage() {
  return <CartPageClient />;
}
