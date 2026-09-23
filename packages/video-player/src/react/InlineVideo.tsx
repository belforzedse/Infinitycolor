"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type ReactNode } from "react";
import type { VideoSource } from "../delivery";
import { useVideoEngine, type VideoEngineState } from "./useVideoEngine";

export interface InlineVideoControls {
  play: () => Promise<unknown>;
  pause: () => void;
  retry: () => void;
  video: HTMLVideoElement | null;
}

export interface InlineVideoProps {
  source: VideoSource | null;
  /** Attach the source (engine alive). Inactive renders the poster only. */
  active: boolean;
  playing: boolean;
  muted: boolean;
  loop?: boolean;
  controls?: boolean;
  surface: string;
  allowHls?: boolean;
  preload?: "none" | "metadata" | "auto";
  objectFit?: "cover" | "contain";
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  /** Keep the poster over the element until a real frame is presented (default true). */
  posterUntilFirstFrame?: boolean;
  onEnded?: () => void;
  onStateChange?: (state: VideoEngineState) => void;
  /** Surface-specific UI drawn above the video (sound toggle, error copy, tap-to-play). */
  children?: (state: VideoEngineState, controls: InlineVideoControls) => ReactNode;
}

const fill: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%" };

/**
 * A `<video>` bound to the playback engine, with the poster layered *above* it until the
 * first decoded frame. Layering (rather than hiding the video with opacity) matters: some
 * engines do not present frames for a fully transparent element, and a presented frame is
 * exactly the signal the poster waits for.
 */
export const InlineVideo = forwardRef<InlineVideoControls, InlineVideoProps>(function InlineVideo(
  {
    source,
    active,
    playing,
    muted,
    loop,
    controls,
    surface,
    allowHls,
    preload,
    objectFit = "cover",
    className,
    style,
    ariaLabel,
    posterUntilFirstFrame = true,
    onEnded,
    onStateChange,
    children,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { state, play, pause, retry } = useVideoEngine(videoRef, source, {
    active,
    playing,
    muted,
    loop,
    surface,
    allowHls,
    preload,
    onEnded,
  });

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  const controlsApi: InlineVideoControls = { play, pause, retry, video: videoRef.current };
  useImperativeHandle(ref, () => ({ play, pause, retry, video: videoRef.current }), [play, pause, retry]);

  const poster = source?.poster ?? undefined;
  const showPoster = Boolean(poster) && posterUntilFirstFrame && !state.hasFirstFrame;

  return (
    <div className={className} style={{ position: "relative", overflow: "hidden", ...style }} data-video-phase={state.phase}>
      <video
        ref={videoRef}
        style={{ ...fill, objectFit, background: "#000" }}
        playsInline
        muted={muted}
        loop={loop}
        controls={controls}
        preload="none"
        aria-label={ariaLabel}
        disablePictureInPicture
        controlsList="nodownload noplaybackrate noremoteplayback"
      />
      {poster ? (
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          style={{
            ...fill,
            objectFit,
            pointerEvents: "none",
            opacity: showPoster ? 1 : 0,
            transition: "opacity 120ms linear",
          }}
        />
      ) : null}
      {children?.(state, controlsApi)}
    </div>
  );
});
