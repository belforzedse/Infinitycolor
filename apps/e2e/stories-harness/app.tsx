/**
 * A minimal host for the real `@repo/story-rail` components.
 *
 * The storefront fetches stories in a Server Component, which the browser cannot
 * intercept, and booting Strapi + Next just to open a story viewer would make these tests
 * depend on a whole stack. This mounts the same rail and viewer the apps mount, with the
 * story list supplied through the URL, so every media response can be shaped by Playwright
 * route interception and the suite runs anywhere.
 */
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StoryRail } from "@repo/story-rail";
import type { StoryRailStory } from "@repo/story-rail";
// Relative path: the harness package does not depend on video-player directly; story-rail
// does, and esbuild resolves both to the same React copy.
import {
  InlineVideo,
  liveEngineCounts,
  setVideoTelemetrySink,
  type VideoEngineState,
} from "../../../packages/video-player/src/index";
import type { PlayerSpec } from "../helpers/video-harness";
import "react-instagram-stories/styles.css";
import "./harness.css";

window.__storyViews = [];
window.__storyItemViews = [];
window.__videoEvents = [];
window.__videoStates = {};
window.__liveEngines = liveEngineCounts;
setVideoTelemetrySink((event) => window.__videoEvents.push(event));

/**
 * Player mode (`?players=[...]`): bare InlineVideo instances, controlled from the test
 * through `window.__setPlayer`, for engine behaviour that only a real media pipeline
 * shows — hls.js over MSE, CORS fallback, teardown under rapid (de)activation.
 */
function PlayerHarness({ initial }: { initial: PlayerSpec[] }) {
  const [players, setPlayers] = useState(initial);
  useEffect(() => {
    window.__setPlayer = (id, patch) =>
      setPlayers((current) => current.map((player) => (player.id === id ? { ...player, ...patch } : player)));
  }, []);
  return (
    <main>
      <h1 data-testid="harness-ready">Player harness</h1>
      {players.map((player) => (
        <InlineVideo
          key={player.id}
          source={player.source}
          active={player.active}
          playing={player.playing}
          muted
          loop={false}
          surface="harness"
          allowHls={player.allowHls}
          objectFit="contain"
          style={{ width: 270, height: 480, marginBottom: 8 }}
          onStateChange={(state) => {
            window.__videoStates[player.id] = state;
            document.querySelector(`[data-player="${player.id}"]`)?.setAttribute("data-engine", state.engine ?? "");
          }}
        >
          {(state) => <span data-player={player.id} data-engine={state.engine ?? ""} data-phase={state.phase} data-first-frame={String(state.hasFirstFrame)} hidden />}
        </InlineVideo>
      ))}
    </main>
  );
}

function readStories(): StoryRailStory[] {
  const raw = new URLSearchParams(window.location.search).get("stories");
  if (!raw) return [];
  return JSON.parse(decodeURIComponent(raw)) as StoryRailStory[];
}

function Harness() {
  const [stories] = useState(readStories);
  const [seenItems, setSeenItems] = useState<Map<number, Set<string>>>(new Map());
  const direction = new URLSearchParams(window.location.search).get("dir") === "ltr" ? "ltr" : "rtl";

  // Mirrors the apps' `markSeen`: record the id, and count every call so a test can prove
  // a story is reported exactly once.
  const onMarkSeen = useCallback((storyId: number, itemKey: string) => {
    window.__storyViews.push(storyId);
    window.__storyItemViews.push(`${storyId}:${itemKey}`);
    setSeenItems((previous) => {
      const next = new Map(previous);
      next.set(storyId, new Set(next.get(storyId) ?? []).add(itemKey));
      return next;
    });
  }, []);

  return (
    <main>
      <h1 data-testid="harness-ready">Stories harness</h1>
      <StoryRail
        stories={stories}
        seenItems={seenItems}
        onMarkSeen={onMarkSeen}
        resolveMediaUrl={(url) => url}
        dir={direction}
        mobileLayout="avatar"
        emptyPreviewLabel="ویدیو"
        unavailableText="Story unavailable"
      />
    </main>
  );
}

const playersParam = new URLSearchParams(window.location.search).get("players");
createRoot(document.getElementById("root")!).render(
  playersParam ? <PlayerHarness initial={JSON.parse(decodeURIComponent(playersParam)) as PlayerSpec[]} /> : <Harness />,
);
