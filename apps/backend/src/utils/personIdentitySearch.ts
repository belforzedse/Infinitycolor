import {
  canonicalCustomerPhone,
  customerPhoneStorageVariants,
  normalizeCustomerPhoneDigits,
} from "./customerPhoneIdentity";

/**
 * Name alternatives used by the admin users list. Customer search reuses these
 * so a multi-word query such as «سید محمد حسینی» still hits FirstName+LastName
 * splits, without copying the rest of the users-list endpoint.
 */
export function personNameSearchAlternatives(
  search: string,
): Array<Record<string, unknown>> {
  const words = search.split(/\s+/).filter(Boolean);
  const alternatives: Array<Record<string, unknown>> = [
    { user_info: { FirstName: { $containsi: search } } },
    { user_info: { LastName: { $containsi: search } } },
  ];

  if (words.length > 1) {
    alternatives.push({
      $and: [
        { user_info: { FirstName: { $containsi: words[0] } } },
        { user_info: { LastName: { $containsi: words.slice(1).join(" ") } } },
      ],
    });
  }

  if (words.length > 2) {
    alternatives.push({
      $and: [
        { user_info: { FirstName: { $containsi: words.slice(0, -1).join(" ") } } },
        { user_info: { LastName: { $containsi: words[words.length - 1] } } },
      ],
    });
  }

  if (words.length > 3) {
    const midpoint = Math.ceil(words.length / 2);
    alternatives.push({
      $and: [
        {
          user_info: {
            FirstName: { $containsi: words.slice(0, midpoint).join(" ") },
          },
        },
        {
          user_info: {
            LastName: { $containsi: words.slice(midpoint).join(" ") },
          },
        },
      ],
    });
  }

  return alternatives;
}

function uniqueWhereClauses(
  clauses: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const unique: Array<Record<string, unknown>> = [];
  for (const clause of clauses) {
    const key = JSON.stringify(clause);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(clause);
  }
  return unique;
}

/**
 * Phones persist as `+989…`, `09…`, `989…`, or the bare national number, and
 * operators paste Persian digits, dashes, and leading zeros. Exact `$in` on the
 * two canonical stored shapes misses the rest; `$containsi` on the national
 * part hits every common layout.
 */
export function customerPhoneSearchAlternatives(
  query: string,
): Array<Record<string, unknown>> {
  const clauses: Array<Record<string, unknown>> = [{ phone: { $containsi: query } }];
  const digits = normalizeCustomerPhoneDigits(query);
  if (!digits) return uniqueWhereClauses(clauses);

  const canonical = canonicalCustomerPhone(digits);
  if (canonical) {
    clauses.push({ phone: { $in: customerPhoneStorageVariants(canonical) } });
  }

  const nationalPart = digits.replace(/^\+?98/, "").replace(/^0+/, "");
  if (!nationalPart) return uniqueWhereClauses(clauses);

  for (const variant of [
    nationalPart,
    `0${nationalPart}`,
    `98${nationalPart}`,
    `+98${nationalPart}`,
  ]) {
    clauses.push({ phone: { $containsi: variant } });
  }

  return uniqueWhereClauses(clauses);
}
