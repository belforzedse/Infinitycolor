import type { Metadata } from "next";
import { SITE_URL } from "@/config/site";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function PrivilegesPage() {
  return <div>PrivilegesPage</div>;
}

export const metadata: Metadata = {
  title: "مزایا و امتیازات",
  description: "مشاهده مزایا و امتیازات حساب کاربری.",
  alternates: { canonical: `${SITE_URL}/privileges` },
};
