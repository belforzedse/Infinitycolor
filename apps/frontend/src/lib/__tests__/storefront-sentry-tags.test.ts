import {
  tagStorefrontSentryEvent,
  TRANSIENT_NETWORK_MESSAGES,
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
});
