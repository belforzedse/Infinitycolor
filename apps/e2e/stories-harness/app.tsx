/**
 * A minimal host for the real `@repo/story-rail` components.
 *
 * The storefront fetches stories in a Server Component, which the browser cannot
 * intercept, and booting Strapi + Next just to open a story viewer would make these tests
 * depend on a whole stack. This mounts the same rail and viewer the apps mount, with the
 * story list supplied through the URL, so every media response can be shaped by Playwright
 * route interception and the suite runs anywhere.
 */
import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { StoryRail } from "@repo/story-rail";
import type { StoryRailStory } from "@repo/story-rail";
import "react-instagram-stories/styles.css";
import "./harness.css";

declare global {
  interface Window {
    __storyViews: number[];
  }
}

window.__storyViews = [];

function readStories(): StoryRailStory[] {
  const raw = new URLSearchParams(window.location.search).get("stories");
  if (!raw) return [];
  return JSON.parse(decodeURIComponent(raw)) as StoryRailStory[];
}

function Harness() {
  const [stories] = useState(readStories);
  const [seenIds, setSeenIds] = useState<Set<number>>(new Set());

  // Mirrors the apps' `markSeen`: record the id, and count every call so a test can prove
  // a story is reported exactly once.
  const onMarkSeen = useCallback((storyId: number) => {
    window.__storyViews.push(storyId);
    setSeenIds((prev) => (prev.has(storyId) ? prev : new Set(prev).add(storyId)));
  }, []);

  return (
    <main>
      <h1 data-testid="harness-ready">Stories harness</h1>
      <StoryRail
        stories={stories}
        seenIds={seenIds}
        onMarkSeen={onMarkSeen}
        resolveMediaUrl={(url) => url}
        dir="rtl"
        mobileLayout="avatar"
        emptyPreviewLabel="ویدیو"
        unavailableText="Story unavailable"
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
