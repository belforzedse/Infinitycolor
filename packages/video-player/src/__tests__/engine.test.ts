jest.mock(
  "hls.js/light",
  () => ({
    __esModule: true,
    default: jest.requireActual("./fake-hls").FakeHls,
  }),
  {
    virtual: true,
  },
);

import { FakeHls } from "./fake-hls";

import {
  chooseEngine,
  isHlsCircuitOpen,
  resetHlsCircuit,
} from "../capabilities";
import { createVideoEngine, liveEngineCounts } from "../engine";
import { resetBandwidthEstimate } from "../hls-config";
import { setVideoTelemetrySink, type VideoTelemetryEvent } from "../telemetry";
import {
  controlMedia,
  installMediaStub,
  uninstallMediaStub,
} from "./media-stub";

const SOURCE = {
  mp4: "https://cdn.test/uploads/clip_v1-0a1b2c3d.mp4",
  hls: "https://cdn.test/uploads/video/7/v1-0a1b2c3d/master.m3u8",
};

function setMse(supported: boolean) {
  (window as any).MediaSource = supported
    ? { isTypeSupported: () => true }
    : undefined;
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

let events: VideoTelemetryEvent[];
let playlistResponse: () => Promise<{ ok: boolean; status: number }>;

beforeEach(() => {
  // The engine preflights the master playlist before creating hls.js.
  playlistResponse = async () => ({ ok: true, status: 200 });
  (globalThis as any).fetch = jest.fn(() => playlistResponse());
  installMediaStub();
  FakeHls.reset();
  resetHlsCircuit();
  resetBandwidthEstimate();
  events = [];
  setVideoTelemetrySink((event) => events.push(event));
  setMse(true);
});

afterEach(() => {
  setVideoTelemetrySink(null);
  uninstallMediaStub();
  jest.useRealTimers();
});

describe("chooseEngine", () => {
  it("prefers hls.js wherever MSE plays H.264, even if the element also claims native HLS", () => {
    const video = document.createElement("video");
    video.canPlayType = () => "maybe";
    expect(chooseEngine(SOURCE, { allowHls: true, video })).toBe("hls.js");
  });

  it("uses native HLS only without MSE (iPhone before iOS 17.1)", () => {
    setMse(false);
    const video = document.createElement("video");
    video.canPlayType = (type: string) =>
      type === "application/vnd.apple.mpegurl" ? "maybe" : "";
    expect(chooseEngine(SOURCE, { allowHls: true, video })).toBe("native-hls");
  });

  it("falls to MP4 when HLS is not allowed, missing, unsupported, or switched off for the session", () => {
    const video = document.createElement("video");
    video.canPlayType = () => "";
    expect(chooseEngine(SOURCE, { allowHls: false, video })).toBe("mp4");
    expect(chooseEngine({ hls: null }, { allowHls: true, video })).toBe("mp4");
    setMse(false);
    expect(chooseEngine(SOURCE, { allowHls: true, video })).toBe("mp4");
  });
});

describe("MP4 engine", () => {
  it("attaches the MP4 only on load(), with a conservative preload", () => {
    const video = document.createElement("video");
    const engine = createVideoEngine(video, SOURCE, { surface: "story" });
    expect(video.getAttribute("src")).toBeNull();
    engine.load();
    expect(engine.engine).toBe("mp4");
    expect(video.src).toBe(SOURCE.mp4);
    expect(video.preload).toBe("metadata");
    engine.dispose();
  });

  it("adopts an MP4 the owner already rendered, without restarting its fetch", async () => {
    const video = document.createElement("video");
    video.setAttribute("src", SOURCE.mp4);
    const media = controlMedia(video);
    const engine = createVideoEngine(video, SOURCE, {
      surface: "story",
      preload: "auto",
    });
    engine.load();
    expect(engine.engine).toBe("mp4");
    expect(media.state().loadCalls ?? 0).toBe(0);
    // Nothing to wait for: play() runs synchronously against the element.
    const outcome = engine.play();
    await media.resolvePlay();
    await expect(outcome).resolves.toBe("playing");
    engine.dispose();
    expect(video.getAttribute("src")).toBeNull();
  });

  it("retries a refused audible autoplay muted, and reports a refused muted one", async () => {
    const video = document.createElement("video");
    const media = controlMedia(video);
    const engine = createVideoEngine(video, SOURCE, { surface: "post-detail" });
    engine.load();

    video.muted = false;
    const first = engine.play();
    await media.rejectPlay("NotAllowedError");
    expect(video.muted).toBe(true);
    await media.resolvePlay();
    await expect(first).resolves.toBe("playing");

    const second = engine.play();
    await media.rejectPlay("NotAllowedError");
    await expect(second).resolves.toBe("autoplay-denied");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        failure: "autoplay-denied",
        fatal: false,
      }),
    );
    engine.dispose();
  });

  it("keeps unexplained play aborts actionable and suppresses disposal aborts", async () => {
    const video = document.createElement("video");
    const media = controlMedia(video);
    const onFatal = jest.fn();
    const engine = createVideoEngine(video, SOURCE, {
      surface: "pdp",
      onFatal,
    });
    engine.load();
    const unexpected = engine.play();
    await media.rejectPlay("AbortError");
    await expect(unexpected).resolves.toBe("failed");
    expect(onFatal).toHaveBeenCalledTimes(1);
    engine.dispose();
    const next = createVideoEngine(video, SOURCE, { surface: "pdp", onFatal });
    next.load();
    const cancelled = next.play();
    next.dispose();
    await media.rejectPlay("AbortError");
    await expect(cancelled).resolves.toBe("aborted");
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("retries one network error at the same position, then gives up with a network failure", () => {
    const video = document.createElement("video");
    const media = controlMedia(video);
    const onFatal = jest.fn();
    const engine = createVideoEngine(video, SOURCE, {
      surface: "pdp",
      onFatal,
    });
    engine.load();
    media.set({ currentTime: 4.2 });
    media.fail(2);
    expect(onFatal).not.toHaveBeenCalled();
    expect(media.state().loadCalls).toBe(2);
    media.fail(2);
    expect(onFatal).toHaveBeenCalledWith("network", "media error 2");
    engine.dispose();
  });

  it("treats unexplained element aborts as actionable", () => {
    const video = document.createElement("video");
    const media = controlMedia(video);
    const onFatal = jest.fn();
    const engine = createVideoEngine(video, SOURCE, {
      surface: "pdp",
      onFatal,
    });
    engine.load();
    media.fail(1);
    expect(onFatal).toHaveBeenCalledWith(
      "unknown",
      "media abort without cancellation context",
    );
    engine.dispose();
    media.fail(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("detects a video that plays audio but decodes no frames (Chromium without HEVC)", () => {
    jest.useFakeTimers();
    const video = document.createElement("video");
    const media = controlMedia(video);
    const onFatal = jest.fn();
    const engine = createVideoEngine(video, SOURCE, {
      surface: "story",
      onFatal,
    });
    engine.load();
    media.set({
      readyState: 4,
      currentTime: 1.5,
      videoWidth: 0,
      videoHeight: 0,
      totalVideoFrames: 0,
    });
    media.emit("playing");
    jest.advanceTimersByTime(600);
    expect(onFatal).not.toHaveBeenCalled();
    jest.advanceTimersByTime(600);
    expect(onFatal).toHaveBeenCalledWith(
      "decode-unsupported",
      "no decoded frames",
    );
    engine.dispose();
  });

  it("does not mistake a stall for undecodable media", () => {
    jest.useFakeTimers();
    const video = document.createElement("video");
    const media = controlMedia(video);
    const onFatal = jest.fn();
    const engine = createVideoEngine(video, SOURCE, {
      surface: "story",
      onFatal,
    });
    engine.load();
    media.set({ readyState: 2, currentTime: 0, videoWidth: 0 });
    media.emit("playing");
    jest.advanceTimersByTime(5_000);
    expect(onFatal).not.toHaveBeenCalled();
    engine.dispose();
  });
});

describe("first frame", () => {
  it("fires on requestVideoFrameCallback, i.e. an actually presented frame", () => {
    const video = document.createElement("video") as any;
    let callback: (() => void) | null = null;
    video.requestVideoFrameCallback = (fn: () => void) => {
      callback = fn;
      return 1;
    };
    video.cancelVideoFrameCallback = jest.fn();
    const onFirstFrame = jest.fn();
    const engine = createVideoEngine(video, SOURCE, {
      surface: "story",
      onFirstFrame,
    });
    engine.load();
    expect(onFirstFrame).not.toHaveBeenCalled();
    callback!();
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(engine.hasFirstFrame).toBe(true);
    engine.dispose();
  });

  it("falls back to playing + moving time where the callback API is missing", () => {
    const video = document.createElement("video");
    const media = controlMedia(video);
    const onFirstFrame = jest.fn();
    const engine = createVideoEngine(video, SOURCE, {
      surface: "story",
      onFirstFrame,
    });
    engine.load();
    media.set({ readyState: 3, currentTime: 0 });
    media.emit("playing");
    expect(onFirstFrame).not.toHaveBeenCalled();
    media.set({ currentTime: 0.04 });
    media.emit("timeupdate");
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    engine.dispose();
  });
});

describe("hls.js engine", () => {
  async function hlsEngine(
    extra: Parameters<typeof createVideoEngine>[2] = { surface: "post-detail" },
  ) {
    const video = document.createElement("video");
    const engine = createVideoEngine(video, SOURCE, {
      allowHls: true,
      ...extra,
    });
    engine.load();
    await flush();
    return { video, engine, hls: FakeHls.instances.at(-1)! };
  }

  it("loads hls.js lazily with the short-form config and the remembered bandwidth", async () => {
    window.sessionStorage.setItem("infinity.video.bw", "3200000");
    resetBandwidthEstimate();
    window.sessionStorage.setItem("infinity.video.bw", "3200000");
    const { hls, engine } = await hlsEngine();
    expect(engine.engine).toBe("hls.js");
    expect(hls.source).toBe(SOURCE.hls);
    expect(hls.config).toEqual(
      expect.objectContaining({
        capLevelToPlayerSize: true,
        maxBufferLength: 8,
        backBufferLength: 4,
        startLevel: -1,
        abrEwmaDefaultEstimate: 3_200_000,
        enableWorker: false,
      }),
    );
    engine.dispose();
  });

  it("holds a play() issued before hls.js has attached, instead of letting `src` abort it", async () => {
    const video = document.createElement("video");
    const media = controlMedia(video);
    const engine = createVideoEngine(video, SOURCE, {
      surface: "post-detail",
      allowHls: true,
    });
    engine.load();
    const outcome = engine.play();
    // hls.js is still loading: calling video.play() now would be aborted by its src swap.
    expect(media.playCalls()).toBe(0);
    await flush();
    expect(media.playCalls()).toBe(1);
    await media.resolvePlay();
    await expect(outcome).resolves.toBe("playing");
    engine.dispose();
  });

  it("a playlist that cannot be fetched never touches MediaSource: straight to MP4, HLS off for the session", async () => {
    playlistResponse = async () => {
      throw new TypeError("Failed to fetch");
    };
    const video = document.createElement("video");
    const engine = createVideoEngine(video, SOURCE, {
      surface: "pdp",
      allowHls: true,
    });
    engine.load();
    await flush();
    expect(FakeHls.instances).toHaveLength(0);
    expect(engine.engine).toBe("mp4");
    expect(video.src).toBe(SOURCE.mp4);
    expect(isHlsCircuitOpen()).toBe(true);
    engine.dispose();
  });

  it("a missing playlist falls back before hls.js exists and leaves HLS on for other videos", async () => {
    playlistResponse = async () => ({ ok: false, status: 404 });
    const video = document.createElement("video");
    const engine = createVideoEngine(video, SOURCE, {
      surface: "pdp",
      allowHls: true,
    });
    engine.load();
    await flush();
    expect(FakeHls.instances).toHaveLength(0);
    expect(engine.engine).toBe("mp4");
    expect(isHlsCircuitOpen()).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        failure: "hls-fallback",
        detail: "manifest 404",
      }),
    );
    engine.dispose();
  });

  it("an unreachable playlist (CORS/offline) falls back to MP4 and stops trying HLS this session", async () => {
    const onEngineChange = jest.fn();
    const { hls, video, engine } = await hlsEngine({
      surface: "pdp",
      onEngineChange,
    });
    hls.fatal(FakeHls.ErrorTypes.NETWORK_ERROR, "manifestLoadError", 0);
    expect(hls.destroyed).toBe(true);
    expect(video.src).toBe(SOURCE.mp4);
    expect(engine.engine).toBe("mp4");
    expect(onEngineChange).toHaveBeenCalledWith("mp4");
    expect(isHlsCircuitOpen()).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        failure: "hls-fallback",
        detail: "manifest 0",
        fatal: false,
      }),
    );
    expect(chooseEngine(SOURCE, { allowHls: true })).toBe("mp4");
    engine.dispose();
  });

  it("a 404 playlist falls back for this video only", async () => {
    const { hls, engine } = await hlsEngine();
    hls.fatal(FakeHls.ErrorTypes.NETWORK_ERROR, "manifestLoadError", 404);
    expect(engine.engine).toBe("mp4");
    expect(isHlsCircuitOpen()).toBe(false);
    engine.dispose();
  });

  it("restarts loading once on a fatal segment error, then falls back at the current position", async () => {
    const { hls, video, engine } = await hlsEngine();
    const media = controlMedia(video);
    media.set({ currentTime: 6 });
    hls.fatal(FakeHls.ErrorTypes.NETWORK_ERROR, "fragLoadError", 503);
    expect(hls.startLoadCalls).toBe(1);
    expect(engine.engine).toBe("hls.js");
    hls.fatal(FakeHls.ErrorTypes.NETWORK_ERROR, "fragLoadError", 503);
    expect(engine.engine).toBe("mp4");
    media.emit("loadedmetadata");
    expect(video.currentTime).toBe(6);
    engine.dispose();
  });

  it("recovers one media error, and falls back when a second follows within 5 s", async () => {
    const { hls, engine } = await hlsEngine();
    hls.fatal(FakeHls.ErrorTypes.MEDIA_ERROR, "bufferAppendError");
    expect(hls.recoverCalls).toBe(1);
    expect(engine.engine).toBe("hls.js");
    hls.fatal(FakeHls.ErrorTypes.MEDIA_ERROR, "bufferAppendError");
    expect(engine.engine).toBe("mp4");
    engine.dispose();
  });

  it("resumes on the MP4 when playback was wanted before the fallback", async () => {
    const { hls, video, engine } = await hlsEngine();
    const media = controlMedia(video);
    engine.markPlayRequested();
    const before = media.playCalls();
    hls.fatal(FakeHls.ErrorTypes.NETWORK_ERROR, "manifestLoadError", 0);
    media.emit("canplay");
    expect(media.playCalls()).toBe(before + 1);
    engine.dispose();
  });

  it("caps the first level to the player's size before hls.js starts loading", async () => {
    const { hls, video, engine } = await hlsEngine({ surface: "post-detail" });
    expect(hls.config.autoStartLoad).toBe(false);
    expect(hls.startLoadCalls).toBe(0);
    video.getBoundingClientRect = () =>
      ({ width: 270, height: 480 }) as DOMRect;
    hls.emit(FakeHls.Events.MANIFEST_PARSED, {});
    // 270x480 CSS px at devicePixelRatio 1 fits the 360x640 rung.
    expect(hls.autoLevelCapping).toBe(0);
    expect(hls.startLoadCalls).toBe(1);
    engine.dispose();
  });

  it("records the level ladder and bandwidth for the next player", async () => {
    const { hls, engine } = await hlsEngine();
    engine.markPlayRequested();
    hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 1 });
    hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 2 });
    hls.emit(FakeHls.Events.FRAG_LOADED, {});
    engine.dispose();
    expect(window.sessionStorage.getItem("infinity.video.bw")).toBe("2400000");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "summary",
        engine: "hls.js",
        startHeight: 960,
        maxHeight: 1280,
        levelSwitches: 1,
      }),
    );
  });
});

