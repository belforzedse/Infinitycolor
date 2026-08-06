import { sanitize } from "@strapi/utils";
import { MANAGEMENT_ROLES } from "../../../utils/roles";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;
const MAX_SEARCH_LENGTH = 80;
const MAX_FILTERS = 8;

const SORT_FIELDS = {
  id: "id",
  createdAt: "createdAt",
  phone: "phone",
} as const;

const FILTER_FIELDS = {
  "[user_info][FirstName]": { path: ["user_info", "FirstName"], type: "text" },
  "[user_info][LastName]": { path: ["user_info", "LastName"], type: "text" },
  "[phone]": { path: ["phone"], type: "text" },
  "[blocked]": { path: ["blocked"], type: "boolean" },
  "[confirmed]": { path: ["confirmed"], type: "boolean" },
} as const;

const TEXT_OPERATORS = new Set([
  "$containsi",
  "$eq",
  "$ne",
  "$startsWith",
  "$endsWith",
  "$null",
  "$notNull",
]);
const BOOLEAN_OPERATORS = new Set(["$eq", "$ne", "$null", "$notNull"]);
const NULL_OPERATORS = new Set(["$null", "$notNull"]);

type FilterField = keyof typeof FILTER_FIELDS;
type SortField = keyof typeof SORT_FIELDS;
type Direction = "asc" | "desc";

type FilterInput = {
  field?: unknown;
  operator?: unknown;
  value?: unknown;
};

type UsersListBody = {
  page?: unknown;
  pageSize?: unknown;
  removed?: unknown;
  search?: unknown;
  managerRolesOnly?: unknown;
  filters?: unknown;
  sort?: unknown;
};

function positiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function badRequest(ctx: any, message: string): null {
  ctx.badRequest(message);
  return null;
}

function nestedFilter(path: readonly string[], operator: string, value: unknown) {
  let output: Record<string, unknown> = { [path[path.length - 1]]: { [operator]: value } };
  for (let index = path.length - 2; index >= 0; index -= 1) {
    output = { [path[index]]: output };
  }
  return output;
}

function parseFilters(ctx: any, rawFilters: unknown): Array<Record<string, unknown>> | null {
  if (rawFilters === undefined) return [];
  if (!Array.isArray(rawFilters) || rawFilters.length > MAX_FILTERS) {
    return badRequest(ctx, `filters must be an array with at most ${MAX_FILTERS} items`);
  }

  const filters: Array<Record<string, unknown>> = [];
  for (const rawFilter of rawFilters as FilterInput[]) {
    if (!rawFilter || typeof rawFilter !== "object") {
      return badRequest(ctx, "Each filter must be an object");
    }

    const field = String(rawFilter.field || "") as FilterField;
    const definition = FILTER_FIELDS[field];
    if (!definition) {
      return badRequest(ctx, "Unsupported users-list filter field");
    }

    const operator = String(rawFilter.operator || "");
    const allowedOperators = definition.type === "boolean" ? BOOLEAN_OPERATORS : TEXT_OPERATORS;
    if (!allowedOperators.has(operator)) {
      return badRequest(ctx, "Unsupported users-list filter operator");
    }

    let value: unknown = true;
    if (!NULL_OPERATORS.has(operator)) {
      if (definition.type === "boolean") {
        if (rawFilter.value !== true && rawFilter.value !== false) {
          return badRequest(ctx, "Boolean filters require a boolean value");
        }
        value = rawFilter.value;
      } else {
        const textValue = String(rawFilter.value ?? "").trim();
        if (!textValue || textValue.length > MAX_SEARCH_LENGTH) {
          return badRequest(ctx, "Text filter values must contain 1 to 80 characters");
        }
        value = textValue;
      }
    }

    filters.push(nestedFilter(definition.path, operator, value));
  }

  return filters;
}

function parseSort(ctx: any, rawSort: unknown): { field: SortField; direction: Direction } | null {
  if (rawSort === undefined) return { field: "id", direction: "desc" };
  if (!rawSort || typeof rawSort !== "object" || Array.isArray(rawSort)) {
    return badRequest(ctx, "sort must be an object");
  }

  const sort = rawSort as Record<string, unknown>;
  const field = String(sort.field || "") as SortField;
  const direction = String(sort.direction || "").toLowerCase() as Direction;
  if (!SORT_FIELDS[field] || !["asc", "desc"].includes(direction)) {
    return badRequest(ctx, "Unsupported users-list sort");
  }
  return { field, direction };
}

