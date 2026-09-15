import { expect, test, type Page } from "@playwright/test";
import {
  installStoryMedia,
  mediaUrl,
  STORY_FIXTURES,
  type MediaRouteState,
} from "../../helpers/story-media";

/**
 * Real-browser coverage for the Stories viewer. The state machine itself is unit-tested
 * in `packages/story-rail`; what only a browser can show is how our code behaves against
 * an actual media pipeline — which differs sharply between Chromium, Firefox and WebKit.
 */

declare global {
  interface Window {
    /** Story ids the harness has been asked to mark seen, in order. */
    __storyViews: number[];
  }
}

interface StorySpec {
  id: number;
  title: string;
  kind: "image" | "video";
  file: string;
  cover?: string;
  durationMs?: number;
  ctaUrl?: string;
}

function buildStories(specs: StorySpec[]) {
  // The rail sorts newest-first, so the timestamps must descend in the intended order.
  return specs.map((spec, index) => ({
    id: spec.id,
    Title: spec.title,
    MediaType: spec.kind,
    Media: {
      id: 1000 + spec.id,
      url: mediaUrl(spec.file),
      mime: spec.kind === "video" ? "video/mp4" : "image/webp",
    },
    ...(spec.cover
      ? {
          Thumbnail: {
            id: 2000 + spec.id,
            url: mediaUrl(spec.cover),
            mime: "image/webp",
          },
        }
      : {}),
    DurationMs: spec.durationMs ?? 2000,
    ...(spec.ctaUrl ? { CtaUrl: spec.ctaUrl } : {}),
    updatedAt: new Date(Date.UTC(2026, 0, 100 - index)).toISOString(),
  }));
}

async function openHarness(page: Page, specs: StorySpec[]): Promise<MediaRouteState> {
  const media = await installStoryMedia(page);
  const stories = encodeURIComponent(JSON.stringify(buildStories(specs)));
  await page.goto(`/?stories=${stories}`);
  await expect(page.getByTestId("harness-ready")).toBeVisible();
  return media;
}

const surface = (page: Page) => page.getByTestId("story-media-surface").first();
const phase = (page: Page) => surface(page).getAttribute("data-phase");

async function openViewer(page: Page, title: string) {
  await page.getByRole("button", { name: `نمایش استوری ${title}` }).click();
  await expect(surface(page)).toBeVisible();
}

async function progress(page: Page): Promise<number> {
  return page.evaluate(() => {
    const fill = document.querySelector(".story-progress-bar-fill") as HTMLElement | null;
    const match = /scaleX\(([\d.]+)\)/.exec(fill?.style.transform ?? "");
    return match ? Number(match[1]) : Number.NaN;
  });
}

/** Taps the right half of the story surface, which is the viewer's "next" gesture. */
async function tapNext(page: Page) {
  const box = (await page.locator(".story-viewer-content").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.6);
}

async function tapPrevious(page: Page) {
  const box = (await page.locator(".story-viewer-content").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.6);
}

const IMAGE_A: StorySpec = {
  id: 1,
  title: "aaa",
  kind: "image",
  file: STORY_FIXTURES.image,
};
const VIDEO_B: StorySpec = {
  id: 2,
  title: "bbb",
  kind: "video",
  file: STORY_FIXTURES.video,
  cover: STORY_FIXTURES.image,
};
const IMAGE_C: StorySpec = {
  id: 3,
  title: "ccc",
  kind: "image",
  file: STORY_FIXTURES.image,
};

