type BlogListPaginationInput = {
  page?: unknown;
  pageSize?: unknown;
  start?: unknown;
  limit?: unknown;
};

export type BlogListPagination = {
  page: number;
  pageSize: number;
  start: number;
  limit: number;
};

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * REST accepts page/pageSize pagination, while Entity Service findMany expects
 * start/limit. Passing the REST object straight through makes Entity Service
 * ignore it and return the entire collection.
 */
export function normalizeBlogListPagination(
  input: BlogListPaginationInput | null | undefined,
): BlogListPagination {
  const pagination = input || {};
  const usesOffset = pagination.start !== undefined || pagination.limit !== undefined;

  if (usesOffset) {
    const start = nonNegativeInteger(pagination.start, 0);
    const limit = positiveInteger(pagination.limit, 25);
    return {
      page: Math.floor(start / limit) + 1,
      pageSize: limit,
      start,
      limit,
    };
  }

  const page = positiveInteger(pagination.page, 1);
  const pageSize = positiveInteger(pagination.pageSize, 25);
  return {
    page,
    pageSize,
    start: (page - 1) * pageSize,
    limit: pageSize,
  };
}
