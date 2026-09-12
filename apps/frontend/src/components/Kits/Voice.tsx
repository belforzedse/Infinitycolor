"use client";

import React from "react";

import { useAudioPlayer } from "@/hooks/useAudioPlayer";
import PauseIcon from "./Icons/PauseIcon";
import PlayIcon from "./Icons/PlayIcon";

interface VoiceProps {
  isPlaying?: boolean;
  onPlay?: () => void;
  className?: string;
  audioSrc: string;
  label?: string;
}

const WAVEFORM_BARS = 26;
const KEYBOARD_SEEK_SECONDS = 5;

const Voice: React.FC<VoiceProps> = ({ onPlay, className, audioSrc, label = "فایل صوتی" }) => {
  const {
    playing,
    currentTime,
    error,
    audioDuration,
    handlePlay,
    seekTo,
    getProgress,
    formatTime,
  } = useAudioPlayer({ audioSrc, onPlay });
  const progress = getProgress();
  const ready = audioDuration > 0;

  const handleSeekKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    let nextTime: number | null = null;
    if (event.key === "ArrowRight") nextTime = currentTime + KEYBOARD_SEEK_SECONDS;
    if (event.key === "ArrowLeft") nextTime = currentTime - KEYBOARD_SEEK_SECONDS;
    if (event.key === "Home") nextTime = 0;
    if (event.key === "End") nextTime = audioDuration;
    if (nextTime === null) return;

    event.preventDefault();
    seekTo(nextTime);
  };

  if (error) {
    return (
      <div
        role="status"
        className={`w-full max-w-sm rounded-xl bg-stone-50 px-4 py-3 text-center text-sm text-red-600 ${className || ""}`}
      >
        {error}
      </div>
    );
  }

  const controlLabel = !ready
    ? `در حال بارگذاری ${label}`
    : playing
      ? `توقف ${label}`
      : `پخش ${label}`;

  return (
    <div
      dir="ltr"
      aria-busy={!ready}
      className={`flex min-h-[52px] w-full max-w-sm items-center gap-2 rounded-xl bg-stone-50 px-2 py-1 ${className || ""}`}
    >
      <button
        type="button"
        onClick={() => void handlePlay()}
        aria-label={controlLabel}
        data-aq-motion-sensitive
        disabled={!ready}
        className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-infinity-primary text-white shadow-sm transition-[background-color,box-shadow,transform] duration-150 ease-out hover:bg-infinity-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 active:scale-95 disabled:cursor-wait disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none"
      >
        <span aria-hidden="true">{playing ? <PauseIcon /> : <PlayIcon />}</span>
      </button>

      <div className="relative flex h-11 min-w-0 flex-1 items-center rounded-lg focus-within:ring-2 focus-within:ring-infinity-primary/40">
        <div
          aria-hidden="true"
          data-testid="voice-waveform"
          className="flex w-full items-center justify-between gap-1 px-1"
        >
          {Array.from({ length: WAVEFORM_BARS }).map((_, index) => {
            const active = ((index + 1) / WAVEFORM_BARS) * 100 <= progress;
            return (
              <span
                key={index}
                data-active={active ? "true" : "false"}
                data-aq-motion-sensitive
                className={`w-0.5 shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none ${
                  active ? "bg-infinity-primary" : "bg-slate-300"
                } ${index % 6 === 0 ? "h-6" : index % 3 === 0 ? "h-4" : "h-2"}`}
              />
            );
          })}
        </div>
        <input
          type="range"
          min={0}
          max={ready ? audioDuration : 1}
          step={0.1}
          value={ready ? Math.min(currentTime, audioDuration) : 0}
          disabled={!ready}
          aria-label={`موقعیت پخش ${label}`}
          aria-valuetext={`${formatTime(currentTime)} از ${formatTime(audioDuration)}`}
          onChange={(event) => seekTo(Number(event.currentTarget.value))}
          onKeyDown={handleSeekKeyDown}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
        />
      </div>

      <span className="min-w-10 text-left text-xs tabular-nums text-neutral-500">
        {formatTime(audioDuration)}
      </span>
    </div>
  );
};

export default Voice;
