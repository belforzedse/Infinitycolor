import {
  claimLease,
  markQueued,
  readFileRow,
  recordAbandonedFailure,
  releaseLease,
  renewLease,
  rollbackRow,
  writeVideoState,
} from "../../../services/media/video-metadata";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

/**
 * The video pipeline's state lives in `files.provider_metadata.video` and every write is
 * a single raw statement (jsonb_set + lease guard). These run those statements against
 * the real Strapi `files` table so column names/types and jsonb semantics are proven,
 * not assumed.
 */

let strapi: any;
const created: number[] = [];

async function createVideoRow(overrides: Record<string, unknown> = {}): Promise<number> {
  const row = await strapi.db.query("plugin::upload.file").create({
    data: {
      name: "JEST_TEST__IMG_1.MOV",
      hash: "JEST_TEST__IMG_1_abc",
      ext: ".MOV",
      mime: "video/quicktime",
      size: 2048.5,
      url: "/uploads/JEST_TEST__IMG_1_abc.MOV",
      provider: "local",
      ...overrides,
    },
  });
  created.push(row.id);
  return row.id;
}

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterEach(async () => {
  if (created.length) {
    await strapi.db.connection("files").whereIn("id", created.splice(0)).del();
  }
});

afterAll(async () => {
  await teardownStrapi();
});

