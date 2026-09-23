import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startMediaServer, type MediaServer } from "../../helpers/media-server";
import { VIDEO_FIXTURE_DIR, ensurePipelineClips, ffmpegAvailable, type PipelineClip } from "../../helpers/video-fixtures";

/**
 * Story playback timing under throttled networks, on realistic media (pipeline-encoded
 * 10 s, ~2.5 Mbps 720x1280 clips served over a real HTTP origin with ranges and CORS).
 *
 * Measures what a viewer perceives, sampled every animation frame:
 *  - open → first frame: tap on the avatar until a video frame is actually showing;
 *  - story → story: tap next until the *new* element shows a frame;
 *  - blank time: frames where neither the poster nor a video frame was visible;
 *  - media bytes/requests, to see what warming costs.
 *
 * Opt-in (VIDEO_PERF=1) and Chromium-only: it relies on CDP network emulation and takes
 * minutes. Results land in apps/e2e/.cache/video-perf/<PERF_LABEL>-<poster mode>.json.
 *
 *   VIDEO_PERF=1 PERF_LABEL=baseline pnpm --filter @repo/e2e e2e:stories --project chromium-desktop -g "@perf"
 */

const PROFILES = [
  { name: "slow-1.5mbps-150ms", downloadKbps: 1500, latencyMs: 150 },
  { name: "4g-10mbps-40ms", downloadKbps: 10_000, latencyMs: 40 },
] as const;
const RUNS = Number(process.env.PERF_RUNS || 3);

interface Sample {
  openFirstFrameMs: number;
  openBlankMs: number;
  nextFirstFrameMs: number;
  nextBlankMs: number;
  mediaBytes: number;
  mediaRequests: number;
}

declare global {
  interface Window {
    __perfMeasure?: Promise<{ firstFrameMs: number; blankMs: number }>;
    __perfLastVideo?: HTMLVideoElement | null;
  }
}

function buildStories(clips: PipelineClip[], media: MediaServer, { withPoster }: { withPoster: boolean }) {
  return clips.map((clip, index) => {
    const file = {
      id: 5000 + index,
      url: media.url(clip.mp4),
      mime: "video/mp4",
      previewUrl: media.url(clip.poster),
      provider_metadata: {
        video: {
          schema: 1,
          status: "streaming_ready",
          output: {
            token: "v1-00000000",
            width: 720,
            height: 1280,
            fps: 30,
            durationMs: 10_000,
            hasAudio: true,
            mp4: { url: media.url(clip.mp4), bytes: 0 },
            poster: { url: media.url(clip.poster), width: 540, height: 960 },
            hls: { master: media.url(clip.hls), token: "v1-00000000", segmentSeconds: 4, bytes: 0, renditions: [] },
          },
        },
      },
    };
    return {
      id: 900 + index,
      Title: `perf ${index}`,
      MediaType: "video",
      Media: file,
      ...(withPoster ? { Thumbnail: { id: 6000 + index, url: media.url(clip.poster), mime: "image/jpeg" } } : {}),
      DurationMs: 10_000,
      Items: [
        {
          Key: `perf:${index}`,
          MediaType: "video",
          Media: file,
          ...(withPoster ? { Thumbnail: { id: 6000 + index, url: media.url(clip.poster), mime: "image/jpeg" } } : {}),
          DurationMs: 10_000,
        },
      ],
      updatedAt: new Date(Date.UTC(2026, 0, 100 - index)).toISOString(),
    };
  });
}

/**
 * Arms a frame-by-frame probe that starts on the next pointer release and resolves when a
 * video element different from the last measured one is showing a decoded frame.
 */
async function armFirstFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__perfMeasure = new Promise((resolve, reject) => {
      let start = 0;
      let last = 0;
      let blankMs = 0;
      const timeout = window.setTimeout(() => reject(new Error("no first frame within 45s")), 45_000);
      const visible = (element: Element | null) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.opacity !== "0" && style.visibility !== "hidden" && style.display !== "none";
      };
      const tick = () => {
        const now = performance.now();
        const surface = document.querySelector('[data-testid="story-media-surface"]');
        const video = surface?.querySelector("video") as HTMLVideoElement | null;
        const poster = surface?.querySelector('img[aria-hidden="true"]') as HTMLImageElement | null;
        const fresh = Boolean(video && video !== window.__perfLastVideo);
        const presented = Boolean(fresh && video && visible(video) && video.readyState >= 2 && video.currentTime > 0);
        const posterShowing = Boolean(poster && visible(poster) && poster.complete && poster.naturalWidth > 0);
        if (!presented && !posterShowing) blankMs += now - last;
        last = now;
        if (presented) {
          window.clearTimeout(timeout);
          window.__perfLastVideo = video;
          resolve({ firstFrameMs: now - start, blankMs });
          return;
        }
        requestAnimationFrame(tick);
      };
      document.addEventListener(
        "pointerup",
        () => {
          start = performance.now();
          last = start;
          requestAnimationFrame(tick);
        },
        { once: true, capture: true },
      );
    });
  });
}

