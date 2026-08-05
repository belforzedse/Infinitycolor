import { createContext, useContext } from "react";
import qs from "qs";

export type AdvancedFilterFieldType = "text" | "number" | "date" | "boolean" | "select";

export type AdvancedFilterOption = {
  id: string | number;
  title: string;
};

export type AdvancedFilterField = {
  id: string;
  title: string;
  type?: AdvancedFilterFieldType;
  operators?: string[];
  options?: AdvancedFilterOption[];
};

export type AdvancedFilterItem = {
  field: string;
  operator: string;
  value: string;
};

const AdvancedFilterFieldsContext = createContext<AdvancedFilterField[]>([]);

export const AdvancedFilterFieldsProvider = AdvancedFilterFieldsContext.Provider;

export function useAdvancedFilterFields(): AdvancedFilterField[] {
  return useContext(AdvancedFilterFieldsContext);
}

export const NULL_OPERATORS = new Set(["$null", "$notNull"]);

export const OPERATOR_LABELS: Record<string, string> = {
  $containsi: "شامل",
  $eq: "برابر با",
  $ne: "متفاوت از",
  $startsWith: "شروع با",
  $endsWith: "پایان با",
  $gt: "بزرگ‌تر از",
  $gte: "بزرگ‌تر یا مساوی",
  $lt: "کوچک‌تر از",
  $lte: "کوچک‌تر یا مساوی",
  $null: "خالی",
  $notNull: "غیر خالی",
};

const DEFAULT_TEXT_OPERATORS = [
  "$containsi",
  "$eq",
  "$ne",
  "$startsWith",
  "$endsWith",
  "$null",
  "$notNull",
];
const DEFAULT_NUMBER_OPERATORS = ["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$null", "$notNull"];
const DEFAULT_BOOLEAN_OPERATORS = ["$eq", "$ne", "$null", "$notNull"];

export function operatorsForField(field?: AdvancedFilterField): string[] {
  if (field?.operators?.length) return field.operators;

  switch (field?.type ?? "text") {
    case "number":
    case "date":
      return DEFAULT_NUMBER_OPERATORS;
    case "boolean":
    case "select":
      return DEFAULT_BOOLEAN_OPERATORS;
    case "text":
    default:
      return DEFAULT_TEXT_OPERATORS;
  }
}

export function parseAdvancedFiltersParam(value?: string | null): AdvancedFilterItem[] {
  if (!value) return [];

  const candidates = [value];
  try {
    candidates.push(decodeURIComponent(value));
  } catch {
    // Keep the raw value candidate.
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .map((item): AdvancedFilterItem | null => {
          if (!item || typeof item !== "object") return null;
          return {
            field: typeof item.field === "string" ? item.field : "",
            operator: typeof item.operator === "string" ? item.operator : "",
            value: item.value === undefined || item.value === null ? "" : String(item.value),
          };
        })
        .filter((item): item is AdvancedFilterItem => Boolean(item));
    } catch {
      // Try the next candidate.
    }
  }

  return [];
}

export function serializeAdvancedFiltersParam(value: AdvancedFilterItem[]): string {
  return encodeURIComponent(JSON.stringify(value || []));
}

function fieldPath(fieldId: string): string[] {
  const bracketMatches: string[] = [];
  const bracketPattern = /\[([^\]]+)\]/g;
  let match = bracketPattern.exec(fieldId);
  while (match) {
    bracketMatches.push(match[1]);
    match = bracketPattern.exec(fieldId);
  }
  if (bracketMatches.length > 0) return bracketMatches;
  return fieldId
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function setNestedFilter(
  target: Record<string, unknown>,
  path: string[],
  operator: string,
  value: unknown,
) {
  let cursor: Record<string, unknown> = target;

  path.forEach((part, index) => {
    if (index === path.length - 1) {
      const existing =
        cursor[part] && typeof cursor[part] === "object" && !Array.isArray(cursor[part])
          ? (cursor[part] as Record<string, unknown>)
          : {};
      existing[operator] = value;
      cursor[part] = existing;
      return;
    }

    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  });
}

function normalizeFilterValue(field: AdvancedFilterField, item: AdvancedFilterItem): unknown {
  if (NULL_OPERATORS.has(item.operator)) return true;

  if ((field.type ?? "text") === "number") {
    const numberValue = Number(item.value);
    return Number.isFinite(numberValue) ? numberValue : item.value.trim();
  }

  if (field.type === "boolean") {
    return item.value === "true";
  }

  return item.value.trim();
}

export function sanitizeAdvancedFilters(
  filters: AdvancedFilterItem[],
  fields: AdvancedFilterField[] = [],
): AdvancedFilterItem[] {
  const fieldMap = new Map(fields.map((field) => [field.id, field]));

  return filters.filter((item) => {
    const field = fieldMap.get(item.field);
    if (!field) return false;
    if (!operatorsForField(field).includes(item.operator)) return false;
    if (NULL_OPERATORS.has(item.operator)) return true;
    return item.value.trim().length > 0;
  });
}

export function buildAdvancedFiltersObject(
  filters: AdvancedFilterItem[],
  fields: AdvancedFilterField[] = [],
): Record<string, unknown> {
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const output: Record<string, unknown> = {};

  for (const item of sanitizeAdvancedFilters(filters, fields)) {
    const field = fieldMap.get(item.field);
    if (!field) continue;
    const path = fieldPath(item.field);
    if (path.length === 0) continue;
    setNestedFilter(output, path, item.operator, normalizeFilterValue(field, item));
  }

  return output;
}

export function buildAdvancedFiltersQuery(
  filters: AdvancedFilterItem[],
  fields: AdvancedFilterField[] = [],
): string {
  const filterObject = buildAdvancedFiltersObject(filters, fields);
  if (Object.keys(filterObject).length === 0) return "";

  return qs.stringify(
    { filters: filterObject },
    {
      encodeValuesOnly: true,
    },
  );
}

export function buildSuperAdminTableRequestUrl(params: {
  url: string;
  page: string | number;
  pageSize: string | number;
  filters?: AdvancedFilterItem[];
  filterFields?: AdvancedFilterField[];
}): string {
  const { url, page, pageSize, filters = [], filterFields = [] } = params;
  const paginationQuery = qs.stringify(
    {
      pagination: {
        page,
        pageSize,
      },
    },
    { encodeValuesOnly: true },
  );
  const advancedFiltersQuery = buildAdvancedFiltersQuery(filters, filterFields);
  const query = [paginationQuery, advancedFiltersQuery].filter(Boolean).join("&");
  const separator = url.includes("?") ? "&" : "?";

  return query ? `${url}${separator}${query}` : url;
}

export function describeAdvancedFilter(
  item: AdvancedFilterItem,
  fields: AdvancedFilterField[] = [],
): string | null {
  const field = fields.find((candidate) => candidate.id === item.field);
  if (!field) return null;
  const operator = OPERATOR_LABELS[item.operator] ?? item.operator;

  if (NULL_OPERATORS.has(item.operator)) {
    return `${field.title}: ${operator}`;
  }

  const option = field.options?.find((candidate) => String(candidate.id) === item.value);
  return `${field.title}: ${operator} ${option?.title ?? item.value}`;
}
