"use client";

import { cn } from "@/utils/tailwind";

/**
 * Thumb-reachable action bar for detail/edit screens.
 *
 * Generalised from the Products detail page, which was the only screen in the
 * admin that reserved scroll room for its actions and respected the iOS home
 * indicator. Pair with `ACTION_BAR_SCROLL_PADDING` on the scrolling container
 * so the bar never covers the last section of content.
 */

/** Bottom padding the page must reserve so the bar does not overlap content. */
export const ACTION_BAR_SCROLL_PADDING = "pb-32 md:pb-28";

export default function ActionBar({
  children,
  ariaLabel = "عملیات صفحه",
  className,
}: {
  children: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-3 z-30 flex justify-center px-4 pb-[env(safe-area-inset-bottom)] md:bottom-4 md:justify-end"
      role="group"
      aria-label={ariaLabel}
    >
      <div
        className={cn(
          "pointer-events-auto flex w-full max-w-lg items-center gap-2 rounded-3xl border border-slate-200 bg-white/90 px-3 py-2.5 shadow-lg backdrop-blur-lg",
          "md:ml-16 md:w-fit md:max-w-2xl md:justify-end",
          "[&>*]:min-h-[44px] [&>*]:flex-1 md:[&>*]:min-h-[40px] md:[&>*]:flex-none",
          className,
        )}
        dir="rtl"
      >
        {children}
      </div>
    </div>
  );
}
