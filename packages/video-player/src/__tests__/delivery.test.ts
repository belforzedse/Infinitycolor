import { readVideoDelivery, resolveVideoSource } from "../delivery";
import { parseMasterVariants, pickWarmVariant } from "../warm";

const processedRow = {
  url: "/uploads/IMG_1_abc_v1-0a1b2c3d.mp4",
  mime: "video/mp4",
  previewUrl: "/uploads/IMG_1_abc_v1-0a1b2c3d.jpg",
  width: 720,
  height: 1280,
  provider_metadata: {
    video: {
      schema: 1,
      status: "streaming_ready",
      output: {
        token: "v1-0a1b2c3d",
        width: 720,
        height: 1280,
        durationMs: 10_267,
        hasAudio: false,
        mp4: { url: "/uploads/IMG_1_abc_v1-0a1b2c3d.mp4", bytes: 1 },
        poster: { url: "/uploads/IMG_1_abc_v1-0a1b2c3d.jpg" },
        hls: { master: "/uploads/video/5/v1-11111111/master.m3u8" },
      },
    },
  },
};

describe("readVideoDelivery", () => {
  it("exposes HLS, poster and dimensions for a processed row", () => {
    expect(readVideoDelivery(processedRow)).toEqual({
      mp4: processedRow.url,
      hls: "/uploads/video/5/v1-11111111/master.m3u8",
      webm: null,
      poster: processedRow.previewUrl,
      width: 720,
      height: 1280,
      durationMs: 10_267,
      hasAudio: false,
      processing: false,
    });
  });

  it("plays a legacy row exactly as before", () => {
    expect(readVideoDelivery({ url: "/uploads/story_web.mp4", mime: "video/mp4" })).toEqual(
      expect.objectContaining({ mp4: "/uploads/story_web.mp4", hls: null, poster: null, processing: false }),
    );
  });

  it("distrusts stale metadata after an admin replaced the file", () => {
    const replaced = { ...processedRow, url: "/uploads/new_clip.mov", previewUrl: null };
    expect(readVideoDelivery(replaced)).toEqual(
      expect.objectContaining({ mp4: "/uploads/new_clip.mov", hls: null, poster: null, hasAudio: null }),
    );
  });

  it("flags an upload the worker has not finished", () => {
    const fresh = {
      url: "/uploads/IMG_2.MOV",
      mime: "video/quicktime",
      provider_metadata: { video: { schema: 1, status: "processing" } },
    };
    expect(readVideoDelivery(fresh)?.processing).toBe(true);
  });

  it("ignores paths that are not media paths", () => {
    const hostile = {
      ...processedRow,
      previewUrl: "javascript:alert(1)",
      provider_metadata: {
        video: { ...processedRow.provider_metadata.video, output: { ...processedRow.provider_metadata.video.output, hls: { master: "/uploads/../../etc" }, poster: { url: "data:x" } } },
      },
    };
    expect(readVideoDelivery(hostile)).toEqual(expect.objectContaining({ hls: null, poster: null }));
  });

  it("resolves every path through the app's resolver, dropping ones it rejects", () => {
    const source = resolveVideoSource(readVideoDelivery(processedRow), (path) =>
      path.includes("/video/") ? "" : `https://cdn.infinitycolor.co${path}`,
    );
    expect(source).toEqual(
      expect.objectContaining({ mp4: `https://cdn.infinitycolor.co${processedRow.url}`, hls: null }),
    );
  });
});

describe("HLS warm variant choice", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=1438906,AVERAGE-BANDWIDTH=1391745,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=540x960',
    "r540/index.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=483750,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=360x640',
    "r360/index.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=3006914,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=720x1280',
    "r720/index.m3u8",
  ].join("\n");

  it("parses bandwidth (not AVERAGE-BANDWIDTH) and height per variant", () => {
    expect(parseMasterVariants(master)).toEqual([
      { uri: "r540/index.m3u8", bandwidth: 1438906, height: 960 },
      { uri: "r360/index.m3u8", bandwidth: 483750, height: 640 },
      { uri: "r720/index.m3u8", bandwidth: 3006914, height: 1280 },
    ]);
  });

  it("warms the rendition the estimate and screen allow, else the lowest", () => {
    const variants = parseMasterVariants(master);
    expect(pickWarmVariant(variants, 2_000_000, 2000)?.uri).toBe("r540/index.m3u8");
    expect(pickWarmVariant(variants, 5_000_000, 2000)?.uri).toBe("r720/index.m3u8");
    expect(pickWarmVariant(variants, 5_000_000, 1000)?.uri).toBe("r540/index.m3u8");
    expect(pickWarmVariant(variants, 100_000, 2000)?.uri).toBe("r360/index.m3u8");
  });
});


it("accepts only an owned, supported-profile WebM URL and resolves it", () => {
  const asset = { ...processedRow, provider_metadata: { video: { ...processedRow.provider_metadata.video,
    output: { ...processedRow.provider_metadata.video.output, webm: { url: "/uploads/clip.webm", profileVersion: 1, bytes: 5 } } } } };
  expect(readVideoDelivery(asset)?.webm).toBe("/uploads/clip.webm");
  expect(resolveVideoSource(readVideoDelivery(asset), (path) => `https://cdn.test${path}`)?.webm).toBe("https://cdn.test/uploads/clip.webm");
  expect(readVideoDelivery({ ...asset, url: "/uploads/replaced.mp4" })?.webm).toBeNull();
  asset.provider_metadata.video.output.webm.url = "/uploads/../../private.webm";
  expect(readVideoDelivery(asset)?.webm).toBeNull();
});