async function readProbe(page: Page) {
  return page.evaluate(() => window.__perfMeasure!);
}

async function tapNext(page: Page) {
  // The harness is RTL: the left half advances.
  const box = (await page.locator(".story-viewer-content").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.6);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? Number.NaN);
};

test.describe("@perf story playback timing", () => {
  test.skip(process.env.VIDEO_PERF !== "1", "opt-in: VIDEO_PERF=1");
  test.skip(({ browserName }) => browserName !== "chromium", "needs CDP network emulation");
  test.skip(!ffmpegAvailable(), "needs ffmpeg to build pipeline fixtures");
  test.setTimeout(20 * 60_000);

  let media: MediaServer;
  let clips: PipelineClip[];

  test.beforeAll(async () => {
    clips = ensurePipelineClips(3);
    media = await startMediaServer(VIDEO_FIXTURE_DIR);
  });

  test.afterAll(async () => {
    await media?.close();
  });

  for (const posterMode of ["with-poster", "no-poster"] as const) {
    test(`open and advance, ${posterMode}`, async ({ browser }, testInfo) => {
      test.skip(testInfo.project.name !== "chromium-desktop", "one project is enough");
      const results: Record<string, { samples: Sample[]; median: Record<keyof Sample, number> }> = {};

      for (const profile of PROFILES) {
        const samples: Sample[] = [];
        for (let run = 0; run < RUNS; run += 1) {
          const context = await browser.newContext({ locale: "fa-IR" });
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Network.enable");
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: profile.latencyMs,
            downloadThroughput: (profile.downloadKbps * 1000) / 8,
            uploadThroughput: (profile.downloadKbps * 1000) / 16,
          });
          const mediaRequestIds = new Set<string>();
          let mediaBytes = 0;
          cdp.on("Network.requestWillBeSent", (event: any) => {
            if (String(event.request.url).startsWith(media.origin)) mediaRequestIds.add(event.requestId);
          });
          // dataReceived, not loadingFinished: media elements cancel range requests they no
          // longer need, and a cancelled request never "finishes" but did cost bytes.
          cdp.on("Network.dataReceived", (event: any) => {
            if (mediaRequestIds.has(event.requestId)) mediaBytes += event.encodedDataLength || event.dataLength;
          });

          const stories = encodeURIComponent(
            JSON.stringify(buildStories(clips, media, { withPoster: posterMode === "with-poster" })),
          );
          await page.goto(`/?stories=${stories}&dir=rtl`);
          await expect(page.getByTestId("harness-ready")).toBeVisible();

          await armFirstFrameProbe(page);
          await page.getByRole("button", { name: "نمایش استوری perf 0" }).click();
          const open = await readProbe(page);

          // Let the first story play a little, as a viewer would, before advancing.
          await page.waitForTimeout(2_000);
          await armFirstFrameProbe(page);
          await tapNext(page);
          const next = await readProbe(page);

          samples.push({
            openFirstFrameMs: Math.round(open.firstFrameMs),
            openBlankMs: Math.round(open.blankMs),
            nextFirstFrameMs: Math.round(next.firstFrameMs),
            nextBlankMs: Math.round(next.blankMs),
            mediaBytes,
            mediaRequests: mediaRequestIds.size,
          });
          await context.close();
        }
        const keys = Object.keys(samples[0]) as Array<keyof Sample>;
        results[profile.name] = {
          samples,
          median: Object.fromEntries(keys.map((key) => [key, median(samples.map((sample) => sample[key]))])) as Record<
            keyof Sample,
            number
          >,
        };
      }

      const label = process.env.PERF_LABEL || "run";
      const outDir = join(VIDEO_FIXTURE_DIR, "..", "video-perf");
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, `${label}-${posterMode}.json`), JSON.stringify(results, null, 2));
      console.log(`\n[video-perf] ${label} ${posterMode}`);
      console.table(Object.fromEntries(Object.entries(results).map(([name, value]) => [name, value.median])));
    });
  }
});
