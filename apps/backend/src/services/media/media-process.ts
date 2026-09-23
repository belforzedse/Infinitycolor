import { spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";

/**
 * ffmpeg/ffprobe process handling for the media worker.
 *
 * Every invocation is an argument array handed to `spawn` — never a shell string — so a
 * hostile file name or metadata value cannot become a command. Each child is bounded by
 * a wall-clock timeout, tracked so worker shutdown can stop it, and optionally niced so a
 * transcode yields the CPU to API replicas sharing the host.
 */

export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * Structured failure codes stored on the upload row (`provider_metadata.video.failure.code`)
 * so support can tell a broken upload from a worker problem without reading logs.
 */
export type MediaFailureCode =
  | "ffmpeg_unavailable"
  | "hdr_tonemap_unavailable"
  | "source_missing"
  | "probe_failed"
  | "no_video_stream"
  | "duration_exceeded"
  | "dimensions_exceeded"
  | "decode_failed"
  | "encode_failed"
  | "timeout"
  | "killed_oom"
  | "terminated"
  | "storage_error"
  | "stalled"
  | "unknown";

const RETRYABLE_CODES: ReadonlySet<MediaFailureCode> = new Set<MediaFailureCode>([
  "encode_failed",
  "timeout",
  "killed_oom",
  "terminated",
  "storage_error",
  "stalled",
  "unknown",
]);

export class MediaProcessingError extends Error {
  readonly code: MediaFailureCode;
  /** Diagnostic tail (ffmpeg stderr etc.). Logged, never stored on the public row. */
  readonly detail?: string;

  constructor(code: MediaFailureCode, message: string, detail?: string) {
    super(message);
    this.name = "MediaProcessingError";
    this.code = code;
    this.detail = detail;
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}

export class FfmpegUnavailableError extends MediaProcessingError {
  constructor(binary: string) {
    super(
      "ffmpeg_unavailable",
      `${binary} is not available. The backend image installs it in the runner stage; ` +
        `set FFMPEG_PATH/FFPROBE_PATH when running outside that image.`,
    );
    this.name = "FfmpegUnavailableError";
  }
}

const STORAGE_PATTERN = /No space left on device|Permission denied|Input\/output error|Read-only file system/i;
const DECODE_PATTERN =
  /Invalid data found when processing input|moov atom not found|could not find codec parameters|Error while decoding|Invalid NAL unit|non-existing PPS|decode_slice_header error|Error opening input/i;

export function classifyProcessFailure(input: {
  binary: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  terminating: boolean;
}): MediaProcessingError {
  const tail = input.stderr.slice(-2000);
  const name = input.binary.split("/").pop() || input.binary;
  if (input.timedOut) {
    return new MediaProcessingError("timeout", `${name} exceeded its time limit`, tail);
  }
  if (input.terminating) {
    return new MediaProcessingError("terminated", `${name} stopped for worker shutdown`, tail);
  }
  // A SIGKILL we did not send is almost always the cgroup OOM killer choosing ffmpeg,
  // the biggest process in the container.
  if (input.signal === "SIGKILL") {
    return new MediaProcessingError("killed_oom", `${name} was killed (likely out of memory)`, tail);
  }
  if (input.signal) {
    return new MediaProcessingError("terminated", `${name} exited on ${input.signal}`, tail);
  }
  if (STORAGE_PATTERN.test(tail)) {
    return new MediaProcessingError("storage_error", `${name} could not read or write media files`, tail);
  }
  if (DECODE_PATTERN.test(tail)) {
    return new MediaProcessingError("decode_failed", `${name} could not decode the source`, tail);
  }
  return new MediaProcessingError("encode_failed", `${name} exited with ${input.code}`, tail);
}

const activeChildren = new Set<ChildProcess>();
let terminating = false;

export interface RunMediaProcessOptions {
  timeoutMs?: number;
  /** Run at a lower CPU priority. Used for transcodes, not for quick probes. */
  lowPriority?: boolean;
}

export function runMediaProcess(
  binary: string,
  args: string[],
  { timeoutMs = 15 * 60_000, lowPriority = false }: RunMediaProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (terminating) {
      reject(new MediaProcessingError("terminated", "media worker is shutting down"));
      return;
    }

    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    if (lowPriority && child.pid) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // Not permitted in some sandboxes; priority is an optimisation, not a requirement.
      }
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Bound the wall time: a malformed file can otherwise keep ffmpeg spinning forever
    // and wedge the worker.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      // Keep only the tail; a long encode logs continuously.
      stderr = (stderr + String(chunk)).slice(-64_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new FfmpegUnavailableError(binary));
        return;
      }
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(classifyProcessFailure({ binary, code, signal, stderr, timedOut, terminating }));
    });
  });
}

/**
 * Stops every running ffmpeg/ffprobe child. Called on SIGTERM so a deploy does not leave
 * orphaned encoders writing into the uploads volume; the interrupted job fails as
 * `terminated` and BullMQ retries it on the next worker.
 */
export async function terminateActiveMediaProcesses(graceMs = 3_000): Promise<void> {
  terminating = true;
  const children = [...activeChildren];
  if (children.length === 0) return;
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          const force = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, graceMs);
          child.once("close", () => {
            clearTimeout(force);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
}

export function activeMediaProcessCount(): number {
  return activeChildren.size;
}