test.describe("Stories viewer", () => {
  test("plays a mixed image → video → image sequence and advances itself", async ({ page }) => {
    await openHarness(page, [IMAGE_A, VIDEO_B, IMAGE_C]);
    await openViewer(page, "aaa");

    await expect(surface(page)).toHaveAttribute("data-phase", "playing");
    // The image story runs on its configured duration and hands over on its own.
    await expect(page.locator("video")).toHaveCount(1, { timeout: 15_000 });
    await expect(surface(page)).toHaveAttribute("data-phase", "playing", {
      timeout: 15_000,
    });
    // …and the video hands over to the last image. The view for the incoming story is
    // reported once the cube transition settles, so poll rather than sampling mid-flight.
    await expect(page.locator("video")).toHaveCount(0, { timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => window.__storyViews), { timeout: 10_000 })
      .toEqual([1, 2, 3]);
  });

  test("reports each story view exactly once, including on revisit", async ({ page }) => {
    await openHarness(page, [IMAGE_A, VIDEO_B, IMAGE_C]);
    await openViewer(page, "aaa");

    await tapNext(page);
    await expect(page.locator("video")).toHaveCount(1);
    await tapPrevious(page);
    await expect(page.locator("video")).toHaveCount(0);
    await tapNext(page);
    await expect(page.locator("video")).toHaveCount(1);

    const views = await page.evaluate(() => window.__storyViews);
    // A view is recorded per story, not per visit: revisiting story 1 must not re-report.
    expect(views.filter((id: number) => id === 1)).toHaveLength(1);
    expect(views.filter((id: number) => id === 2)).toHaveLength(1);
  });

  test("shows the fixed CTA at the bottom and opens its safe destination", async ({ page }) => {
    await page.context().route("https://external.test/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>Destination</title>",
      }),
    );
    await openHarness(page, [
      {
        ...IMAGE_A,
        durationMs: 10_000,
        ctaUrl: "https://external.test/collection",
      },
      IMAGE_C,
    ]);
    await openViewer(page, "aaa");

    const cta = page.getByRole("link", { name: "مشاهده لینک" });
    await expect(cta).toBeVisible();
    const [surfaceBox, ctaBox] = await Promise.all([
      surface(page).boundingBox(),
      cta.boundingBox(),
    ]);
    expect(surfaceBox).not.toBeNull();
    expect(ctaBox).not.toBeNull();
    expect(ctaBox!.y).toBeGreaterThan(surfaceBox!.y + surfaceBox!.height * 0.7);

    const popupPromise = page.waitForEvent("popup");
    await cta.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://external.test/collection");
    await expect(surface(page)).toBeVisible();
    expect(await page.evaluate(() => window.__storyViews)).toEqual([1]);
  });

  test("does not start progress until the media is ready to present", async ({ page }) => {
    const media = await openHarness(page, [VIDEO_B, IMAGE_C]);
    media.behaviour.set(STORY_FIXTURES.video, { kind: "slow", delayMs: 3000 });

    await openViewer(page, "bbb");
    await expect(surface(page)).not.toHaveAttribute("data-phase", "playing");
    // Upstream would have been a third of the way through a 2s story by now.
    await page.waitForTimeout(1500);
    expect(await progress(page)).toBe(0);
    expect(await phase(page)).not.toBe("playing");

    await expect(surface(page)).toHaveAttribute("data-phase", "playing", {
      timeout: 15_000,
    });
  });

  test("a stalled response neither skips the story nor spins forever", async ({ page }) => {
    const media = await openHarness(page, [VIDEO_B, IMAGE_C]);
    media.behaviour.set(STORY_FIXTURES.video, { kind: "hang" });

    await openViewer(page, "bbb");
    await page.waitForTimeout(4000);

    // Still on the same story, with the cover visible rather than a blank screen.
    expect(await progress(page)).toBe(0);
    await expect(page.locator("video")).toHaveCount(1);
    await expect(
      page.locator(`img[src="${mediaUrl(STORY_FIXTURES.image)}"]`).first(),
    ).toBeVisible();
    // Navigation still works — the viewer is never a trap.
    await tapNext(page);
    await expect(page.locator("video")).toHaveCount(0);
  });

  test("broken media shows a retryable error and still allows navigation", async ({ page }) => {
    const media = await openHarness(page, [{ ...VIDEO_B, cover: undefined }, IMAGE_C]);
    media.behaviour.set(STORY_FIXTURES.video, { kind: "status", status: 404 });

    await openViewer(page, "bbb");
    await expect(page.getByTestId("story-media-error")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("story-media-spinner")).toHaveCount(0);

    // It must not auto-skip, and it must not block the user either.
    await page.waitForTimeout(2000);
    await expect(page.getByTestId("story-media-error")).toBeVisible();
    await tapNext(page);
    await expect(page.getByTestId("story-media-error")).toHaveCount(0);
  });

  test("a server error is handled like any other unusable media", async ({ page }) => {
    const media = await openHarness(page, [{ ...VIDEO_B, cover: undefined }, IMAGE_C]);
    media.behaviour.set(STORY_FIXTURES.video, { kind: "status", status: 500 });

    await openViewer(page, "bbb");
    await expect(page.getByTestId("story-media-error")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("rapid tapping never leaves more than one player or skips past the end", async ({
    page,
  }) => {
    await openHarness(page, [IMAGE_A, VIDEO_B, IMAGE_C]);
    await openViewer(page, "aaa");

    const box = (await page.locator(".story-viewer-content").boundingBox())!;
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.6, { delay: 10 });
    }
    await page.waitForTimeout(500);

    // Overlapping players were the old failure mode here; there is at most one.
    expect(await page.locator("video").count()).toBeLessThanOrEqual(1);
    const views = await page.evaluate(() => window.__storyViews);
    expect(new Set(views).size).toBe(views.length);
  });

  test("only the active story holds a player, and closing stops playback", async ({ page }) => {
    await openHarness(page, [VIDEO_B, IMAGE_C]);
    await openViewer(page, "bbb");
    await expect(surface(page)).toHaveAttribute("data-phase", "playing", {
      timeout: 15_000,
    });

    expect(await page.locator("video").count()).toBe(1);
    const paused = await page.evaluate(() => document.querySelector("video")!.paused);
    expect(paused).toBe(false);

    await page.locator(".story-viewer-close").click();
    await expect(page.locator("video")).toHaveCount(0);
    // Body scroll must be released; upstream's uncleared timeout left it locked.
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
  });

  test("reopening starts from a clean state", async ({ page }) => {
    await openHarness(page, [VIDEO_B, IMAGE_C]);
    await openViewer(page, "bbb");
    await expect(surface(page)).toHaveAttribute("data-phase", "playing", {
      timeout: 15_000,
    });
    await page.waitForTimeout(800);
    expect(await progress(page)).toBeGreaterThan(0);

    await page.locator(".story-viewer-close").click();
    await expect(page.locator("video")).toHaveCount(0);

    await openViewer(page, "bbb");
    const currentTime = await page.evaluate(() => document.querySelector("video")!.currentTime);
    expect(currentTime).toBeLessThan(0.5);
  });

  test("a hidden tab pauses playback without completing the story", async ({ page }) => {
    await openHarness(page, [VIDEO_B, IMAGE_C]);
    await openViewer(page, "bbb");
    await expect(surface(page)).toHaveAttribute("data-phase", "playing", {
      timeout: 15_000,
    });

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(surface(page)).toHaveAttribute("data-held", "true");
    await page.waitForTimeout(3000);

    // Still story 2 — a hidden tab must never silently complete stories.
    const views = await page.evaluate(() => window.__storyViews);
    expect(views).toEqual([2]);
  });

  test("an undecodable video track falls back to the cover instead of a black frame", async ({
    page,
  }, testInfo) => {
    // Reproduces the production media shape: HEVC in a QuickTime container. Chromium
    // builds without platform HEVC parse it happily — readyState 4, `playing` fires,
    // currentTime advances — while decoding zero frames and never firing `error`. Engines
    // that *can* decode it must simply play it. Either way the viewer must show something
    // and move on; a silent black frame is the one unacceptable outcome.
    await openHarness(page, [
      {
        id: 9,
        title: "hevc",
        kind: "video",
        file: STORY_FIXTURES.hevcVideo,
        cover: STORY_FIXTURES.image,
      },
      IMAGE_C,
    ]);
    await openViewer(page, "hevc");

    // Settle on the real invariant — "showing something a viewer can actually see" —
    // rather than on `playing`, which Chromium reaches ~600ms before the decode probe
    // has had a chance to notice that no frames exist.
    const presentedState = async () => {
      const current = await phase(page);
      if (current === "fallback") return "fallback";
      const width = await page.evaluate(() => document.querySelector("video")?.videoWidth ?? 0);
      return current === "playing" && width > 0 ? "decoded" : `pending:${current}`;
    };
    await expect.poll(presentedState, { timeout: 20_000 }).toMatch(/^(decoded|fallback)$/);

    const settled = await presentedState();
    if (settled === "fallback") {
      // Poster shown, and the element torn down so it stops streaming.
      await expect(page.locator("video")).toHaveCount(0);
      await expect(
        page.locator(`img[src="${mediaUrl(STORY_FIXTURES.image)}"]`).first(),
      ).toBeVisible();
      await expect(page.getByTestId("story-media-error")).toHaveCount(0);
    } else {
      // This engine decodes HEVC; there must be a real picture behind the claim to play.
      const size = await page.evaluate(() => {
        const video = document.querySelector("video")!;
        return { w: video.videoWidth, h: video.videoHeight };
      });
      expect(size.w).toBeGreaterThan(0);
      expect(size.h).toBeGreaterThan(0);
    }
    testInfo.annotations.push({ type: "hevc-outcome", description: settled });

    // And in both cases the sequence keeps moving.
    await expect
      .poll(() => page.evaluate(() => window.__storyViews), { timeout: 20_000 })
      .toEqual([9, 3]);
  });

  test("prefetches the next story's cover without pulling whole video bodies", async ({ page }) => {
    const media = await openHarness(page, [IMAGE_A, VIDEO_B, IMAGE_C]);
    await openViewer(page, "aaa");
    await page.waitForTimeout(1000);

    const videoRequests = media.requests.filter((name) => name === STORY_FIXTURES.video);
    // Metadata-only warming may issue range requests, but the viewer must not be pulling
    // the next story's body repeatedly while still on the first story.
    expect(videoRequests.length).toBeLessThanOrEqual(3);
  });
});
