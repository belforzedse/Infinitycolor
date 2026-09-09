export function ProfileFormSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[880px] space-y-6 rounded-[24px] bg-white p-5 shadow-[0_0_14.7px_rgba(0,0,0,0.04)] sm:p-6 lg:mx-0 lg:p-8"
      aria-busy="true"
    >
      {/* Page heading — back button (lg only) + title */}
      <div className="flex items-center gap-3">
        <div className="hidden size-9 shrink-0 rounded-sm skeleton-shimmer-light lg:block" aria-hidden />
        <div className="skeleton-shimmer h-7 w-48 rounded-lg" aria-hidden />
      </div>

      {/* 2-column field grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={`space-y-2 ${i === 2 ? "sm:col-span-2" : ""}`}>
            <div className="skeleton-shimmer-light h-4 w-20 rounded" aria-hidden />
            <div className="skeleton-shimmer h-11 w-full rounded-xl" aria-hidden />
          </div>
        ))}
      </div>

      {/* Save button */}
      <div className="flex justify-end pt-1">
        <div className="skeleton-shimmer h-11 w-full rounded-full sm:w-32" aria-hidden />
      </div>
    </div>
  );
}
