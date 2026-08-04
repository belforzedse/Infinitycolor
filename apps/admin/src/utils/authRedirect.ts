/**
 * Accept only same-origin path redirects. This rejects absolute URLs,
 * protocol-relative URLs, backslash variants, and malformed values.
 */
export function safeInternalRedirect(value: string | null | undefined): string | null {
  const candidate = value?.trim();

  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\")
  ) {
    return null;
  }

  try {
    const base = new URL("https://infinity.invalid");
    const target = new URL(candidate, base);

    if (target.origin !== base.origin) {
      return null;
    }

    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}
