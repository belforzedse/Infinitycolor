import React from "react";
import { StorefrontGrid } from "@/components/storefront";
import { SkeletonBlock, SkeletonMedia, SkeletonText } from "@repo/ui/skeleton";

function DesktopProductResultsSkeleton() {
  return (
    <StorefrontGrid variant="plp">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="space-y-3">
          <SkeletonMedia aspect="250 / 270" />
          <SkeletonText tone="light" className="h-4 w-3/4" />
          <SkeletonText tone="light" className="h-4 w-1/2" />
        </div>
      ))}
    </StorefrontGrid>
  );
}

function MobileProductResultsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[...Array(8)].map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-1 rounded-2xl border border-slate-100 bg-white p-1"
        >
          <SkeletonMedia aspect="3 / 4" className="rounded-xl" />
          <div className="space-y-1 px-1 py-1">
            <SkeletonText tone="light" className="h-3 w-2/3" />
            <SkeletonText tone="light" className="h-4 w-full" />
          </div>
          <SkeletonBlock tone="light" className="min-h-[43px] rounded-[14px]" />
        </div>
      ))}
    </div>
  );
}

export function ProductResultsSkeleton() {
  return (
    <>
      <div className="hidden md:block">
        <DesktopProductResultsSkeleton />
      </div>
      <div className="md:hidden">
        <MobileProductResultsSkeleton />
      </div>
    </>
  );
}

export default function ProductListSkeleton() {
  return (
    <>
      {/* Desktop grid skeleton */}
      <div className="hidden gap-6 md:grid md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-4 rounded-2xl border border-zinc-100 bg-white p-4 shadow-sm">
          <SkeletonText className="h-5 w-28" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <SkeletonBlock tone="light" className="h-4 w-4 rounded" />
              <SkeletonText tone="light" className="h-4 flex-1" />
            </div>
          ))}
        </aside>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <SkeletonText className="h-6 w-36" />
            <SkeletonBlock tone="light" className="h-9 w-40 rounded-full" />
          </div>
          <DesktopProductResultsSkeleton />
        </div>
      </div>

      {/* Mobile grid skeleton */}
      <div className="md:hidden">
        <MobileProductResultsSkeleton />
      </div>
    </>
  );
}