describe("video metadata SQL on the real files table", () => {
  it("stores provider_metadata as jsonb with a 255-char preview_url column", async () => {
    const { rows } = await strapi.db.connection.raw(
      `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns
        WHERE table_name = 'files' AND column_name IN ('provider_metadata', 'preview_url')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      expect.objectContaining({ column_name: "preview_url", character_maximum_length: 255 }),
      expect.objectContaining({ column_name: "provider_metadata", data_type: "jsonb" }),
    ]);
  });

  it("the upload lifecycle marks a new video row queued, so readers can tell it from a legacy row", async () => {
    const id = await createVideoRow();
    expect((await readFileRow(strapi.db.connection, id))?.video).toEqual(
      expect.objectContaining({ schema: 1, status: "queued" }),
    );
    // Already has processing history: a second mark is a no-op.
    expect(await markQueued(strapi.db.connection, id)).toBe(false);
  });

  it("markQueued writes into a NULL provider_metadata (jsonb_set(NULL) would silently no-op)", async () => {
    // Images never pass through the video hook, so this row really starts NULL.
    const id = await createVideoRow({ mime: "image/webp", ext: ".webp", url: "/uploads/JEST_TEST__still.webp" });
    expect((await readFileRow(strapi.db.connection, id))?.video).toBeNull();
    expect(await markQueued(strapi.db.connection, id)).toBe(true);
    expect((await readFileRow(strapi.db.connection, id))?.video?.status).toBe("queued");
  });

  it("grants the lease to exactly one of two concurrent claimants", async () => {
    const id = await createVideoRow();
    const until = Date.now() + 60_000;
    const [first, second] = await Promise.all([
      claimLease(strapi.db.connection, id, { owner: "worker-a", jobId: "a", until }),
      claimLease(strapi.db.connection, id, { owner: "worker-b", jobId: "b", until }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    // An expired lease can be taken over.
    const holder = first ? "worker-a" : "worker-b";
    await strapi.db.connection.raw(
      `UPDATE files SET provider_metadata = jsonb_set(provider_metadata, '{video,lease,until}', '0'::jsonb) WHERE id = ?`,
      [id],
    );
    expect(await claimLease(strapi.db.connection, id, { owner: "worker-c", jobId: "c", until })).toBe(true);
    expect(await renewLease(strapi.db.connection, id, holder, until)).toBe(false);
    expect(await renewLease(strapi.db.connection, id, "worker-c", until + 1)).toBe(true);
  });

  it("switches the row atomically only while holding the lease, then rolls back", async () => {
    const id = await createVideoRow();
    await claimLease(strapi.db.connection, id, { owner: "w", jobId: "j", until: Date.now() + 60_000 });
    const before = await readFileRow(strapi.db.connection, id);

    const output = {
      token: "v1-0a1b2c3d",
      width: 720,
      height: 1280,
      fps: 30,
      durationMs: 3000,
      hasAudio: true,
      mp4: { url: "/uploads/JEST_TEST__IMG_1_abc_v1-0a1b2c3d.mp4", bytes: 1000 },
      poster: { url: "/uploads/JEST_TEST__IMG_1_abc_v1-0a1b2c3d.jpg", width: 720, height: 1280 },
      hls: null,
    };
    const rowUpdate = {
      url: output.mp4.url,
      name: "JEST_TEST__IMG_1.mp4",
      hash: "JEST_TEST__IMG_1_abc_v1-0a1b2c3d",
      ext: ".mp4",
      mime: "video/mp4",
      size: 0.98,
      width: 720,
      height: 1280,
      previewUrl: output.poster.url,
    };

    // A stranger cannot write.
    expect(await writeVideoState(strapi.db.connection, id, "intruder", { status: "playback_ready" }, rowUpdate)).toBe(false);

    expect(
      await writeVideoState(
        strapi.db.connection,
        id,
        "w",
        {
          status: "playback_ready",
          pipelineVersion: 1,
          output,
          previous: {
            url: before!.url, name: before!.name, hash: before!.hash, ext: before!.ext, mime: before!.mime,
            size: before!.size, previewUrl: before!.previewUrl, width: before!.width, height: before!.height,
          },
        },
        rowUpdate,
      ),
    ).toBe(true);

    const switched = await readFileRow(strapi.db.connection, id);
    expect(switched).toEqual(
      expect.objectContaining({ url: output.mp4.url, mime: "video/mp4", previewUrl: output.poster.url, width: 720 }),
    );
    // Shallow merge kept the lease written earlier.
    expect(switched?.video).toEqual(
      expect.objectContaining({ status: "playback_ready", lease: expect.objectContaining({ owner: "w" }) }),
    );

    // The Strapi API sees the same row: this is what every populate returns.
    const viaApi = await strapi.db.query("plugin::upload.file").findOne({ where: { id } });
    expect(viaApi.provider_metadata.video.output.mp4.url).toBe(output.mp4.url);
    expect(viaApi.previewUrl).toBe(output.poster.url);

    await releaseLease(strapi.db.connection, id, "w");
    expect((await readFileRow(strapi.db.connection, id))?.video?.lease).toBeNull();

    expect(await rollbackRow(strapi.db.connection, (await readFileRow(strapi.db.connection, id))!)).toBe(true);
    const restored = await readFileRow(strapi.db.connection, id);
    expect(restored).toEqual(expect.objectContaining({ url: before!.url, mime: "video/quicktime", previewUrl: null }));
    expect(restored?.video?.status).toBe("rolled_back");
  });

  it("refuses a length that would overflow the varchar(255) url column", async () => {
    const id = await createVideoRow();
    await claimLease(strapi.db.connection, id, { owner: "w", jobId: "j", until: Date.now() + 60_000 });
    await expect(
      writeVideoState(strapi.db.connection, id, "w", { status: "playback_ready" }, {
        url: `/uploads/${"x".repeat(260)}.mp4`, name: "n", hash: "h", ext: ".mp4", mime: "video/mp4",
        size: 1, width: 2, height: 2, previewUrl: null,
      }),
    ).rejects.toThrow(/255-character/);
  });

  it("records a stalled job's failure only when no live lease belongs to another job", async () => {
    const id = await createVideoRow();
    await claimLease(strapi.db.connection, id, { owner: "live", jobId: "other-job", until: Date.now() + 60_000 });
    const failure = {
      stage: "worker" as const,
      code: "stalled" as const,
      message: "the worker stopped while processing this video",
      attempt: 3,
      at: new Date().toISOString(),
      sourceUrl: null,
    };
    expect(await recordAbandonedFailure(strapi.db.connection, id, failure, "stalled-job")).toBe(false);
    expect(await recordAbandonedFailure(strapi.db.connection, id, failure, "other-job")).toBe(true);
    expect((await readFileRow(strapi.db.connection, id))?.video).toEqual(
      expect.objectContaining({ status: "failed", lease: null, failure: expect.objectContaining({ code: "stalled" }) }),
    );
  });
});
