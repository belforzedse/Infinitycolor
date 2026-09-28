"use client";

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { userLoadingAtom } from "@/lib/atoms/auth";

/**
 * Marks <html data-app-ready="true"> once the client tree has hydrated and the
 * session is resolved (signed in, or known to be a guest).
 *
 * A tap that lands before that can be dropped: on a category page a product
 * card tapped while the guest-session check was still in flight did nothing
 * (measured 2026-09-28, most taps within the first second of a guest visit).
 * Browser tests wait for this attribute instead of sleeping; it has no effect
 * on the page itself.
 */
export default function AppReadyMarker() {
  const sessionLoading = useAtomValue(userLoadingAtom);
  useEffect(() => {
    if (sessionLoading) return;
    document.documentElement.dataset.appReady = "true";
  }, [sessionLoading]);
  return null;
}
