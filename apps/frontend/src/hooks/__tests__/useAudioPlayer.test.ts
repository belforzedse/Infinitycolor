import { act, renderHook } from "@testing-library/react";

import { useAudioPlayer } from "../useAudioPlayer";

class AudioDouble {
  src = "";
  preload = "";
  paused = true;
  duration = 0;
  currentTime = 0;
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener = jest.fn((type: string, listener: EventListener) => {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  });

  removeEventListener = jest.fn((type: string, listener: EventListener) => {
    this.listeners.get(type)?.delete(listener);
  });

  dispatch(type: string) {
    const event = new Event(type);
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  play = jest.fn(async () => {
    this.paused = false;
    this.dispatch("play");
  });

  pause = jest.fn(() => {
    this.paused = true;
    this.dispatch("pause");
  });

  removeAttribute = jest.fn((attribute: string) => {
    if (attribute === "src") this.src = "";
  });

  load = jest.fn();
}

describe("useAudioPlayer", () => {
  const OriginalAudio = global.Audio;
  let audio: AudioDouble;

  beforeEach(() => {
    audio = new AudioDouble();
    Object.defineProperty(global, "Audio", {
      configurable: true,
      writable: true,
      value: jest.fn(() => audio),
    });
  });

  afterAll(() => {
    Object.defineProperty(global, "Audio", {
      configurable: true,
      writable: true,
      value: OriginalAudio,
    });
  });

  it("preloads metadata without autoplay and cleans up the media resource", () => {
    const { unmount } = renderHook(() => useAudioPlayer({ audioSrc: "/guide.mp3" }));

    expect(audio.src).toBe("/guide.mp3");
    expect(audio.preload).toBe("metadata");
    expect(audio.play).not.toHaveBeenCalled();

    unmount();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledTimes(1);
  });

  it("tracks metadata, playback, progress, seeking, and completion", async () => {
    const onPlay = jest.fn();
    const { result } = renderHook(() => useAudioPlayer({ audioSrc: "/guide.mp3", onPlay }));

    act(() => {
      audio.duration = 120;
      audio.dispatch("loadedmetadata");
    });
    expect(result.current.audioDuration).toBe(120);
    expect(result.current.formatTime(125)).toBe("2:05");

    await act(async () => result.current.handlePlay());
    expect(result.current.playing).toBe(true);
    expect(onPlay).toHaveBeenCalledTimes(1);

    act(() => result.current.seekTo(45));
    expect(audio.currentTime).toBe(45);
    expect(result.current.currentTime).toBe(45);
    expect(result.current.getProgress()).toBe(37.5);

    act(() => {
      audio.currentTime = 120;
      audio.dispatch("ended");
    });
    expect(result.current.playing).toBe(false);
    expect(result.current.currentTime).toBe(0);
    expect(audio.currentTime).toBe(0);
  });

  it("clamps seeking and exposes a localized playback failure", async () => {
    const { result } = renderHook(() => useAudioPlayer({ audioSrc: "/guide.mp3" }));
    act(() => {
      audio.duration = 60;
      audio.dispatch("durationchange");
    });

    act(() => result.current.seekTo(90));
    expect(result.current.currentTime).toBe(60);
    act(() => result.current.seekTo(-10));
    expect(result.current.currentTime).toBe(0);

    audio.play.mockRejectedValueOnce(new Error("blocked"));
    await act(async () => result.current.handlePlay());
    expect(result.current.playing).toBe(false);
    expect(result.current.error).toBe("پخش فایل صوتی در دسترس نیست.");
  });
});
