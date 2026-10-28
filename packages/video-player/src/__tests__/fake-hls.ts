/**
 * A stand-in for hls.js with the surface the engine uses. Tests emit hls.js events and
 * errors directly, so fallback and recovery rules are asserted without MSE (jsdom has none).
 */
type Handler = (event: string, data: any) => void;

export class FakeHls {
  static instances: FakeHls[] = [];
  static supported = true;
  static isSupported() {
    return FakeHls.supported;
  }
  static Events = {
    ERROR: "hlsError",
    LEVEL_SWITCHED: "hlsLevelSwitched",
    FRAG_LOADED: "hlsFragLoaded",
    MEDIA_ATTACHED: "hlsMediaAttached",
    MANIFEST_PARSED: "hlsManifestParsed",
  };
  static ErrorTypes = {
    NETWORK_ERROR: "networkError",
    MEDIA_ERROR: "mediaError",
    OTHER_ERROR: "otherError",
  };

  handlers = new Map<string, Handler[]>();
  media: HTMLVideoElement | null = null;
  source: string | null = null;
  destroyed = false;
  startLoadCalls = 0;
  recoverCalls = 0;
  levels = [
    { width: 360, height: 640 },
    { width: 540, height: 960 },
    { width: 720, height: 1280 },
  ];
  bandwidthEstimate = 2_400_000;
  autoLevelCapping = -1;

  constructor(public config: Record<string, unknown>) {
    FakeHls.instances.push(this);
  }

  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  attachMedia(media: HTMLVideoElement) {
    this.media = media;
    this.emit(FakeHls.Events.MEDIA_ATTACHED, { media });
  }
  loadSource(url: string) {
    this.source = url;
  }
  startLoad() {
    this.startLoadCalls += 1;
  }
  recoverMediaError() {
    this.recoverCalls += 1;
  }
  destroy() {
    this.destroyed = true;
    this.handlers.clear();
  }
  emit(event: string, data: any) {
    for (const handler of this.handlers.get(event) ?? []) handler(event, data);
  }
  fatal(type: string, details: string, code?: number) {
    this.emit(FakeHls.Events.ERROR, { type, details, fatal: true, response: code === undefined ? undefined : { code } });
  }

  static reset() {
    FakeHls.instances = [];
    FakeHls.supported = true;
  }
}
