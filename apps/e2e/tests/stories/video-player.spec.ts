import { expect, test, type Page } from "@playwright/test";
import { startMediaServer, type MediaServer } from "../../helpers/media-server";
import { VIDEO_FIXTURE_DIR, ensurePipelineClips, ffmpegAvailable, type PipelineClip } from "../../helpers/video-fixtures";

/**
 * The shared playback engine (@repo/video-player) against real browser media pipelines,
 * playing exactly what the media worker publishes (pipeline-built fMP4 HLS ladder,
 * normalized MP4, poster) from a real HTTP origin with ranges, CORS and injected faults.
 *
 * Linux WebKit exercises the MSE/hls.js path, not iOS native HLS; that path is covered by
 * the source-selection unit tests and the manual matrix.
 *
 * Playwright's Linux WebKit (GStreamer) also intermittently stalls progressive MP4 with an
 * audio track at t≈0: buffered to the end, readyState 2, no error. It happens with a bare
 * `<video src>` that none of this code touches, and the same file plays in one run and
 * stalls in the next, so MP4 time-advance is not asserted there (Safari's AVFoundation
 * pipeline is covered by the manual matrix). The fallback decision itself is.
 */

interface PlayerSpec {
  id: string;
  source: { mp4: string; webm?: string | null; hls?: string | null; poster?: string | null };
  active: boolean;
  playing: boolean;
  allowHls: boolean;
}

let media: MediaServer;
let clips: PipelineClip[];

