import type { MediaFailureCode } from "./media-process";
import type { HdrTransfer } from "./video-normalization";

/**
 * Processing state for a video upload, stored on its own `plugin::upload.file` row under
 * `provider_metadata.video` (a jsonb column the local upload provider never uses).
 *
 * Keeping it on the row means every existing `populate: { Media: true }` already returns
 * it — stories, products and posts need no serializer changes — and the row's classic
 * fields (`url`, `mime`, …) keep pointing at a playable progressive MP4, which is the
 * interface every existing client understands.
 *
 * All writes are single-statement SQL guarded by the processing lease, so two workers can
 * never interleave a read-modify-write of this JSON or both publish outputs.
 */

export type VideoStatus =
  | "queued"
  | "probing"
  | "processing"
  | "playback_ready"
  | "streaming_ready"
  | "failed"
  | "rolled_back";

export interface RowSnapshot {
  url: string | null;
  name: string | null;
  hash: string | null;
  ext: string | null;
  mime: string | null;
  size: number | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface ProbeSummary {
  container: string;
  videoCodec: string | null;
  videoProfile: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  rotation: number;
  sampleAspectRatio: number;
  frameRate: number | null;
  averageFrameRate: number | null;
  variableFrameRate: boolean;
  pixelFormat: string | null;
  bitDepth: number | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  hdr: HdrTransfer | null;
  dolbyVisionProfile: number | null;
  audioChannels: number | null;
  durationMs: number | null;
  bitRate: number | null;
  fastStart: boolean;
}

export interface HlsOutput {
  token: string;
  master: string;
  segmentSeconds: number;
  bytes: number;
  renditions: Array<{ width: number; height: number; bandwidth: number; averageBandwidth: number; codecs: string }>;
}

export interface VideoOutput {
  token: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number | null;
  hasAudio: boolean;
  mp4: { url: string; bytes: number };
  webm?: { url: string; bytes: number; profileVersion: 1 } | null;
  poster: { url: string; width: number; height: number } | null;
  hls: HlsOutput | null;
}

export interface VideoFailure {
  stage: "probe" | "mp4" | "hls" | "webm" | "publish" | "worker";
  code: MediaFailureCode;
  message: string;
  attempt: number;
  at: string;
  /** The row URL the failure applies to; a replaced file clears it by changing `url`. */
  sourceUrl: string | null;
}

export interface VideoLease {
  owner: string;
  jobId: string | null;
  until: number;
}

export interface VideoMetadata {
  schema: 1;
  status: VideoStatus;
  updatedAt: string;
  pipelineVersion?: number;
  source?: {
    url: string;
    name: string | null;
    hash: string | null;
    ext: string | null;
    mime: string | null;
    size: number | null;
    probe?: ProbeSummary;
  };
  output?: VideoOutput | null;
  previous?: RowSnapshot | null;
  failure?: VideoFailure | null;
  webmFailure?: VideoFailure | null;
  lease?: VideoLease | null;
  timings?: Partial<Record<"probeMs" | "mp4Ms" | "posterMs" | "hlsMs" | "webmMs", number>>;
  warnings?: string[];
}

export interface FileRow {
  id: number;
  name: string | null;
  hash: string | null;
  ext: string | null;
  mime: string | null;
  size: number | null;
  url: string | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  video: VideoMetadata | null;
}

/** The part of Knex this module uses; `strapi.db.connection` in the app. */
export interface SqlClient {
  raw(sql: string, bindings?: readonly unknown[]): Promise<{ rows: any[] }>;
}

const MAX_STRING = 255;

function asNumber(value: unknown): number | null {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : number;
}

function parseJson(value: unknown): Record<string, any> | null {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, any>;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

export async function readFileRow(db: SqlClient, fileId: number): Promise<FileRow | null> {
  const { rows } = await db.raw(
    `SELECT id, name, hash, ext, mime, size, url, preview_url, width, height, provider_metadata
       FROM files WHERE id = ?`,
    [fileId],
  );
  const row = rows[0];
  if (!row) return null;
  const metadata = parseJson(row.provider_metadata);
  const video = metadata?.video && typeof metadata.video === "object" ? (metadata.video as VideoMetadata) : null;
  return {
    id: Number(row.id),
    name: row.name ?? null,
    hash: row.hash ?? null,
    ext: row.ext ?? null,
    mime: row.mime ?? null,
    size: asNumber(row.size),
    url: row.url ?? null,
    previewUrl: row.preview_url ?? null,
    width: asNumber(row.width),
    height: asNumber(row.height),
    video,
  };
}

export function snapshotRow(row: FileRow): RowSnapshot {
  return {
    url: row.url,
    name: row.name,
    hash: row.hash,
    ext: row.ext,
    mime: row.mime,
    size: row.size,
    previewUrl: row.previewUrl,
    width: row.width,
    height: row.height,
  };
}

// `provider_metadata.video`, creating the parent object when the column is NULL:
// jsonb_set(NULL, …) returns NULL, which would silently discard the write.
const VIDEO_BASE = `COALESCE(provider_metadata, '{}'::jsonb)`;
const VIDEO_OBJECT = `COALESCE(provider_metadata -> 'video', '{}'::jsonb)`;
const LEASE_FREE = `(provider_metadata #> '{video,lease}' IS NULL
    OR provider_metadata #> '{video,lease}' = 'null'::jsonb
    OR (provider_metadata #>> '{video,lease,until}')::bigint < ?)`;

/**
 * Marks a freshly uploaded video as queued so readers can tell it apart from a legacy
 * row. Only applies to rows with no processing history.
 */
export async function markQueued(db: SqlClient, fileId: number, now = new Date()): Promise<boolean> {
  const patch = { schema: 1, status: "queued", updatedAt: now.toISOString() };
  const { rows } = await db.raw(
    `UPDATE files
        SET provider_metadata = jsonb_set(${VIDEO_BASE}, '{video}', ?::jsonb, true)
      WHERE id = ? AND (provider_metadata -> 'video') IS NULL
      RETURNING id`,
    [JSON.stringify(patch), fileId],
  );
  return rows.length > 0;
}

/**
 * Compare-and-set claim. Succeeds when nobody holds the lease, it has expired, or the
 * caller already holds it. Returns false when another worker is processing the file.
 */
export async function claimLease(
  db: SqlClient,
  fileId: number,
  lease: VideoLease,
  now = Date.now(),
): Promise<boolean> {
  const { rows } = await db.raw(
    `UPDATE files
        SET provider_metadata = jsonb_set(
              jsonb_set(${VIDEO_BASE}, '{video}', ${VIDEO_OBJECT}, true),
              '{video,lease}', ?::jsonb, true)
      WHERE id = ? AND (${LEASE_FREE} OR provider_metadata #>> '{video,lease,owner}' = ?)
      RETURNING id`,
    [JSON.stringify(lease), fileId, now, lease.owner],
  );
  return rows.length > 0;
}

export async function renewLease(db: SqlClient, fileId: number, owner: string, until: number): Promise<boolean> {
  const { rows } = await db.raw(
    `UPDATE files
        SET provider_metadata = jsonb_set(provider_metadata, '{video,lease,until}', to_jsonb(?::bigint), false)
      WHERE id = ? AND provider_metadata #>> '{video,lease,owner}' = ?
      RETURNING id`,
    [until, fileId, owner],
  );
  return rows.length > 0;
}

export async function releaseLease(db: SqlClient, fileId: number, owner: string): Promise<void> {
  await db.raw(
    `UPDATE files
        SET provider_metadata = jsonb_set(provider_metadata, '{video,lease}', 'null'::jsonb, false)
      WHERE id = ? AND provider_metadata #>> '{video,lease,owner}' = ?`,
    [fileId, owner],
  );
}

export interface RowUpdate {
  url: string;
  name: string;
  hash: string;
  ext: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  previewUrl: string | null;
}

function checkLength(label: string, value: string | null): void {
  if (value && value.length > MAX_STRING) {
    throw new Error(`${label} exceeds the ${MAX_STRING}-character column: ${value.slice(0, 60)}…`);
  }
}

/**
 * Shallow-merges `patch` into `provider_metadata.video` and optionally repoints the row,
 * in one statement, only while `owner` holds the lease. Returns false if the lease was
 * lost (another worker took over after an expiry), in which case nothing was written.
 */
export async function writeVideoState(
  db: SqlClient,
  fileId: number,
  owner: string,
  patch: Partial<VideoMetadata>,
  row?: RowUpdate,
): Promise<boolean> {
  const assignments = [
    `provider_metadata = jsonb_set(${VIDEO_BASE}, '{video}', ${VIDEO_OBJECT} || ?::jsonb, true)`,
    `updated_at = NOW()`,
  ];
  const bindings: unknown[] = [JSON.stringify(patch)];
  if (row) {
    for (const [label, value] of [
      ["url", row.url],
      ["name", row.name],
      ["hash", row.hash],
      ["preview_url", row.previewUrl],
    ] as const) {
      checkLength(label, value);
    }
    assignments.push(
      "url = ?", "name = ?", "hash = ?", "ext = ?", "mime = ?", "size = ?", "width = ?", "height = ?",
      "preview_url = ?",
    );
    bindings.push(
      row.url, row.name, row.hash, row.ext, row.mime, row.size, row.width, row.height, row.previewUrl,
    );
  }
  bindings.push(fileId, owner);
  const { rows } = await db.raw(
    `UPDATE files SET ${assignments.join(", ")}
      WHERE id = ? AND provider_metadata #>> '{video,lease,owner}' = ?
      RETURNING id`,
    bindings,
  );
  return rows.length > 0;
}

/**
 * Records a terminal failure for a job whose worker can no longer do it itself (stalled
 * past BullMQ's limit, or crashed). Only writes when no live lease belongs to someone else.
 */
export async function recordAbandonedFailure(
  db: SqlClient,
  fileId: number,
  failure: VideoFailure,
  jobId: string | null,
  now = Date.now(),
): Promise<boolean> {
  const patch = {
    failure,
    lease: null,
    updatedAt: new Date(now).toISOString(),
  };
  const { rows } = await db.raw(
    `UPDATE files
        SET provider_metadata = jsonb_set(${VIDEO_BASE}, '{video}',
              ${VIDEO_OBJECT} || ?::jsonb
                || CASE WHEN provider_metadata #>> '{video,status}' IN ('playback_ready', 'streaming_ready', 'rolled_back')
                        THEN '{}'::jsonb ELSE '{"status":"failed"}'::jsonb END,
              true)
      WHERE id = ? AND (${LEASE_FREE} OR provider_metadata #>> '{video,lease,jobId}' = ?)
      RETURNING id`,
    [JSON.stringify(patch), fileId, now, jobId ?? ""],
  );
  return rows.length > 0;
}

/**
 * Restores the row to the snapshot taken before the pipeline's first switch. Guarded on
 * the row still pointing at the pipeline's output, so it cannot clobber a newer upload.
 */
export async function rollbackRow(db: SqlClient, row: FileRow, now = new Date()): Promise<boolean> {
  const previous = row.video?.previous;
  const outputUrl = row.video?.output?.mp4.url;
  if (!previous?.url || !outputUrl || row.url !== outputUrl) return false;
  const patch = { status: "rolled_back", updatedAt: now.toISOString(), lease: null };
  const { rows } = await db.raw(
    `UPDATE files
        SET url = ?, name = ?, hash = ?, ext = ?, mime = ?, size = ?, width = ?, height = ?, preview_url = ?,
            provider_metadata = jsonb_set(${VIDEO_BASE}, '{video}', ${VIDEO_OBJECT} || ?::jsonb, true),
            updated_at = NOW()
      WHERE id = ? AND url = ?
      RETURNING id`,
    [
      previous.url, previous.name, previous.hash, previous.ext, previous.mime, previous.size,
      previous.width, previous.height, previous.previewUrl,
      JSON.stringify(patch), row.id, outputUrl,
    ],
  );
  return rows.length > 0;
}
