"use client";

import { useEffect } from "react";
import { setAnalyticsContext, type AnalyticsContextKey } from "@/lib/analytics";

type Props = {
  dimension: AnalyticsContextKey;
  value: string | number;
};

/**
 * Sets a single allowlisted analytics context value for the current page from
 * a server component (e.g. the stable category slug on category PLP pages). Safe
 * and no-op when analytics is disabled.
 */
export default function CustomDimensionTracker({ dimension, value }: Props) {
  useEffect(() => {
    if (value === undefined || value === null || value === "") return;
    setAnalyticsContext(dimension, value);
  }, [dimension, value]);

  return null;
}
