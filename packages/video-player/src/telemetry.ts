import type { PlaybackEngine } from "./capabilities";

/**
 * Lightweight first-party playback telemetry. The package only measures; each app decides
 * where events go (`setVideoTelemetrySink`) — the storefront's analytics pipeline, a
 * self-hosted Umami in social. Deliberately collected: timings, counts, the delivery path
 * and coarse client class. Deliberately not: user ids, full user agents, full URLs.
 */

export type VideoFailureKind =
  | "network"
  | "decode-unsupported"
  | "autoplay-denied"
  | "hls-fallback"
  | "webm-fallback"
  | "unknown";

export interface VideoPlaybackSummary {
  type: "summary";
  surface: string;
  engine: PlaybackEngine;
  /** HLS was attempted but playback ended up on the MP4. */
  fellBack: boolean;
  /** Play intent → first presented frame; null when no frame ever showed. */
  startupMs: number | null;
  startupFailed: boolean;
  rebufferCount: number;
  rebufferMs: number;
  watchedMs: number;
  startHeight: number | null;
  maxHeight: number | null;
  levelSwitches: number;
  failure: VideoFailureKind | null;
  browser: string;
  device: "mobile" | "desktop";
  host: string;
}

export interface VideoPlaybackError {
  type: "error";
  surface: string;
  engine: PlaybackEngine;
  failure: VideoFailureKind;
  /** Short machine-readable reason (`manifest 0`, `media error 4`, …). */
  detail: string;
  /** False when the player recovered (e.g. fell back from HLS to MP4). */
  fatal: boolean;
  browser: string;
  device: "mobile" | "desktop";
  host: string;
  path: string;
  attemptedEngines?: PlaybackEngine[];
}

export interface PlaybackDiagnostics {
  engine: PlaybackEngine;
  host: string;
  path: string;
  attemptedEngines: PlaybackEngine[];
}

export type VideoTelemetryEvent = VideoPlaybackSummary | VideoPlaybackError;

let sink: ((event: VideoTelemetryEvent) => void) | null = null;

export function setVideoTelemetrySink(
  next: ((event: VideoTelemetryEvent) => void) | null,
): void {
  sink = next;
}

export function emitVideoTelemetry(event: VideoTelemetryEvent): void {
  try {
    sink?.(event);
  } catch {
    // Telemetry must never affect playback.
  }
}

export function browserFamily(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes("instagram")) return "instagram-webview";
  if (ua.includes("samsungbrowser")) return "samsung";
  if (ua.includes("edg/")) return "edge";
  if (ua.includes("firefox") || ua.includes("fxios")) return "firefox";
  if (ua.includes("crios") || ua.includes("chrome")) return "chrome";
  if (ua.includes("safari")) return "safari";
  return "other";
}

export function deviceClass(): "mobile" | "desktop" {
  try {
    if (window.matchMedia?.("(pointer: coarse)").matches) return "mobile";
  } catch {
    // ignore
  }
  return /mobi|android|iphone|ipad/i.test(
    typeof navigator !== "undefined" ? navigator.userAgent : "",
  )
    ? "mobile"
    : "desktop";
}

export function describeUrl(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(
      url,
      typeof window !== "undefined" ? window.location.href : "http://localhost",
    );
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

const now = () =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** Accumulates one view's timings; `finish()` returns the summary exactly once. */
export class PlaybackSession {
  private requestedAt: number | null = null;
  private firstFrameAt: number | null = null;
  private stallStartedAt: number | null = null;
  private playingSince: number | null = null;
  private rebufferCount = 0;
  private rebufferMs = 0;
  private watchedMs = 0;
  private startHeight: number | null = null;
  private maxHeight: number | null = null;
  private levelSwitches = 0;
  private failure: VideoFailureKind | null = null;
  private fellBack = false;
  private finished = false;
  private attemptedEngines: PlaybackEngine[];

  constructor(
    private readonly surface: string,
    private engine: PlaybackEngine,
    private url: string,
  ) {
    this.attemptedEngines = [engine];
  }

  setEngine(engine: PlaybackEngine, fellBack: boolean, url = this.url): void {
    this.engine = engine;
    this.url = url;
    if (
      this.attemptedEngines[this.attemptedEngines.length - 1] !== engine &&
      this.attemptedEngines.length < 3
    )
      this.attemptedEngines.push(engine);
    this.fellBack ||= fellBack;
  }

  get diagnostics(): PlaybackDiagnostics {
    return {
      engine: this.engine,
      ...describeUrl(this.url),
      attemptedEngines: [...this.attemptedEngines],
    };
  }

  requested(): void {
    this.requestedAt ??= now();
  }

  get playRequested(): boolean {
    return this.requestedAt !== null;
  }

  firstFrame(): void {
    this.firstFrameAt ??= now();
  }

  playing(): void {
    const at = now();
    if (this.stallStartedAt !== null) {
      this.rebufferMs += at - this.stallStartedAt;
      this.stallStartedAt = null;
    }
    this.playingSince ??= at;
  }

  /** Playback stopped for want of data. Only counts once a frame has shown. */
  waiting(): void {
    this.stopWatching();
    if (this.firstFrameAt === null || this.stallStartedAt !== null) return;
    this.stallStartedAt = now();
    this.rebufferCount += 1;
  }

  paused(): void {
    this.stopWatching();
    // A user pause during a stall ends the stall for rebuffer accounting.
    if (this.stallStartedAt !== null) {
      this.rebufferMs += now() - this.stallStartedAt;
      this.stallStartedAt = null;
    }
  }

  level(height: number | undefined | null): void {
    if (!height) return;
    if (this.startHeight === null) this.startHeight = height;
    else this.levelSwitches += 1;
    this.maxHeight = Math.max(this.maxHeight ?? 0, height);
  }

  failed(kind: VideoFailureKind): void {
    this.failure ??= kind;
  }

  private stopWatching(): void {
    if (this.playingSince !== null) {
      this.watchedMs += now() - this.playingSince;
      this.playingSince = null;
    }
  }

  finish(): VideoPlaybackSummary | null {
    if (this.finished || this.requestedAt === null) return null;
    this.finished = true;
    this.paused();
    const startupMs =
      this.firstFrameAt !== null
        ? Math.max(0, Math.round(this.firstFrameAt - this.requestedAt))
        : null;
    return {
      type: "summary",
      surface: this.surface,
      engine: this.engine,
      fellBack: this.fellBack,
      startupMs,
      startupFailed: startupMs === null && this.failure !== null,
      rebufferCount: this.rebufferCount,
      rebufferMs: Math.round(this.rebufferMs),
      watchedMs: Math.round(this.watchedMs),
      startHeight: this.startHeight,
      maxHeight: this.maxHeight,
      levelSwitches: this.levelSwitches,
      failure: this.failure,
      browser: browserFamily(),
      device: deviceClass(),
      host: describeUrl(this.url).host,
    };
  }

  error(
    failure: VideoFailureKind,
    detail: string,
    fatal: boolean,
  ): VideoPlaybackError {
    if (fatal) this.failed(failure);
    const { host, path } = describeUrl(this.url);
    return {
      type: "error",
      surface: this.surface,
      engine: this.engine,
      failure,
      detail,
      fatal,
      browser: browserFamily(),
      device: deviceClass(),
      host,
      path,
      attemptedEngines: [...this.attemptedEngines],
    };
  }
}
