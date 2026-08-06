import type { AdvancedFilterItem } from "@/components/SuperAdmin/Table/advancedFilters";
import type { User } from "@/app/(admin)/users/table";
import { apiClient } from "@/services";

export const ADMIN_USERS_LIST_ENDPOINT = "/admin/users-list/query";

const BOOLEAN_FILTER_FIELDS = new Set(["[blocked]", "[confirmed]"]);

function normalizeFilters(filters: AdvancedFilterItem[]) {
  return filters.map((filter) => ({
    ...filter,
    value: BOOLEAN_FILTER_FIELDS.has(filter.field)
      ? filter.value === "true"
      : filter.value,
  }));
}

export type AdminUsersListInput = {
  page: number;
  pageSize: number;
  removed: boolean;
  search?: string;
  managerRolesOnly?: boolean;
  filters?: AdvancedFilterItem[];
  sort?: {
    field: "id" | "createdAt" | "phone";
    direction: "asc" | "desc";
  };
  signal?: AbortSignal;
};

export type AdminUsersListMeta = {
  pagination: {
    page: number;
    pageSize: number;
    pageCount: number;
    total: number;
  };
  recycleCount: number;
};

export type AdminUsersListResponse = {
  data: User[];
  meta: AdminUsersListMeta;
};

export async function listAdminUsers(
  input: AdminUsersListInput,
): Promise<AdminUsersListResponse> {
  const response = await apiClient.post<User[]>(
    ADMIN_USERS_LIST_ENDPOINT,
    {
      page: input.page,
      pageSize: input.pageSize,
      removed: input.removed,
      search: input.search?.trim() || undefined,
      managerRolesOnly: input.managerRolesOnly === true,
      filters: normalizeFilters(input.filters ?? []),
      sort: input.sort ?? { field: "id", direction: "desc" },
    },
    {
      signal: input.signal,
      retries: 0,
      timeout: 20_000,
    },
  );

  const typed = response as unknown as AdminUsersListResponse;
  return {
    data: Array.isArray(typed.data) ? typed.data : [],
    meta: typed.meta,
  };
}
