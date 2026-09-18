import {
  dropNoisyStorefrontSentryEvent,
  isReplayHydrationSentryEvent,
  tagStorefrontSentryEvent,
  TRANSIENT_NETWORK_MESSAGES,
  WASM_BINDGEN_ALIASING_MESSAGE,
} from "../storefront-sentry-tags";

describe("tagStorefrontSentryEvent", () => {
  it("tags Android WebView injects and still returns the event", () => {
    const event = {
      message: "Error invoking postMessage: Java object is gone",
      exception: {
        values: [
          {
            value: "Error invoking postMessage: Java object is gone",
            stacktrace: {
              frames: [{ filename: "navigation_performance_logger_android" }],
            },
          },
        ],
      },
    };

    const tagged = tagStorefrontSentryEvent(event);
    expect(tagged).toBe(event);
    expect(tagged.tags?.inject).toBe("android-webview");
  });

  it("tags anonymous eval injects (getParams) without dropping", () => {
    const event = {
      exception: {
        values: [
          {
            value: "ReferenceError: getParams is not defined",
            stacktrace: {
              frames: [{ filename: "<anonymous>", function: "?" }],
            },
          },
        ],
      },
    };

    const tagged = tagStorefrontSentryEvent(event);
    expect(tagged).not.toBeNull();
    expect(tagged.tags?.inject).toBe("eval");
  });

  it("tags crawler telemetry frames", () => {
    const event = {
      message: "Cannot read properties of null (reading 'tagName')",
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'tagName')",
            stacktrace: {
              frames: [{ filename: "https://evil.example/telemetry.js", function: "addEL_hook" }],
            },
          },
        ],
      },
    };

    expect(tagStorefrontSentryEvent(event).tags?.inject).toBe("crawler-telemetry");
  });

  it("tags Flight transport cuts as transport_cut=rsc and still sends", () => {
    for (const message of TRANSIENT_NETWORK_MESSAGES) {
      const event = { message };
      const tagged = tagStorefrontSentryEvent(event);
      expect(tagged.tags?.transport_cut).toBe("rsc");
      expect(tagged).toBe(event);
    }
  });

  it("tags TypeError-prefixed Flight cuts the same way", () => {
    const tagged = tagStorefrontSentryEvent({ message: "TypeError: Load failed" });
    expect(tagged.tags?.transport_cut).toBe("rsc");
  });

  it("does not drop ordinary application errors", () => {
    const event = {
      message: "PdpProductUnavailableError: product missing",
      exception: {
        values: [
          {
            value: "PdpProductUnavailableError: product missing",
            stacktrace: {
              frames: [{ filename: "app/pdp/[slug]/page.tsx", function: "fetchPdpProduct" }],
            },
          },
        ],
      },
    };

    const tagged = tagStorefrontSentryEvent(event);
    expect(tagged.tags?.inject).toBeUndefined();
    expect(tagged.tags?.transport_cut).toBeUndefined();
    expect(tagged).toBe(event);
  });

  it("does not drop Android WebView postMessage or anonymous getParams after tagging", () => {
    const webview = tagStorefrontSentryEvent({
      message: "Error invoking postMessage: Java object is gone",
      exception: {
        values: [
          {
            value: "Error invoking postMessage: Java object is gone",
            stacktrace: {
              frames: [{ filename: "navigation_performance_logger_android" }],
            },
          },
        ],
      },
    });
    expect(dropNoisyStorefrontSentryEvent(webview)).toBe(webview);

    const evalInject = tagStorefrontSentryEvent({
      exception: {
        values: [
          {
            value: "ReferenceError: getParams is not defined",
            stacktrace: {
              frames: [{ filename: "<anonymous>", function: "?" }],
            },
          },
        ],
      },
    });
    expect(dropNoisyStorefrontSentryEvent(evalInject)).toBe(evalInject);
  });
});

describe("dropNoisyStorefrontSentryEvent", () => {
  it("drops stackless Replay Hydration Error titles", () => {
    const event = { message: "Hydration Error" };
    expect(isReplayHydrationSentryEvent(event)).toBe(true);
    expect(dropNoisyStorefrontSentryEvent(event)).toBeNull();
  });

  it("keeps React #418 even when the title mentions hydration", () => {
    const event = {
      message: "Minified React error #418; visit https://react.dev/errors/418",
      exception: {
        values: [
          {
            value: "Minified React error #418; visit https://react.dev/errors/418",
            stacktrace: {
              frames: [{ filename: "app/layout.tsx", function: "RootLayout" }],
            },
          },
        ],
      },
    };
    expect(isReplayHydrationSentryEvent(event)).toBe(false);
    expect(dropNoisyStorefrontSentryEvent(event)).toEqual(event);
  });

  it("keeps stackless React #418 titles so ignoreErrors cannot mute a real mismatch", () => {
    const event = { message: "Minified React error #418; visit https://react.dev/errors/418" };
    expect(isReplayHydrationSentryEvent(event)).toBe(false);
    expect(dropNoisyStorefrontSentryEvent(event)).toEqual(event);
  });

  it("drops crawler tagName reads after tagging", () => {
    const tagged = tagStorefrontSentryEvent({
      message: "Cannot read properties of null (reading 'tagName')",
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'tagName')",
            stacktrace: {
              frames: [{ filename: "https://evil.example/telemetry.js", function: "addEL_hook" }],
            },
          },
        ],
      },
    });
    expect(dropNoisyStorefrontSentryEvent(tagged)).toBeNull();
  });

  it("drops anonymous tagName reads even without a telemetry filename", () => {
    const tagged = tagStorefrontSentryEvent({
      message: "Cannot read property of null (reading 'tagName')",
      exception: {
        values: [
          {
            value: "Cannot read property of null (reading 'tagName')",
            stacktrace: {
              frames: [{ filename: "<anonymous>", function: "?" }],
            },
          },
        ],
      },
    });
    expect(dropNoisyStorefrontSentryEvent(tagged)).toBeNull();
  });

  it("keeps a first-party tagName TypeError", () => {
    const event = {
      message: "Cannot read properties of null (reading 'tagName')",
      exception: {
        values: [
          {
            value: "Cannot read properties of null (reading 'tagName')",
            stacktrace: {
              frames: [{ filename: "app/components/Gallery.tsx", function: "Gallery" }],
            },
          },
        ],
      },
    };
    expect(dropNoisyStorefrontSentryEvent(tagStorefrontSentryEvent(event))).toEqual(
      expect.objectContaining({ message: event.message }),
    );
  });

  it("drops wasm-bindgen rust aliasing panics", () => {
    expect(dropNoisyStorefrontSentryEvent({ message: WASM_BINDGEN_ALIASING_MESSAGE })).toBeNull();
  });

  it("drops tagged Flight transport cuts", () => {
    for (const message of TRANSIENT_NETWORK_MESSAGES) {
      const tagged = tagStorefrontSentryEvent({ message });
      expect(dropNoisyStorefrontSentryEvent(tagged)).toBeNull();
    }
    expect(
      dropNoisyStorefrontSentryEvent(tagStorefrontSentryEvent({ message: "TypeError: Load failed" })),
    ).toBeNull();
  });
});
