import {
  canonicalCustomerPhone,
  customerPhoneStorageVariants,
  normalizeCustomerPhoneDigits,
} from "./customerPhoneIdentity";

/**
 * Name alternatives used by the admin users list. Customer search reuses these
 * so a multi-word query such as «سید محمد حسینی» still hits FirstName+LastName
 * splits, without copying the rest of the users-list endpoint.
 *
 * `via` names the relation that owns `user_info` when the clauses are built for
 * another content type — `"user"` on an order, `"owner"` on a reserve group.
 * Omitted, the clauses stay rooted at the user itself, exactly as before.
 */
export function personNameSearchAlternatives(
  search: string,
  via?: string,
): Array<Record<string, unknown>> {
  const clause = (field: "FirstName" | "LastName", value: string) => {
    const condition = { user_info: { [field]: { $containsi: value } } };
    return via ? { [via]: condition } : condition;
  };

  const words = search.split(/\s+/).filter(Boolean);
  const alternatives: Array<Record<string, unknown>> = [
    clause("FirstName", search),
    clause("LastName", search),
  ];

  if (words.length > 1) {
    alternatives.push({
      $and: [
        clause("FirstName", words[0]),
        clause("LastName", words.slice(1).join(" ")),
      ],
    });
  }

  if (words.length > 2) {
    alternatives.push({
      $and: [
        clause("FirstName", words.slice(0, -1).join(" ")),
        clause("LastName", words[words.length - 1]),
      ],
    });
  }

  if (words.length > 3) {
    const midpoint = Math.ceil(words.length / 2);
    alternatives.push({
      $and: [
        clause("FirstName", words.slice(0, midpoint).join(" ")),
        clause("LastName", words.slice(midpoint).join(" ")),
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
 *
 * `via` names the relation that owns `phone`, as on `personNameSearchAlternatives`.
 */
export function customerPhoneSearchAlternatives(
  query: string,
  via?: string,
): Array<Record<string, unknown>> {
  const clause = (condition: Record<string, unknown>) =>
    via ? { [via]: { phone: condition } } : { phone: condition };

  const clauses: Array<Record<string, unknown>> = [clause({ $containsi: query })];
  const digits = normalizeCustomerPhoneDigits(query);
  if (!digits) return uniqueWhereClauses(clauses);

  const canonical = canonicalCustomerPhone(digits);
  if (canonical) {
    clauses.push(clause({ $in: customerPhoneStorageVariants(canonical) }));
  }

  const nationalPart = digits.replace(/^\+?98/, "").replace(/^0+/, "");
  if (!nationalPart) return uniqueWhereClauses(clauses);

  for (const variant of [
    nationalPart,
    `0${nationalPart}`,
    `98${nationalPart}`,
    `+98${nationalPart}`,
  ]) {
    clauses.push(clause({ $containsi: variant }));
  }

  return uniqueWhereClauses(clauses);
}
