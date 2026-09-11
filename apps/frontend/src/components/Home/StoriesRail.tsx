"use client";

import { useCallback } from "react";
import { StoryRail as SharedStoryRail } from "@repo/story-rail";
import type { Story } from "@/types/story";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useStoriesSeenState } from "@/hooks/useStoriesSeenState";
import resolveAssetUrl from "@/utils/resolveAssetUrl";


interface StoriesRailProps {
  stories: Story[];
}

function buildMediaUrl(url: string): string {
  return resolveAssetUrl(url);
}

export default function StoriesRail({ stories }: StoriesRailProps) {
  const { isAuthenticated } = useCurrentUser();
  const { seenIds, markSeen } = useStoriesSeenState(isAuthenticated);

  const handleStoryView = useCallback((storyId: number) => {
    void markSeen(storyId);
  }, [markSeen]);

  return (
    <div className="flex min-w-0 w-full flex-col gap-3" dir="rtl">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-peyda text-2xl font-bold leading-[21px] text-[#424242] md:text-3xl">
          داستان ها
        </h2>
      </div>

      <SharedStoryRail
        stories={stories}
        seenIds={seenIds}
        onMarkSeen={handleStoryView}
        resolveMediaUrl={buildMediaUrl}
        dir="rtl"
        mobileLayout="avatar"
        emptyPreviewLabel="ویدیو"
        unavailableText="Story unavailable"
        showPagination
        paginationLabels={{ previous: "داستان‌های قبلی", next: "داستان‌های بعدی" }}
      />
    </div>
  );
}