function searchFilter(search: string): Record<string, unknown> {
  const words = search.split(/\s+/).filter(Boolean);
  const alternatives: Array<Record<string, unknown>> = [
    { phone: { $containsi: search } },
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

  return { $or: alternatives };
}

function projectSafeUser(user: any) {
  return {
    id: user.id,
    username: user.username ?? null,
    phone: user.phone ?? null,
    confirmed: user.confirmed === true,
    blocked: user.blocked === true,
    IsActive: user.IsActive !== false,
    IsVerified: user.IsVerified === true,
    removedAt: user.removedAt ?? null,
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
    user_info: user.user_info
      ? {
          id: user.user_info.id,
          FirstName: user.user_info.FirstName ?? null,
          LastName: user.user_info.LastName ?? null,
        }
      : null,
    user_role: user.user_role
      ? {
          id: user.user_role.id,
          Title: user.user_role.Title ?? null,
        }
      : null,
    role: user.role
      ? {
          id: user.role.id,
          name: user.role.name ?? null,
          type: user.role.type ?? null,
        }
      : null,
    user_wallet: user.user_wallet
      ? {
          id: user.user_wallet.id,
          Balance: user.user_wallet.Balance ?? 0,
        }
      : null,
  };
}

export default {
  async query(ctx) {
    const startedAt = Date.now();
    const body = (ctx.request?.body || {}) as UsersListBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return badRequest(ctx, "Request body must be an object");
    }

    const page = Math.min(positiveInteger(body.page, 1), MAX_PAGE);
    const pageSize = Math.min(positiveInteger(body.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const removed = body.removed === true;
    const managerRolesOnly = body.managerRolesOnly === true;
    const search = String(body.search ?? "").trim();
    if (search.length > MAX_SEARCH_LENGTH) {
      return badRequest(ctx, "search must contain at most 80 characters");
    }

    const filters = parseFilters(ctx, body.filters);
    if (!filters) return;
    const sort = parseSort(ctx, body.sort);
    if (!sort) return;

    const conditions: Array<Record<string, unknown>> = [
      { removedAt: removed ? { $notNull: true } : { $null: true } },
      ...filters,
    ];
    if (search) conditions.push(searchFilter(search));
    if (managerRolesOnly) {
      conditions.push({ role: { name: { $in: MANAGEMENT_ROLES } } });
    }

    const where = { $and: conditions };
    const orderBy =
      sort.field === "id"
        ? { id: sort.direction }
        : [{ [SORT_FIELDS[sort.field]]: sort.direction }, { id: sort.direction }];
    const userQuery = strapi.query("plugin::users-permissions.user");

    const [rows, total, recycleCount] = await Promise.all([
      userQuery.findMany({
        where,
        select: [
          "id",
          "username",
          "phone",
          "confirmed",
          "blocked",
          "IsActive",
          "IsVerified",
          "removedAt",
          "createdAt",
          "updatedAt",
        ],
        populate: {
          user_info: { select: ["id", "FirstName", "LastName"] },
          user_role: { select: ["id", "Title"] },
          role: { select: ["id", "name", "type"] },
          user_wallet: { select: ["id", "Balance"] },
        },
        orderBy,
        offset: (page - 1) * pageSize,
        limit: pageSize,
      }),
      userQuery.count({ where }),
      userQuery.count({ where: { removedAt: { $notNull: true } } }),
    ]);

    const schema = strapi.contentType("plugin::users-permissions.user");
    const sanitizedRows = await sanitize.contentAPI.output(rows, schema, {
      auth: ctx.state.auth,
    });
    const data = (sanitizedRows as any[]).map(projectSafeUser);

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data,
      meta: {
        pagination: {
          page,
          pageSize,
          pageCount: Math.ceil(total / pageSize),
          total,
        },
        recycleCount,
      },
    };

    strapi.log.info("admin users list completed", {
      durationMs: Date.now() - startedAt,
      page,
      pageSize,
      returned: data.length,
      total,
      removed,
      hasSearch: Boolean(search),
      filterCount: filters.length,
      managerRolesOnly,
      sortField: sort.field,
      sortDirection: sort.direction,
    });
  },
};
