import type { VideoEngineState } from "../../../packages/video-player/src/react/useVideoEngine";
import type { VideoSource } from "../../../packages/video-player/src/delivery";
import type { VideoTelemetryEvent } from "../../../packages/video-player/src/telemetry";

export interface PlayerSpec {
  id: string;
  source: VideoSource;
  active: boolean;
  playing: boolean;
  allowHls: boolean;
}

declare global {
  interface Window {
    __storyViews: number[];
    __storyItemViews: string[];
    __videoEvents: VideoTelemetryEvent[];
    __videoStates: Record<string, VideoEngineState>;
    __liveEngines: () => { engines: number; hls: number };
    __setPlayer: (id: string, patch: Partial<PlayerSpec>) => void;
  }
}
