"use client";

import { useLinkStatus } from "next/link";

export function LinkStatusIndicator({ label = "در حال بارگذاری" }: { label?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;

  return (
    <span
      className="absolute inset-0 z-20 grid place-items-center rounded-[inherit] bg-white/70 backdrop-blur-[1px]"
      role="status"
      aria-label={label}
    >
      <span className="size-4 animate-spin rounded-full border-2 border-current border-l-transparent motion-reduce:animate-none" />
    </span>
  );
}
