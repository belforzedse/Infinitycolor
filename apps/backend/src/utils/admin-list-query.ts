export const DEFAULT_ADMIN_PAGE_SIZE = 25;
export const MAX_ADMIN_PAGE_SIZE = 100;
export const MAX_ADMIN_PAGE = 1_000_000;
export const MAX_ADMIN_SEARCH_LENGTH = 80;
export const MAX_ADMIN_FILTERS = 12;

export type AdminFilterType = "text" | "number" | "date" | "select";

export type AdminFilterDefinition = {
  path: readonly string[];
  type: AdminFilterType;
};

type AdminFilterInput = {
  field?: unknown;
  operator?: unknown;
  value?: unknown;
};

const TEXT_OPERATORS = new Set([
  "$containsi",
  "$eq",
  "$ne",
  "$startsWith",
  "$endsWith",
  "$null",
  "$notNull",
]);
const COMPARABLE_OPERATORS = new Set([
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$null",
  "$notNull",
]);
const SELECT_OPERATORS = new Set(["$eq", "$ne", "$null", "$notNull"]);
const NULL_OPERATORS = new Set(["$null", "$notNull"]);

export function positiveAdminInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function rejectAdminListRequest(ctx: any, message: string): null {
  ctx.badRequest(message);
  return null;
}

function nestedFilter(path: readonly string[], operator: string, value: unknown) {
  let result: Record<string, unknown> = {
    [path[path.length - 1]]: { [operator]: value },
  };
  for (let index = path.length - 2; index >= 0; index -= 1) {
    result = { [path[index]]: result };
  }
  return result;
}

function allowedOperators(type: AdminFilterType): Set<string> {
  if (type === "text") return TEXT_OPERATORS;
  if (type === "select") return SELECT_OPERATORS;
  return COMPARABLE_OPERATORS;
}

function normalizeValue(
  ctx: any,
  definition: AdminFilterDefinition,
  operator: string,
  rawValue: unknown,
): unknown | null {
  if (NULL_OPERATORS.has(operator)) return true;

  if (definition.type === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      return rejectAdminListRequest(ctx, "Numeric filters require a finite number");
    }
    return value;
  }

  const value = String(rawValue ?? "").trim();
  if (!value || value.length > MAX_ADMIN_SEARCH_LENGTH) {
    return rejectAdminListRequest(ctx, "Filter values must contain 1 to 80 characters");
  }
  if (definition.type === "date" && Number.isNaN(Date.parse(value))) {
    return rejectAdminListRequest(ctx, "Date filters require a valid date");
  }
  return value;
}

export function parseAdminFilters(
  ctx: any,
  rawFilters: unknown,
  definitions: Record<string, AdminFilterDefinition>,
  label: string,
): Array<Record<string, unknown>> | null {
  if (rawFilters === undefined) return [];
  if (!Array.isArray(rawFilters) || rawFilters.length > MAX_ADMIN_FILTERS) {
    return rejectAdminListRequest(
      ctx,
      `filters must be an array with at most ${MAX_ADMIN_FILTERS} items`,
    );
  }

  const filters: Array<Record<string, unknown>> = [];
  for (const input of rawFilters as AdminFilterInput[]) {
    if (!input || typeof input !== "object") {
      return rejectAdminListRequest(ctx, "Each filter must be an object");
    }

    const field = String(input.field || "");
    const definition = definitions[field];
    if (!definition) {
      return rejectAdminListRequest(ctx, `Unsupported ${label} filter field`);
    }

    const operator = String(input.operator || "");
    if (!allowedOperators(definition.type).has(operator)) {
      return rejectAdminListRequest(ctx, `Unsupported ${label} filter operator`);
    }

    const value = normalizeValue(ctx, definition, operator, input.value);
    if (value === null) return null;
    filters.push(nestedFilter(definition.path, operator, value));
  }
  return filters;
}

export function adminPagination(page: number, pageSize: number, total: number) {
  return {
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
    total,
  };
}
