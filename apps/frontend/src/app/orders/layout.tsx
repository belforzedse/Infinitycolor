import AdaptiveQualityBoundary from "@/components/AdaptiveQuality/AdaptiveQualityBoundary";
import { connection } from "next/server";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default async function OrdersLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return <AdaptiveQualityBoundary>{children}</AdaptiveQualityBoundary>;
}
