import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function SearchLayout({ children }: { children: ReactNode }) {
  await connection();
  return children;
}
