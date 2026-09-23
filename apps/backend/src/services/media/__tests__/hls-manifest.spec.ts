import { avcCodecString, buildMasterPlaylist, parseMediaPlaylist } from "../hls-manifest";

describe("hls manifest", () => {
  it("parses the variant playlist ffmpeg writes", () => {
    const playlist = parseMediaPlaylist(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:4",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        '#EXT-X-MAP:URI="init_0.mp4"',
        "#EXTINF:4.000000,",
        "seg_000.m4s",
        "#EXTINF:3.000000,",
        "seg_001.m4s",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );
    expect(playlist).toEqual({
      targetDuration: 4,
      mapUri: "init_0.mp4",
      segments: [
        { uri: "seg_000.m4s", duration: 4 },
        { uri: "seg_001.m4s", duration: 3 },
      ],
      ended: true,
    });
  });

  it("builds RFC 6381 H.264 codec strings from profile and level", () => {
    expect(avcCodecString("High", 31)).toBe("avc1.64001f");
    expect(avcCodecString("High", 40)).toBe("avc1.640028");
    expect(avcCodecString("Main", 30)).toBe("avc1.4d001e");
    expect(avcCodecString("Constrained Baseline", 30)).toBe("avc1.42401e");
  });

  it("writes every attribute players use to pick a rendition", () => {
    const text = buildMasterPlaylist([
      {
        uri: "r540/index.m3u8",
        width: 540,
        height: 960,
        frameRate: 30000 / 1001,
        codecs: "avc1.64001f,mp4a.40.2",
        bandwidth: 1_380_000,
        averageBandwidth: 1_010_000,
        bytes: 1,
        segmentCount: 3,
      },
    ]);
    expect(text).toBe(
      "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n" +
        '#EXT-X-STREAM-INF:BANDWIDTH=1380000,AVERAGE-BANDWIDTH=1010000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=540x960,FRAME-RATE=29.970\n' +
        "r540/index.m3u8\n",
    );
  });
});
