import type {
  FileRow,
  RowUpdate,
  VideoFailure,
  VideoLease,
  VideoMetadata,
} from "../../video-metadata";

/**
 * In-memory stand-in for the SQL half of video-metadata.ts, with the same semantics the
 * real statements implement (lease compare-and-set, owner-guarded writes, shallow merge).
 * The Postgres statements themselves are covered by the integration spec.
 */
export function createMemoryVideoStore(initial: FileRow[] = []) {
  const rows = new Map<number, FileRow>(initial.map((row) => [row.id, structuredClone(row)]));
  const clone = <T>(value: T): T => structuredClone(value);
  const leaseFree = (row: FileRow, now: number) => !row.video?.lease || row.video.lease.until < now;
  const ensureVideo = (row: FileRow): VideoMetadata =>
    (row.video ??= { schema: 1, status: "queued", updatedAt: new Date(0).toISOString() });

  return {
    rows,
    put(row: FileRow) {
      rows.set(row.id, clone(row));
    },
    get(id: number): FileRow | undefined {
      const row = rows.get(id);
      return row ? clone(row) : undefined;
    },
    async readFileRow(_db: unknown, id: number) {
      const row = rows.get(id);
      return row ? clone(row) : null;
    },
    async markQueued(_db: unknown, id: number) {
      const row = rows.get(id);
      if (!row || row.video) return false;
      row.video = { schema: 1, status: "queued", updatedAt: new Date().toISOString() };
      return true;
    },
    async claimLease(_db: unknown, id: number, lease: VideoLease, now = Date.now()) {
      const row = rows.get(id);
      if (!row) return false;
      if (!leaseFree(row, now) && row.video?.lease?.owner !== lease.owner) return false;
      ensureVideo(row).lease = clone(lease);
      return true;
    },
    async renewLease(_db: unknown, id: number, owner: string, until: number) {
      const row = rows.get(id);
      if (!row?.video?.lease || row.video.lease.owner !== owner) return false;
      row.video.lease.until = until;
      return true;
    },
    async releaseLease(_db: unknown, id: number, owner: string) {
      const row = rows.get(id);
      if (row?.video?.lease?.owner === owner) row.video.lease = null;
    },
    async writeVideoState(
      _db: unknown,
      id: number,
      owner: string,
      patch: Partial<VideoMetadata>,
      update?: RowUpdate,
    ) {
      const row = rows.get(id);
      if (!row?.video?.lease || row.video.lease.owner !== owner) return false;
      row.video = { ...row.video, ...clone(patch) } as VideoMetadata;
      if (update) {
        Object.assign(row, {
          url: update.url,
          name: update.name,
          hash: update.hash,
          ext: update.ext,
          mime: update.mime,
          size: update.size,
          width: update.width,
          height: update.height,
          previewUrl: update.previewUrl,
        });
      }
      return true;
    },
    async recordAbandonedFailure(_db: unknown, id: number, failure: VideoFailure, jobId: string | null, now = Date.now()) {
      const row = rows.get(id);
      if (!row) return false;
      if (!leaseFree(row, now) && row.video?.lease?.jobId !== jobId) return false;
      const video = ensureVideo(row);
      video.failure = clone(failure);
      video.lease = null;
      if (!["playback_ready", "streaming_ready", "rolled_back"].includes(video.status)) video.status = "failed";
      return true;
    },
  };
}

export type MemoryVideoStore = ReturnType<typeof createMemoryVideoStore>;