test.describe("video player engine", () => {
  test.skip(!ffmpegAvailable(), "needs ffmpeg to build pipeline fixtures");
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    clips = ensurePipelineClips(2, { seconds: 6 });
    media = await startMediaServer(VIDEO_FIXTURE_DIR);
  });

  test.afterAll(async () => {
    await media?.close();
  });

  test.beforeEach(() => {
    media.faults.clear();
    media.requests.length = 0;
  });

  const player = (id: string, clip: PipelineClip, extra: Partial<PlayerSpec> = {}): PlayerSpec => ({
    id,
    source: { mp4: media.url(clip.mp4), hls: media.url(clip.hls), poster: media.url(clip.poster) },
    active: true,
    playing: true,
    allowHls: true,
    ...extra,
  });

  async function openPlayers(page: Page, players: PlayerSpec[]) {
    await page.goto(`/?players=${encodeURIComponent(JSON.stringify(players))}`);
    await expect(page.getByTestId("harness-ready")).toBeVisible();
  }

  const marker = (page: Page, id: string) => page.locator(`[data-player="${id}"]`);
  const videoOf = (page: Page, id: string) => marker(page, id).locator("xpath=..").locator("video");
  const posterOf = (page: Page, id: string) => marker(page, id).locator("xpath=..").locator('img[aria-hidden="true"]');

  async function expectPlaying(page: Page, id: string) {
    await expect
      .poll(() => videoOf(page, id).evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 30_000 })
      .toBeGreaterThan(0.5);
  }

  /** Progressive-MP4 playback, except where the browser build cannot show it (see below). */
  async function expectMp4Playing(page: Page, id: string, browserName: string) {
    if (browserName === "webkit") return;
    await expectPlaying(page, id);
  }


  test("starts directly on WebM when MP4 capability is unavailable, without an MP4 request", async ({ page }) => {
    await page.addInitScript(() => {
      const real = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function(type) { return type.includes("mp4") ? "" : real.call(this, type); };
    });
    await openPlayers(page, [player("a", clips[0], { allowHls: false, source: { mp4: media.url(clips[0].mp4), webm: media.url(clips[0].webm) } })]);
    await expect(marker(page, "a")).toHaveAttribute("data-engine", "webm");
    await expectPlaying(page, "a");
    await expect(marker(page, "a")).toHaveAttribute("data-first-frame", "true");
    expect(media.requests).toContain(clips[0].webm);
    expect(media.requests).not.toContain(clips[0].mp4);
  });
  test("recovers a confirmed MP4 decode failure through one WebM attempt", async ({ page }) => {
    await openPlayers(page, [player("a", clips[0], { allowHls: false, playing: false, source: { mp4: media.url(clips[0].mp4), webm: media.url(clips[0].webm) } })]);
    await videoOf(page, "a").evaluate((video: HTMLVideoElement) => {
      Object.defineProperty(video, "error", { configurable: true, get: () => ({ code: 3 }) });
      video.dispatchEvent(new Event("error"));
      delete (video as unknown as Record<string, unknown>).error;
    });
    await expect(marker(page, "a")).toHaveAttribute("data-engine", "webm");
    await page.evaluate(() => window.__setPlayer("a", { playing: true }));
    await expectPlaying(page, "a");
    await expect(marker(page, "a")).toHaveAttribute("data-first-frame", "true");
    expect(media.requests.filter((path) => path === clips[0].webm).length).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__videoEvents.filter((event) => event.type === "error" && event.fatal))).toHaveLength(0);
  });
  test("inactive WebM-capable players request no optional media", async ({ page }) => {
    await openPlayers(page, [player("a", clips[0], { active: false, playing: false, source: { mp4: media.url(clips[0].mp4), webm: media.url(clips[0].webm) } })]);
    expect(media.requests.filter((path) => /\.(mp4|webm|m3u8|m4s)$/.test(path))).toHaveLength(0);
  });

  test("plays the HLS ladder through hls.js over MSE", async ({ page }) => {
    await openPlayers(page, [player("a", clips[0])]);
    await expect(marker(page, "a")).toHaveAttribute("data-engine", "hls.js");
    await expectPlaying(page, "a");
    await expect(marker(page, "a")).toHaveAttribute("data-first-frame", "true");
    // MSE, not the progressive file.
    expect(await videoOf(page, "a").evaluate((video: HTMLVideoElement) => video.currentSrc)).toMatch(/^blob:/);
    const hlsDir = clips[0].hls.replace(/master\.m3u8$/, "");
    expect(media.requests).toContain(clips[0].hls);
    expect(media.requests.some((path) => path.startsWith(hlsDir) && path.endsWith("/index.m3u8"))).toBe(true);
    expect(media.requests.some((path) => path.startsWith(hlsDir) && /init_\d+\.mp4$/.test(path))).toBe(true);
    expect(media.requests.some((path) => path.startsWith(hlsDir) && path.endsWith(".m4s"))).toBe(true);
    expect(media.requests).not.toContain(clips[0].mp4);
  });

  test("an unreadable playlist (no CORS) falls back to the MP4 and HLS is skipped for the session", async ({ page, browserName }) => {
    media.faults.set(clips[0].hls, { kind: "no-cors" });
    await openPlayers(page, [player("a", clips[0]), player("b", clips[1], { active: false, playing: false })]);

    await expect(marker(page, "a")).toHaveAttribute("data-engine", "mp4");
    await expectMp4Playing(page, "a", browserName);
    expect(await videoOf(page, "a").evaluate((video: HTMLVideoElement) => video.currentSrc)).toBe(media.url(clips[0].mp4));
    const events = await page.evaluate(() => window.__videoEvents);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", failure: "hls-fallback", detail: "manifest 0", fatal: false }),
    );

    // The next video on the page goes straight to MP4: no playlist round trip to fail again.
    await page.evaluate(() => window.__setPlayer("b", { active: true, playing: true }));
    await expect(marker(page, "b")).toHaveAttribute("data-engine", "mp4");
    await expectMp4Playing(page, "b", browserName);
    expect(media.requests).not.toContain(clips[1].hls);
  });

  test("a missing playlist falls back for that video only", async ({ page, browserName }) => {
    media.faults.set(clips[0].hls, { kind: "status", status: 404 });
    await openPlayers(page, [player("a", clips[0]), player("b", clips[1], { active: false, playing: false })]);
    await expect(marker(page, "a")).toHaveAttribute("data-engine", "mp4");
    await expectMp4Playing(page, "a", browserName);

    await page.evaluate(() => window.__setPlayer("b", { active: true, playing: true }));
    await expect(marker(page, "b")).toHaveAttribute("data-engine", "hls.js");
    await expectPlaying(page, "b");
  });

  test("keeps the poster up until a real frame is on screen", async ({ page }) => {
    // Fresh URLs (nothing cached from earlier tests), with every media response held so
    // there is a measurable gap before the first frame.
    const alias = `alias-${Date.now()}`;
    media.faults.set(`${alias}/*`, { kind: "delay", ms: 1_500 });
    await openPlayers(page, [
      {
        ...player("a", clips[0]),
        source: {
          mp4: media.url(`${alias}/${clips[0].mp4}`),
          hls: media.url(`${alias}/${clips[0].hls}`),
          poster: media.url(clips[0].poster),
        },
      },
    ]);

    await expect(posterOf(page, "a")).toHaveCSS("opacity", "1");
    await expect(marker(page, "a")).toHaveAttribute("data-first-frame", "false");
    await expectPlaying(page, "a");
    await expect(marker(page, "a")).toHaveAttribute("data-first-frame", "true");
    await expect(posterOf(page, "a")).toHaveCSS("opacity", "0");
  });

  test("rapid activation never leaks engines, hls.js instances or requests", async ({ page }) => {
    await openPlayers(page, [player("a", clips[0], { active: false, playing: false })]);
    for (let index = 0; index < 20; index += 1) {
      await page.evaluate((active) => window.__setPlayer("a", { active, playing: active }), index % 2 === 0);
      await page.waitForTimeout(40);
    }
    await page.evaluate(() => window.__setPlayer("a", { active: false, playing: false }));
    await expect.poll(() => page.evaluate(() => window.__liveEngines())).toEqual({ engines: 0, hls: 0 });
    expect(await videoOf(page, "a").getAttribute("src")).toBeNull();

    const settled = media.requests.length;
    await page.waitForTimeout(1_500);
    expect(media.requests.length).toBe(settled);
  });
});

