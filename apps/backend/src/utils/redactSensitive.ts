/**
 * Deep redaction of sensitive values from audit `Changes` / `Metadata` before they are persisted or
 * shown to admins. The audit helpers already whitelist the fields they record, so this is
 * defense-in-depth: it guarantees that even if a sensitive key ever slips into a diff or metadata
 * payload, its value is never stored or displayed.
 */

const REDACTED = "[redacted]";

/**
 * Keys whose values must never be persisted. Matched case-insensitively as a substring, so e.g.
 * `apiKey`, `API_KEY`, `userPassword`, `authorizationHeader` all match.
 */
const SENSITIVE_KEY_PATTERN =
  /(token|password|secret|authorization|cookie|jwt|otp|api[-_]?key|card|cvv|pin|credential|passwd|session|snappay)/i;

const MAX_DEPTH = 8;

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // Never return an uninspected object once the recursion budget is exhausted:
  // a deeply nested payment token would otherwise bypass redaction entirely.
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(val, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Return a deep copy of `input` with the values of any sensitive keys replaced by `"[redacted]"`.
 * Non-object input is returned unchanged. Safe against circular references.
 */
export function redactSensitive<T>(input: T): T {
  if (input === null || typeof input !== "object") return input;
  return redactValue(input, 0, new WeakSet()) as T;
}
