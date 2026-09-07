"use client";

import { useEffect } from "react";
import { AdminCard, ErrorState } from "@/components/admin";

/**
 * Scoped to the Sales workspace so a failing report keeps the section
 * navigation usable instead of replacing the whole admin with the global
 * error page.
 */
export default function SalesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Sales workspace error:", error);
  }, [error]);

  return (
    <AdminCard padded={false}>
      <ErrorState
        title="بارگذاری این گزارش انجام نشد"
        description={
          process.env.NODE_ENV === "development" ? error.message : undefined
        }
        onRetry={reset}
      />
    </AdminCard>
  );
}
