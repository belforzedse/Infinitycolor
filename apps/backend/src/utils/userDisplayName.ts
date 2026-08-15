function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

/**
 * Return the human name stored in a user's profile, without falling back to
 * login identifiers such as the phone-backed `username` field.
 */
export function resolveUserFullName(user: any): string | null {
  const profile =
    user?.user_info?.data?.attributes ||
    user?.user_info?.attributes ||
    user?.user_info;
  const firstName = normalizedText(profile?.FirstName ?? profile?.first_name);
  const lastName = normalizedText(profile?.LastName ?? profile?.last_name);
  return [firstName, lastName].filter(Boolean).join(" ") || null;
}

