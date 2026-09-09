export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numericId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function fieldsFromSource(source: Record<string, unknown>): Record<string, unknown> {
  const rawFields = isRecord(source.attributes) ? source.attributes : source;
  const fields: Record<string, unknown> = { ...rawFields };
  delete fields.id;
  delete fields.attributes;
  delete fields.data;
  return fields;
}

/**
 * Unwrap a Strapi REST entity or a flattened entity-service payload.
 * Users-permissions relations often omit the `attributes` wrapper.
 */
export function unwrapStrapiEntity(
  entry: unknown,
): (Record<string, unknown> & { id: number }) | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }

  const nested = entry.data;
  const source = isRecord(nested) ? nested : entry;
  const id = numericId(source.id);
  if (id === undefined) {
    return undefined;
  }

  return { id, ...fieldsFromSource(source) };
}

export function unwrapStrapiFields(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }

  const nested = entry.data;
  const source = isRecord(nested) ? nested : entry;
  return fieldsFromSource(source);
}

export function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