describe("cleanup", () => {
  it("dispose releases everything: listeners, hls.js, the element's resource", async () => {
    const video = document.createElement("video");
    const media = controlMedia(video);
    const added = jest.spyOn(video, "addEventListener");
    const removed = jest.spyOn(video, "removeEventListener");
    const engine = createVideoEngine(video, SOURCE, {
      surface: "pdp",
      allowHls: true,
    });
    engine.load();
    await flush();
    const hls = FakeHls.instances.at(-1)!;
    engine.dispose();

    const persistent = added.mock.calls.filter(
      ([, , opts]) => !(opts as AddEventListenerOptions | undefined)?.once,
    );
    expect(removed.mock.calls.length).toBeGreaterThanOrEqual(persistent.length);
    expect(hls.destroyed).toBe(true);
    expect(video.getAttribute("src")).toBeNull();
    expect(media.state().paused).toBe(true);
    expect(liveEngineCounts()).toEqual({ engines: 0, hls: 0 });
  });

  it("rapid activate/deactivate never leaks engines or hls.js instances", async () => {
    const video = document.createElement("video");
    for (let index = 0; index < 50; index += 1) {
      const engine = createVideoEngine(video, SOURCE, {
        surface: "post-detail",
        allowHls: true,
      });
      engine.load();
      // Half are torn down before hls.js has even finished loading.
      if (index % 2) await flush();
      engine.dispose();
    }
    await flush();
    expect(liveEngineCounts()).toEqual({ engines: 0, hls: 0 });
    expect(FakeHls.instances.every((instance) => instance.destroyed)).toBe(
      true,
    );
  });

  it("emits a summary only for views that were actually played", () => {
    const video = document.createElement("video");
    const warmedOnly = createVideoEngine(video, SOURCE, { surface: "story" });
    warmedOnly.load();
    warmedOnly.dispose();
    expect(events.filter((event) => event.type === "summary")).toHaveLength(0);

    const played = createVideoEngine(video, SOURCE, { surface: "story" });
    played.load();
    played.markPlayRequested();
    played.dispose();
    expect(events.filter((event) => event.type === "summary")).toEqual([
      expect.objectContaining({
        surface: "story",
        engine: "mp4",
        startupMs: null,
        host: "cdn.test",
      }),
    ]);
  });
});

