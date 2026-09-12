/**
 * jsdom ships no media pipeline: `play`/`pause`/`load` throw "not implemented", and
 * `readyState`, `duration`, `videoWidth` and friends are read-only zeros. That makes the
 * interesting cases — autoplay rejection, buffering, a play() promise settling after the
 * viewer moved on, a video that decodes no frames — untestable as-is.
 *
 * This replaces those members with a controllable fake so a test can drive each of them
 * explicitly, and restores the originals afterwards.
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

interface MediaState {
  readyState: number;
  duration: number;
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
  totalVideoFrames: number;
  paused: boolean;
  error: { code: number } | null;
  playCalls: number;
  pauseCalls: number;
  pending: Deferred[];
}

const states = new WeakMap<HTMLMediaElement, MediaState>();

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing else attaches a handler until the component does; keep Node quiet in the
  // window before that, without swallowing the rejection the component must see.
  promise.catch(() => undefined);
  return { promise, resolve, reject, settled: false };
}

function stateOf(element: HTMLMediaElement): MediaState {
  let state = states.get(element);
  if (!state) {
    state = {
      readyState: 0,
      duration: NaN,
      currentTime: 0,
      videoWidth: 0,
      videoHeight: 0,
      totalVideoFrames: 0,
      paused: true,
      error: null,
      playCalls: 0,
      pauseCalls: 0,
      pending: [],
    };
    states.set(element, state);
  }
  return state;
}

export interface MediaController {
  element(): HTMLVideoElement;
  state(): MediaState;
  /** Number of times play() has been called on the current element. */
  playCalls(): number;
  /** Settles the oldest outstanding play() promise successfully. */
  resolvePlay(): Promise<void>;
  /** Rejects the oldest outstanding play() promise with a DOMException-shaped error. */
  rejectPlay(name: string): Promise<void>;
  /** Applies media properties, then optionally fires events for them. */
  set(props: Partial<Omit<MediaState, "pending" | "playCalls" | "pauseCalls">>): void;
  emit(type: string): void;
  /** Convenience: metadata + data available, mirroring a healthy load. */
  loadTo(readyState: number, props?: Partial<MediaState>): void;
  fail(code: number): void;
}

let originals: {
  play: typeof HTMLMediaElement.prototype.play;
  pause: typeof HTMLMediaElement.prototype.pause;
  load: typeof HTMLMediaElement.prototype.load;
} | null = null;

// `videoWidth`/`videoHeight` live on HTMLVideoElement, not HTMLMediaElement. Defining
// them on the media prototype leaves jsdom's own HTMLVideoElement getters shadowing them,
// so every video reads as 0x0 — i.e. as an undecodable track.
const MEDIA_DESCRIPTORS: Array<keyof MediaState> = [
  "readyState",
  "duration",
  "currentTime",
  "paused",
  "error",
];
const VIDEO_DESCRIPTORS: Array<keyof MediaState> = ["videoWidth", "videoHeight"];

function defineOn(prototype: object, keys: Array<keyof MediaState>): void {
  for (const key of keys) {
    Object.defineProperty(prototype, key, {
      configurable: true,
      get(this: HTMLMediaElement) {
        return stateOf(this)[key];
      },
      set(this: HTMLMediaElement, value: never) {
        stateOf(this)[key] = value;
      },
    });
  }
}

export function installMediaStub(): void {
  if (originals) return;
  originals = {
    play: HTMLMediaElement.prototype.play,
    pause: HTMLMediaElement.prototype.pause,
    load: HTMLMediaElement.prototype.load,
  };

  HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    const state = stateOf(this);
    state.playCalls += 1;
    state.paused = false;
    const pending = deferred();
    state.pending.push(pending);
    return pending.promise;
  };
  HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    const state = stateOf(this);
    state.pauseCalls += 1;
    state.paused = true;
  };
  HTMLMediaElement.prototype.load = function load(this: HTMLMediaElement) {
    // No-op: the component deliberately never calls load() on a mounted element.
  };

  defineOn(HTMLMediaElement.prototype, MEDIA_DESCRIPTORS);
  defineOn(HTMLVideoElement.prototype, VIDEO_DESCRIPTORS);

  Object.defineProperty(HTMLVideoElement.prototype, "getVideoPlaybackQuality", {
    configurable: true,
    writable: true,
    value(this: HTMLVideoElement) {
      return {
        totalVideoFrames: stateOf(this).totalVideoFrames,
        droppedVideoFrames: 0,
        creationTime: 0,
        corruptedVideoFrames: 0,
      };
    },
  });
}

export function uninstallMediaStub(): void {
  if (!originals) return;
  HTMLMediaElement.prototype.play = originals.play;
  HTMLMediaElement.prototype.pause = originals.pause;
  HTMLMediaElement.prototype.load = originals.load;
  for (const key of MEDIA_DESCRIPTORS) {
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[key];
  }
  for (const key of VIDEO_DESCRIPTORS) {
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[key];
  }
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).getVideoPlaybackQuality;
  originals = null;
}

export function controlMedia(element: HTMLVideoElement): MediaController {
  const settle = async (reject: boolean, name?: string) => {
    const state = stateOf(element);
    const pending = state.pending.find((entry) => !entry.settled);
    if (!pending) throw new Error("no outstanding play() promise to settle");
    pending.settled = true;
    if (reject) {
      const error = new Error(name) as Error & { name: string };
      error.name = name ?? "NotAllowedError";
      pending.reject(error);
    } else {
      pending.resolve();
    }
    // Let the component's .catch/.then microtask run before the test continues.
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    element: () => element,
    state: () => stateOf(element),
    playCalls: () => stateOf(element).playCalls,
    resolvePlay: () => settle(false),
    rejectPlay: (name: string) => settle(true, name),
    set(props) {
      Object.assign(stateOf(element), props);
    },
    emit(type: string) {
      element.dispatchEvent(new Event(type));
    },
    loadTo(readyState: number, props?: Partial<MediaState>) {
      Object.assign(stateOf(element), { readyState, ...props });
    },
    fail(code: number) {
      stateOf(element).error = { code };
      element.dispatchEvent(new Event("error"));
    },
  };
}
