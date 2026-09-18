/**
 * Storefront Sentry beforeSend helpers.
 *
 * Host-injected WebView/crawler frames, Replay snapshot hydration titles, and
 * Flight transport cuts are not application defects we can implement away.
 * Tag first so a mistaken drop is still diagnosable in the payload, then drop
 * the fingerprints that drown real issues.
 */

/** Matches StorefrontRecoveryState: RSC/stream cuts that auto-retry there. */
export const TRANSIENT_NETWORK_MESSAGES = new Set([
  "Connection closed.",
  "Load failed",
  "Failed to fetch",
  "network error",
  "NetworkError when attempting to fetch resource.",
]);

export const WASM_BINDGEN_ALIASING_MESSAGE =
  "recursive use of an object detected which would lead to unsafe aliasing in rust";

const TAG_NAME_NULL = /Cannot read propert(?:y|ies) of null \(reading ['"]tagName['"]\)/;

type SentryFrameLike = {
  filename?: string | null;
  abs_path?: string | null;
  function?: string | null;
  module?: string | null;
};

type SentryEventLike = {
  message?: string;
  fingerprint?: Array<string | number>;
  tags?: Record<string, string>;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: SentryFrameLike[];
      };
    }>;
  };
  contexts?: {
    react?: {
      componentStack?: string;
    };
  };
};

function eventMessage(event: SentryEventLike): string {
  return event.message || event.exception?.values?.[0]?.value || "";
}

function allFrames(event: SentryEventLike): SentryFrameLike[] {
  const values = event.exception?.values;
  if (!values?.length) return [];
  return values.flatMap((value) => value.stacktrace?.frames ?? []);
}

function frameBlob(frame: SentryFrameLike): string {
  return `${frame.filename ?? ""} ${frame.abs_path ?? ""} ${frame.module ?? ""} ${frame.function ?? ""}`;
}

function isAnonymousOnly(frames: SentryFrameLike[]): boolean {
  if (frames.length === 0) return false;
  return frames.every((frame) => {
    const name = (frame.filename ?? frame.abs_path ?? "").trim();
    return name === "" || name === "<anonymous>" || name.endsWith("<anonymous>");
  });
}

function stripErrorTypePrefix(message: string): string {
  return message.replace(/^(?:TypeError|Error):\s*/, "");
}

function isTransientNetworkMessage(message: string): boolean {
  return (
    TRANSIENT_NETWORK_MESSAGES.has(message) ||
    TRANSIENT_NETWORK_MESSAGES.has(stripErrorTypePrefix(message))
  );
}

function hasUsefulStack(event: SentryEventLike): boolean {
  const frames = allFrames(event);
  if (
    frames.some((frame) => {
      const name = (frame.filename ?? frame.abs_path ?? "").trim();
      return name !== "" && name !== "<anonymous>" && !name.endsWith("<anonymous>");
    })
  ) {
    return true;
  }
  const componentStack = event.contexts?.react?.componentStack;
  return typeof componentStack === "string" && componentStack.trim().length > 0;
}

/**
 * Sentry Replay invents a stackless "Hydration Error" title from snapshot
 * diffs (html attrs, WebView inject). Real React mismatches keep #418 /
 * "Hydration failed" / "Text content does not match" and a component stack.
 */
export function isReplayHydrationSentryEvent(event: SentryEventLike): boolean {
  if (hasUsefulStack(event)) return false;
  const message = eventMessage(event);
  if (message === "Hydration Error") return true;
  if (message && /#418|Hydration failed|Text content does not match/i.test(message)) {
    return false;
  }
  return Boolean(
    event.fingerprint?.some((part) => String(part).toLowerCase().includes("hydration")),
  );
}

function isInjectedTagNameRead(event: SentryEventLike, inject: string | undefined): boolean {
  const message = eventMessage(event);
  if (!TAG_NAME_NULL.test(message)) return false;
  if (inject === "crawler-telemetry" || inject === "android-webview" || inject === "eval") {
    return true;
  }
  const frames = allFrames(event);
  return frames.length === 0 || isAnonymousOnly(frames);
}

/**
 * Classify host injects / transport cuts and set tags. Always returns the
 * event (never drops). Drops live in `dropNoisyStorefrontSentryEvent`.
 */
export function tagStorefrontSentryEvent<T extends SentryEventLike>(event: T): T {
  const message = eventMessage(event);
  const frames = allFrames(event);
  const paths = frames.map(frameBlob).join("\n");
  const tags: Record<string, string> = { ...(event.tags ?? {}) };

  if (
    paths.includes("navigation_performance_logger_android") ||
    message.includes("Java object is gone") ||
    message.includes("Java bridge method invocation error") ||
    message.includes("Java exception was raised during method invocation") ||
    /Error invoking (?:enableDidUserTypeOnKeyboardLogging|postMessage|enableButtonsClickedMetaDataLogging)/.test(
      message,
    )
  ) {
    tags.inject = "android-webview";
  } else if (
    paths.includes("telemetry.js") ||
    paths.includes("addEL_hook") ||
    (message.includes("tagName") && paths.includes("telemetry"))
  ) {
    tags.inject = "crawler-telemetry";
  } else if (
    isAnonymousOnly(frames) ||
    (/getParams is not defined/.test(message) && paths.includes("<anonymous>")) ||
    /webkit\.messageHandlers/.test(message)
  ) {
    tags.inject = "eval";
  }

  if (isTransientNetworkMessage(message)) {
    tags.transport_cut = "rsc";
  }

  event.tags = tags;
  return event;
}

/**
 * Drop fingerprints that are not first-party defects. Does not mute React
 * hydration #418 or application TypeErrors that happen to mention fetch.
 */
export function dropNoisyStorefrontSentryEvent<T extends SentryEventLike>(event: T): T | null {
  const message = eventMessage(event);
  const inject = event.tags?.inject;
  if (isReplayHydrationSentryEvent(event)) return null;
  if (isInjectedTagNameRead(event, inject)) return null;
  if (message.includes(WASM_BINDGEN_ALIASING_MESSAGE)) return null;
  if (event.tags?.transport_cut === "rsc") return null;
  return event;
}