describe("bounded WebM fallback", () => {
  const source = {
    ...SOURCE,
    webm: "https://cdn.test/uploads/clip_v1-01020304.webm",
    hasAudio: false,
  };
  it("selects WebM initially only when MP4 capability is absent", () => {
    const video = document.createElement("video");
    video.canPlayType = (type) => (type.includes("webm") ? "probably" : "");
    const engine = createVideoEngine(video, source, { surface: "pdp" });
    engine.load();
    expect(engine.engine).toBe("webm");
    expect(video.getAttribute("src")).toBe(source.webm);
    engine.dispose();
  });
  it("tries WebM once after decode failure, preserves controls and position, then reports one exhausted failure", () => {
    const video = document.createElement("video");
    video.canPlayType = () => "probably";
    const media = controlMedia(video),
      onFatal = jest.fn();
    video.muted = true;
    video.volume = 0.4;
    const engine = createVideoEngine(video, source, {
      surface: "story",
      onFatal,
    });
    engine.load();
    media.set({ currentTime: 2 });
    media.fail(3);
    expect(engine.engine).toBe("webm");
    expect(onFatal).not.toHaveBeenCalled();
    expect(engine.diagnostics).toMatchObject({
      path: "/uploads/clip_v1-01020304.webm",
      attemptedEngines: ["mp4", "webm"],
    });
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0.4);
    media.emit("loadedmetadata");
    expect(video.currentTime).toBe(2);
    media.fail(4);
    media.fail(4);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === "error" && event.fatal),
    ).toHaveLength(1);
    engine.dispose();
    expect(liveEngineCounts()).toEqual({ engines: 0, hls: 0 });
  });
  it("never switches formats for network errors or unsupported WebM", () => {
    const video = document.createElement("video");
    video.canPlayType = () => "probably";
    const media = controlMedia(video),
      onFatal = jest.fn();
    const engine = createVideoEngine(video, source, {
      surface: "pdp",
      onFatal,
    });
    engine.load();
    media.fail(2);
    media.fail(2);
    expect(engine.engine).toBe("mp4");
    expect(onFatal).toHaveBeenCalledTimes(1);
    engine.dispose();
    const next = document.createElement("video");
    next.canPlayType = (type) => (type.includes("webm") ? "" : "probably");
    const unsupported = createVideoEngine(next, source, {
      surface: "pdp",
      onFatal,
    });
    unsupported.load();
    controlMedia(next).fail(3);
    expect(unsupported.engine).toBe("mp4");
    unsupported.dispose();
  });
  it("recovers NotSupportedError without escalating before the fallback is tried", async () => {
    const video = document.createElement("video");
    video.canPlayType = () => "probably";
    const media = controlMedia(video),
      onFatal = jest.fn();
    const engine = createVideoEngine(video, source, {
      surface: "pdp",
      onFatal,
    });
    engine.load();
    const play = engine.play();
    await media.rejectPlay("NotSupportedError");
    await play;
    expect(engine.engine).toBe("webm");
    expect(onFatal).not.toHaveBeenCalled();
    engine.dispose();
  });
  it("reports unsupported WebM even when only the resumed play promise rejects", async () => {
    const video = document.createElement("video");
    video.canPlayType = () => "probably";
    const media = controlMedia(video),
      onFatal = jest.fn();
    const engine = createVideoEngine(video, source, {
      surface: "pdp",
      onFatal,
    });
    engine.load();
    const play = engine.play();
    await media.resolvePlay();
    await play;
    media.fail(3);
    media.emit("canplay");
    await media.rejectPlay("NotSupportedError");
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(engine.engine).toBe("webm");
    engine.dispose();
  });
});
