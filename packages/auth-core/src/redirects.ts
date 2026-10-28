const CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f]/;
const SCHEME_LIKE = /^[a-z][a-z0-9+.-]*:/i;

function decodeForValidation(value: string): string | null {
  let decoded = value;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function parseExactOrigins(value: string): readonly string[] {
  const origins = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const url = new URL(entry);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          `Trusted storefront entry must be an exact HTTP(S) origin: ${entry}`,
        );
      }
      return url.origin;
    });

  return Array.from(new Set(origins));
}

export function safeInternalPath(
  value: string | null | undefined,
): string | null {
  if (!value || value.length > 2_048 || CONTROL_OR_WHITESPACE.test(value))
    return null;

  const decoded = decodeForValidation(value);
  if (!decoded || CONTROL_OR_WHITESPACE.test(decoded) || decoded.includes("\\"))
    return null;
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    SCHEME_LIKE.test(decoded)
  )
    return null;

  try {
    const parsed = new URL(decoded, "https://return.invalid");
    if (parsed.origin !== "https://return.invalid") return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function resolveReturnTarget(
  value: string | null | undefined,
  allowedOrigins: readonly string[],
  defaultOrigin: string,
): string {
  const allowed = new Set(
    allowedOrigins.map((origin) => new URL(origin).origin),
  );
  const normalizedDefault = new URL(defaultOrigin).origin;
  if (!allowed.has(normalizedDefault)) {
    throw new Error(
      "The default storefront origin must be present in the trusted-origin allowlist",
    );
  }

  if (!value) return `${normalizedDefault}/`;
  const decoded = decodeForValidation(value);
  if (
    !decoded ||
    CONTROL_OR_WHITESPACE.test(decoded) ||
    decoded.includes("\\")
  ) {
    return `${normalizedDefault}/`;
  }

  const internal = safeInternalPath(value);
  if (internal) return `${normalizedDefault}${internal}`;

  try {
    const target = new URL(value);
    // Local development uses HTTP; still require an explicitly trusted origin,
    // including its port. Every non-loopback destination must use HTTPS.
    const trustedLocalHttp =
      target.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
    if (
      (target.protocol !== "https:" && !trustedLocalHttp) ||
      target.username ||
      target.password ||
      !allowed.has(target.origin)
    ) {
      return `${normalizedDefault}/`;
    }
    return `${target.origin}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return `${normalizedDefault}/`;
  }
}

export function appendReturnTarget(authUrl: string, returnTo: string): string {
  const url = new URL(authUrl);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}
