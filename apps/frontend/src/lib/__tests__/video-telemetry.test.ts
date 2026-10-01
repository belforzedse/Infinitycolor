import * as Sentry from "@sentry/nextjs";
import { ensureVideoTelemetry, reportStoryMediaIssue } from "../video-telemetry";
let sink: (event: any) => void;
jest.mock("@sentry/nextjs", () => ({ logger: { info: jest.fn() }, captureMessage: jest.fn() }));
jest.mock("@repo/video-player", () => ({
  setVideoTelemetrySink: (next: typeof sink) => {
    sink = next;
  },
}));
jest.mock("@/lib/analytics", () => ({ trackVideoPlayback: jest.fn() }));

it("reports a story's exhausted playback once and logs successful fallback", () => {
  ensureVideoTelemetry();
  sink({
    type: "error",
    fatal: true,
    surface: "story",
    engine: "webm",
    failure: "decode-unsupported",
  });
  expect(Sentry.captureMessage).not.toHaveBeenCalled();
  reportStoryMediaIssue({
    mediaType: "video",
    failure: "decode-unsupported",
    storyId: 59,
    mediaErrorCode: 3,
    host: "cdn.test",
    path: "/clip.mp4",
  });
  expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  sink({ type: "error", fatal: false, surface: "story", engine: "webm", failure: "webm-fallback" });
  expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  expect(Sentry.logger.info).toHaveBeenCalledWith(
    "video.recovery",
    expect.objectContaining({ video_engine: "webm" }),
  );
});
