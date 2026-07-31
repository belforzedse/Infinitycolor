"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  notifyAdaptiveRoute,
  startAdaptiveQualityController,
} from "@/lib/adaptive-quality/controller";
import AdaptiveQualityTelemetry from "./AdaptiveQualityTelemetry";

export default function AdaptiveQualityBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  useEffect(() => startAdaptiveQualityController(), []);

  useEffect(() => {
    notifyAdaptiveRoute();
  }, [pathname, search]);

  return (
    <>
      {children}
      <AdaptiveQualityTelemetry />
    </>
  );
}
