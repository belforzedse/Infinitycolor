"use client";

import { useCallback, useEffect } from "react";
import { StoryRail as SharedStoryRail, type StoryViewerLabels } from "@repo/story-rail";
import type { Story } from "@/types/story";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useStoriesSeenState } from "@/hooks/useStoriesSeenState";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { ensureVideoTelemetry, reportStoryMediaIssue } from "@/lib/video-telemetry";


interface StoriesRailProps {
  stories: Story[];
}

const VIEWER_LABELS: StoryViewerLabels = {
  dialog: (title) => `داستان ${title}`,
  close: "بستن داستان",
  description: "برای رفتن به آیتم بعد یا قبل، دو سوی داستان را لمس کنید یا از کلیدهای جهت استفاده کنید. برای بستن کلید Escape را بزنید.",
  progress: (percent) => `پیشرفت داستان: ${percent} درصد`,
  announcement: (current, total, title) => `آیتم ${current} از ${total}، ${title}`,
  mediaFailure: "این آیتم در این مرورگر پخش نمی‌شود.",
  retry: "تلاش دوباره",
  mute: "قطع صدا",
  unmute: "پخش صدا",
  play: "پخش",
  processing: "این ویدیو در حال آماده‌سازی است.",
};

function buildMediaUrl(url: string): string {
  return resolveAssetUrl(url);
}

export default function StoriesRail({ stories }: StoriesRailProps) {
  const { isAuthenticated } = useCurrentUser();
  const { seenIds, seenItems, markSeen } = useStoriesSeenState(isAuthenticated);
  useEffect(() => ensureVideoTelemetry(), []);

  const handleStoryView = useCallback((storyId: number, itemKey: string) => {
    void markSeen(storyId, itemKey);
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
        seenItems={seenItems}
        onMarkSeen={handleStoryView}
        resolveMediaUrl={buildMediaUrl}
        dir="rtl"
        mobileLayout="avatar"
        emptyPreviewLabel="ویدیو"
        unavailableText="این آیتم در دسترس نیست."
        // Hoisted: a new labels object each render rebuilt every story item in the viewer.
        viewerLabels={VIEWER_LABELS}
        onMediaIssue={reportStoryMediaIssue}
        showPagination
        paginationLabels={{ previous: "داستان‌های قبلی", next: "داستان‌های بعدی" }}
      />
    </div>
  );
}
