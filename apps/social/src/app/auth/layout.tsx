import type { Metadata } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
export const instant = false;

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AuthLayout({ children }: { children: ReactNode }) {
  await connection();
  return children;
}
