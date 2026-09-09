"use client";

import { useEffect, useState } from "react";
import { useOffline } from "next/offline";

const OFFLINE_NOTICE_DELAY_MS = 1500;

export function useNetworkStatus() {
  const isOffline = useOffline();
  const [showOfflineNotice, setShowOfflineNotice] = useState(false);

  useEffect(() => {
    if (!isOffline) {
      setShowOfflineNotice(false);
      return undefined;
    }

    const timeoutId = window.setTimeout(
      () => setShowOfflineNotice(true),
      OFFLINE_NOTICE_DELAY_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [isOffline]);

  return { showOfflineNotice };
}
