/**
 * Tag-only Sentry beforeSend helpers for storefront noise that must stay
 * visible. Host-injected WebView/crawler frames and Flight transport cuts are
 * not application defects we can implement away — but dropping them hides
 * volume. Tags keep them filterable without mute.
 */

/** Matches StorefrontRecoveryState: RSC/stream cuts that auto-retry there. */
export const TRANSIENT_NETWORK_MESSAGES = new Set([
  "Connection closed.",
  "Load failed",
  "Failed to fetch",
  "network error",
  "NetworkError when attempting to fetch resource.",
]);

type SentryFrameLike = {
  filename?: string | null;
  abs_path?: string | null;
  function?: string | null;
  module?: string | null;
};

type SentryEventLike = {
  message?: string;
  tags?: Record<string, string>;
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: {
        frames?: SentryFrameLike[];
      };
    }>;
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

/**
 * Classify host injects / transport cuts and set tags. Always returns the
 * event (never drops). Checkout drops stay in `dropExpectedCheckoutSentryEvent`.
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

  if (TRANSIENT_NETWORK_MESSAGES.has(message)) {
    tags.transport_cut = "rsc";
  }

  event.tags = tags;
  return event;
}
