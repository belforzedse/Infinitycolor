import { cn } from "@/utils/tailwind";
import { CARD, CARD_PADDING } from "./tokens";

/**
 * Skeletons approximate the geometry of what is about to appear, so navigation
 * does not reflow. Previously the admin had four unrelated approaches to this
 * (a dotLottie full-page animation, one table skeleton, ad-hoc animate-pulse
 * divs, and 26 files falling back to a spinner).
 */

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded bg-slate-100", className)}
      aria-hidden
    />
  );
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: lines }).map((_, index) => (
        <SkeletonBlock
          key={index}
          className={cn("h-3", index === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

/** Mirrors ResourceListItem: leading media, title line, meta strip. */
export function ResourceListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex min-h-[76px] w-full items-center gap-3 rounded-2xl bg-white p-3 shadow-sm"
        >
          <SkeletonBlock className="h-12 w-12 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <SkeletonBlock className="h-3.5 w-2/5" />
              <SkeletonBlock className="h-5 w-16 rounded-lg" />
            </div>
            <SkeletonBlock className="h-8 w-full rounded-lg" />
            <SkeletonBlock className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mirrors a desktop data table. */
export function TableSkeleton({
  rows = 8,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="w-full" aria-busy>
      <div className="flex gap-4 border-b border-slate-100 pb-3">
        {Array.from({ length: columns }).map((_, index) => (
          <SkeletonBlock key={index} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4 border-b border-slate-50 py-4">
          {Array.from({ length: columns }).map((_, colIndex) => (
            <SkeletonBlock key={colIndex} className="h-3.5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Responsive index skeleton: cards below `lg`, table above — matching the
 * boundary SuperAdminTable uses, so the skeleton never disagrees with the
 * layout that replaces it.
 */
export function ResourceIndexSkeleton({
  rows = 6,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <>
      <div className="block lg:hidden">
        <ResourceListSkeleton rows={rows} />
      </div>
      <div className="hidden lg:block">
        <TableSkeleton rows={rows} columns={columns} />
      </div>
    </>
  );
}

/** Mirrors MetricCard. */
export function MetricCardSkeleton() {
  return (
    <div className={cn(CARD, "p-5")} aria-busy>
      <SkeletonBlock className="mb-3 h-4 w-24" />
      <SkeletonBlock className="h-7 w-32" />
      <SkeletonBlock className="mt-3 h-4 w-20" />
    </div>
  );
}

export function MetricGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, index) => (
        <MetricCardSkeleton key={index} />
      ))}
    </div>
  );
}

export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn(CARD, CARD_PADDING, className)} aria-busy>
      <SkeletonBlock className="mb-4 h-4 w-32" />
      <SkeletonBlock className="h-56 w-full rounded-xl md:h-72" />
    </div>
  );
}

/** Mirrors DetailHeader + stacked sections on a resource detail page. */
export function ResourceDetailSkeleton() {
  return (
    <div className="space-y-4 lg:space-y-6" aria-busy>
      <div className={cn(CARD, CARD_PADDING)}>
        <SkeletonBlock className="h-5 w-40" />
        <SkeletonBlock className="mt-2 h-3 w-28" />
        <div className="mt-4 flex flex-wrap gap-2">
          <SkeletonBlock className="h-6 w-20 rounded-lg" />
          <SkeletonBlock className="h-6 w-24 rounded-lg" />
        </div>
      </div>
      <div className={cn(CARD, CARD_PADDING)}>
        <SkeletonBlock className="mb-4 h-4 w-28" />
        <SkeletonText lines={5} />
      </div>
      <div className={cn(CARD, CARD_PADDING)}>
        <SkeletonBlock className="mb-4 h-4 w-24" />
        <SkeletonText lines={3} />
      </div>
    </div>
  );
}
