import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

/**
 * Serves the story media fixtures through Playwright route interception, with the
 * failure modes a real CDN produces. Interception is used rather than a static server
 * because one fixture then covers slow, stalled, missing and server-error responses, and
 * because CI must never depend on a third-party media host.
 *
 * Range support is deliberate: WebKit issues range requests for `<video>`, and the
 * production media has its `moov` atom at the end of the file, so a handler that ignores
 * `Range` would test a delivery shape the real app never sees.
 */

export const STORY_MEDIA_ORIGIN = "https://media.infinitycolor.test";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");

export const STORY_FIXTURES = {
  /** H.264/AAC MP4, faststart — plays in Chromium, Firefox and WebKit. */
  video: "story.mp4",
  /** VP9 WebM with no audio track. */
  silentVideo: "story-silent.webm",
  /** HEVC in a QuickTime container: exactly the shape of the production uploads. */
  hevcVideo: "story-hevc.mov",
  image: "story-cover.webp",
} as const;

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".webp": "image/webp",
};

export type MediaBehaviour =
  | { kind: "ok" }
  /** Responds only after `delayMs`, to prove progress waits for readiness. */
  | { kind: "slow"; delayMs: number }
  | { kind: "status"; status: number }
  /** Never responds, to prove a stall neither skips the story nor spins forever. */
  | { kind: "hang" };

const bodies = new Map<string, Buffer>();

async function fixtureBody(name: string): Promise<Buffer> {
  let body = bodies.get(name);
  if (!body) {
    body = await readFile(join(fixtureDir, name));
    bodies.set(name, body);
  }
  return body;
}

function contentTypeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf("."));
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function fulfil(route: Route, name: string): Promise<void> {
  const body = await fixtureBody(name);
  const contentType = contentTypeFor(name);
  const range = route.request().headers()["range"];

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : body.length - 1;
    await route.fulfill({
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Content-Length": String(end - start + 1),
        "Cache-Control": "public, max-age=3600",
      },
      body: body.subarray(start, end + 1),
    });
    return;
  }

  await route.fulfill({
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(body.length),
      "Cache-Control": "public, max-age=3600",
    },
    body,
  });
}

export interface MediaRouteState {
  /** Requests seen per fixture path, to assert prefetch volume and de-duplication. */
  requests: string[];
  /** Overrides keyed by the path segment after /uploads/. */
  behaviour: Map<string, MediaBehaviour>;
}

/**
 * Routes `${STORY_MEDIA_ORIGIN}/uploads/*` at the context level — the same level
 * `helpers/local-media.ts` uses, because per-page routing misses some media fetches.
 */
export async function installStoryMedia(page: Page): Promise<MediaRouteState> {
  const state: MediaRouteState = { requests: [], behaviour: new Map() };

  await page.context().route(`${STORY_MEDIA_ORIGIN}/uploads/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.replace("/uploads/", "");
    state.requests.push(name);

    const behaviour = state.behaviour.get(name) ?? { kind: "ok" };
    switch (behaviour.kind) {
      case "status":
        await route.fulfill({
          status: behaviour.status,
          contentType: "text/plain",
          body: `fixture status ${behaviour.status}`,
        });
        return;
      case "hang":
        // Deliberately never fulfilled or aborted: the request stays open for the life of
        // the test, which is what a stalled CDN connection looks like to the element.
        return;
      case "slow":
        await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
        await fulfil(route, name);
        return;
      default:
        await fulfil(route, name);
    }
  });

  return state;
}

export function mediaUrl(name: string): string {
  return `${STORY_MEDIA_ORIGIN}/uploads/${name}`;
}
