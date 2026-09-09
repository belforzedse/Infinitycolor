"use client";

import { WifiOff } from "lucide-react";
import { useNetworkStatus } from "@/hooks/use-network-status";

export function NetworkStatusIndicator() {
  const { showOfflineNotice } = useNetworkStatus();
  if (!showOfflineNotice) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[70] flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto inline-flex min-h-10 items-center gap-2 rounded-full bg-amber-50 px-4 py-2 font-peyda text-sm text-amber-700 shadow-[0_12px_28px_rgba(61,76,110,0.12)]"
      >
        <WifiOff className="size-4" aria-hidden />
        <span>بدون اتصال اینترنت</span>
      </div>
    </div>
  );
}
