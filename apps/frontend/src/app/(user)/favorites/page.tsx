import type { Metadata } from "next";
import FavoritesPageClient from "./FavoritesPageClient";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "علاقه‌مندی‌ها",
  description: "محصولات مورد علاقه خود را مرور کنید و خریدتان را تکمیل کنید.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/favorites" },
};

export default function FavoritesPage() {
  return <FavoritesPageClient />;
}