test.describe("story viewer on pipeline media", () => {
  test.skip(!ffmpegAvailable(), "needs ffmpeg to build pipeline fixtures");
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    clips = ensurePipelineClips(2, { seconds: 6 });
    media = await startMediaServer(VIDEO_FIXTURE_DIR);
  });

  test.afterAll(async () => {
    await media?.close();
  });

  function stories() {
    return Array.from({ length: 4 }, (_, index) => {
      const clip = clips[index % clips.length];
      const file = { id: 7000 + index, url: media.url(clip.mp4), mime: "video/mp4", previewUrl: media.url(clip.poster) };
      return {
        id: 800 + index,
        Title: `pipeline ${index}`,
        MediaType: "video",
        Media: file,
        DurationMs: 6000,
        Items: [{ Key: `pipe:${index}`, MediaType: "video", Media: file, DurationMs: 6000 }],
        updatedAt: new Date(Date.UTC(2026, 0, 100 - index)).toISOString(),
      };
    });
  }

  test("rapid taps keep a single player alive and closing leaves nothing running", async ({ page, browserName }) => {
    await page.goto(`/?stories=${encodeURIComponent(JSON.stringify(stories()))}&dir=rtl`);
    await expect(page.getByTestId("harness-ready")).toBeVisible();
    // No admin cover: the rail avatar is the media worker's generated poster.
    await page.getByRole("button", { name: "نمایش استوری pipeline 0" }).click();
    await expect(page.getByTestId("story-media-surface").first()).toBeVisible();
    if (browserName !== "webkit") {
      // The pipeline MP4 actually plays in the story viewer (see the WebKit note above).
      await expect
        .poll(() => page.locator("video").first().evaluate((video: HTMLVideoElement) => video.currentTime), {
          timeout: 30_000,
        })
        .toBeGreaterThan(0.5);
    }

    const box = (await page.locator(".story-viewer-content").boundingBox())!;
    let maxVideos = 0;
    for (let tap = 0; tap < 8; tap += 1) {
      await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.6);
      await page.waitForTimeout(60);
      maxVideos = Math.max(maxVideos, await page.locator("video").count());
      const live = await page.evaluate(() => window.__liveEngines());
      expect(live.engines).toBeLessThanOrEqual(1);
    }
    expect(maxVideos).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.__liveEngines())).toEqual({ engines: 0, hls: 0 });
    const settled = media.requests.length;
    await page.waitForTimeout(1_500);
    expect(media.requests.length).toBe(settled);
  });
});
