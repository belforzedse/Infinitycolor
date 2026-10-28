/**
 * Storefront Sentry beforeSend helpers.
 *
 * Drop verified host injections and confirmed recoveries. A browser family,
 * generic transport message or stackless hydration title alone is not proof
 * that the application worked.
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

/** Matches Sentry tag values (`Primitive`) so `beforeSend` ErrorEvents type-check. */
type SentryTagValue = string | number | boolean | bigint | symbol | null | undefined;

type SentryEventLike = {
  message?: string;
  fingerprint?: Array<string | number>;
  tags?: Record<string, SentryTagValue>;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: {
        frames?: SentryFrameLike[];
      };
    }>;
  };
  contexts?: unknown;
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

/**
 * Sentry Replay invents a stackless "Hydration Error" title from snapshot
 * diffs (html attrs, WebView inject). Real React mismatches keep #418 /
 * "Hydration failed" / "Text content does not match" and a component stack.
 */
export function isReplayHydrationSentryEvent(event: SentryEventLike): boolean {
  // A stackless snapshot is insufficient evidence that hydration succeeded.
  return eventMessage(event) === "Hydration Error" && hasOnlyInjectedFrames(allFrames(event));
}

function hasOnlyInjectedFrames(frames: SentryFrameLike[]): boolean {
  if (
    frames.some((frame) => /\/_next\/|(?:^|\/)app\/|webpack:|(?:^|\/)src\//.test(frameBlob(frame)))
  )
    return false;
  return (
    frames.length > 0 &&
    frames.some((frame) =>
      /navigation_performance_logger_android|app:\/\/|telemetry\.js|addEL_hook/.test(
        frameBlob(frame),
      ),
    ) &&
    frames.every(
      (frame) =>
        isAnonymousOnly([frame]) ||
        /navigation_performance_logger_android|^app:\/\/|telemetry\.js|addEL_hook/.test(
          frameBlob(frame),
        ),
    )
  );
}

function isProvenInjected(event: SentryEventLike): boolean {
  const frames = allFrames(event);
  const message = eventMessage(event);
  const nativeSignature =
    /Java object is gone|Java bridge method invocation error|Java exception was raised during method invocation|Error invoking (?:enableDidUserTypeOnKeyboardLogging|postMessage|enableButtonsClickedMetaDataLogging)|webkit\.messageHandlers/.test(
      message,
    );
  return (
    (nativeSignature && (hasOnlyInjectedFrames(frames) || isAnonymousOnly(frames))) ||
    (/getParams is not defined/.test(message) && isAnonymousOnly(frames)) ||
    (TAG_NAME_NULL.test(message) && (hasOnlyInjectedFrames(frames) || isAnonymousOnly(frames)))
  );
}

/**
 * Classify host injects / transport cuts and set tags. Always returns the
 * event (never drops). Drops live in `dropNoisyStorefrontSentryEvent`.
 */
export function tagStorefrontSentryEvent<T extends SentryEventLike>(event: T): T {
  const message = eventMessage(event);
  const frames = allFrames(event);
  const paths = frames.map(frameBlob).join("\n");
  const tags: Record<string, SentryTagValue> = { ...(event.tags ?? {}) };

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
  if (isReplayHydrationSentryEvent(event)) return null;
  if (isProvenInjected(event)) return null;

  if (
    event.tags?.transport_cut === "rsc" &&
    (event.tags?.recovery_outcome === "recovered" || event.tags?.recovery_outcome === "cancelled")
  )
    return null;
  return event;
}
