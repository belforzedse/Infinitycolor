"use client";

import { useEffect, useRef, useState } from "react";
import { useOffline } from "next/offline";

export function useNetworkStatus() {
  const isOffline = useOffline();
  const wasOffline = useRef(false);
  const [hasRecovered, setHasRecovered] = useState(false);

  useEffect(() => {
    if (isOffline) {
      wasOffline.current = true;
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setHasRecovered(true);
    window.dispatchEvent(new Event("app:back-online"));
    const timeoutId = window.setTimeout(() => setHasRecovered(false), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [isOffline]);

  return { isOnline: !isOffline, hasRecovered: !isOffline && hasRecovered };
}
