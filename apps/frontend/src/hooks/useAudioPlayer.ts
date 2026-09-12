import { useCallback, useEffect, useRef, useState } from "react";

interface UseAudioPlayerProps {
  audioSrc: string;
  onPlay?: () => void;
}

interface UseAudioPlayerReturn {
  playing: boolean;
  currentTime: number;
  audioDuration: number;
  error: string | null;
  handlePlay: () => Promise<void>;
  seekTo: (time: number) => void;
  getProgress: () => number;
  formatTime: (time: number) => string;
}

const AUDIO_ERROR_MESSAGE = "پخش فایل صوتی در دسترس نیست.";

export const useAudioPlayer = ({ audioSrc, onPlay }: UseAudioPlayerProps): UseAudioPlayerReturn => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [trackedAudioSrc, setTrackedAudioSrc] = useState(audioSrc);

  if (trackedAudioSrc !== audioSrc) {
    setTrackedAudioSrc(audioSrc);
    setPlaying(false);
    setCurrentTime(0);
    setAudioDuration(0);
    setError(null);
  }

  const formatTime = useCallback((timeInSeconds: number): string => {
    const safeTime = Number.isFinite(timeInSeconds) ? Math.max(0, timeInSeconds) : 0;
    const minutes = Math.floor(safeTime / 60);
    const seconds = Math.floor(safeTime % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }, []);

  const handlePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    try {
      if (audio.paused) {
        await audio.play();
        onPlay?.();
      } else {
        audio.pause();
      }
    } catch {
      setError(AUDIO_ERROR_MESSAGE);
      setPlaying(false);
    }
  }, [onPlay]);

  const seekTo = useCallback(
    (time: number) => {
      const audio = audioRef.current;
      if (!audio || !audioDuration || !Number.isFinite(time)) return;

      const nextTime = Math.min(Math.max(time, 0), audioDuration);
      audio.currentTime = nextTime;
      setCurrentTime(nextTime);
    },
    [audioDuration],
  );

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;
    audio.preload = "metadata";
    audio.src = audioSrc;

    const handleLoadedMetadata = () => {
      const duration = Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0;
      setAudioDuration(duration);
      setError(null);
    };
    const handleTimeUpdate = () => setCurrentTime(audio.currentTime);
    const handleEnded = () => {
      setPlaying(false);
      audio.currentTime = 0;
      setCurrentTime(0);
    };
    const handleError = () => {
      setError(AUDIO_ERROR_MESSAGE);
      setPlaying(false);
    };
    const handlePlaying = () => setPlaying(true);
    const handlePause = () => setPlaying(false);

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("durationchange", handleLoadedMetadata);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);
    audio.addEventListener("play", handlePlaying);
    audio.addEventListener("pause", handlePause);

    return () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("durationchange", handleLoadedMetadata);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
      audio.removeEventListener("play", handlePlaying);
      audio.removeEventListener("pause", handlePause);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [audioSrc]);

  const getProgress = useCallback(() => {
    if (!audioDuration) return 0;
    return (currentTime / audioDuration) * 100;
  }, [audioDuration, currentTime]);

  return {
    playing,
    currentTime,
    audioDuration,
    error,
    handlePlay,
    seekTo,
    getProgress,
    formatTime,
  };
};
