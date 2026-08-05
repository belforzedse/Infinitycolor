"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getServerSnapshot,
  getSnapshot,
  isEnhancementEligible,
  subscribe,
} from "./controller";
import type { AdaptiveQualityConstraint } from "./types";

export function useAdaptiveQuality() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useEnhancementEligibility(
  requirement: Partial<AdaptiveQualityConstraint>,
): boolean {
  const snapshot = useAdaptiveQuality();
  return isEnhancementEligible(requirement, snapshot);
}

export function useAdaptiveHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
