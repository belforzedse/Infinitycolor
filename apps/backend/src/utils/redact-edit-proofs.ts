const PRIVATE_KEYS = new Set(["token", "token_hash", "tokenHash", "editorInstanceId", "instanceId", "session_id"]);

/** Apply after SDK processors so request and breadcrumb copies are covered. */
export function redactEditProofs<T>(event: T): T {
  const seen = new WeakSet<object>();
  const visit = (value: any): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (key.toLowerCase().startsWith("x-product-edit-") || PRIVATE_KEYS.has(key)) value[key] = "[Filtered]";
      else visit(value[key]);
    }
  };
  visit(event);
  return event;
}
