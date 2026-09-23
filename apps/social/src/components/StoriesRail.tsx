"use client";

import { useCallback, useEffect } from "react";
import { StoryRail as SharedStoryRail, type StoryViewerLabels } from "@repo/story-rail";
import type { Story } from "@/types/story";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useStoriesSeenState } from "@/hooks/use-stories-seen-state";
import { InfinityMarkCircle } from "@/components/InfinityMarkCircle";
import { buildStoryMediaUrl } from "@/lib/story-media-url";
import { ensureVideoTelemetry, reportStoryMediaIssue } from "@/lib/video-telemetry";

export interface StoriesRailProps {
  stories: Story[];
}

const MOBILE_INFINITY_MARK_PX = 15;

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

function renderSocialMobileBadge() {
  return (
    <div
      dir="ltr"
      className="absolute bottom-[2.13%] right-[4.65%] flex flex-row items-center gap-[3px]"
    >
      <span className="flex w-9 shrink-0 items-center text-right font-peyda text-[10px] font-medium leading-[21px] text-white">
        اینفینیتی
      </span>
      <InfinityMarkCircle circleSize={20} markSize={MOBILE_INFINITY_MARK_PX} />
    </div>
  );
}

/**
 * Social adapter for the shared story rail package.
 */
export function StoriesRail({ stories }: StoriesRailProps) {
  const { isAuthenticated } = useCurrentUser();
  const { seenIds, seenItems, markSeen } = useStoriesSeenState(isAuthenticated);
  useEffect(() => ensureVideoTelemetry(), []);

  const handleStoryView = useCallback((storyId: number, itemKey: string) => {
    void markSeen(storyId, itemKey);
  }, [markSeen]);

  return (
    <SharedStoryRail
      stories={stories}
      seenIds={seenIds}
      seenItems={seenItems}
      onMarkSeen={handleStoryView}
      resolveMediaUrl={buildStoryMediaUrl}
      heading="داستان ها"
      dir="rtl"
      renderMobileBadge={renderSocialMobileBadge}
      emptyPreviewLabel="ویدیو"
      unavailableText="این آیتم در دسترس نیست."
      // Hoisted: a new labels object each render rebuilt every story item in the viewer.
      viewerLabels={VIEWER_LABELS}
      onMediaIssue={reportStoryMediaIssue}
    />
  );
}
