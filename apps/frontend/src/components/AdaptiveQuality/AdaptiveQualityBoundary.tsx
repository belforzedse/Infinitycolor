"use client";

import { Suspense, useEffect, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  notifyAdaptiveRoute,
  startAdaptiveQualityController,
} from "@/lib/adaptive-quality/controller";
import AdaptiveQualityTelemetry from "./AdaptiveQualityTelemetry";

/**
 * Route-aware adaptive-quality side effects.
 *
 * Kept in its own Suspense boundary so `useSearchParams()` does not force the
 * surrounding page tree to stream. Wrapping `{children}` in Suspense (or a
 * root `loading.tsx`) locks missing-route responses at HTTP 200 — see
 * https://nextjs.org/docs/app/api-reference/file-conventions/loading#status-codes
 */
function AdaptiveQualityRouteObserver() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  useEffect(() => startAdaptiveQualityController(), []);

  useEffect(() => {
    notifyAdaptiveRoute();
  }, [pathname, search]);

  return <AdaptiveQualityTelemetry />;
}

export default function AdaptiveQualityBoundary({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <AdaptiveQualityRouteObserver />
      </Suspense>
    </>
  );
}
