jest.mock("@/services", () => ({
  apiClient: { post: jest.fn() },
}));

import { apiClient } from "@/services";
import { ADMIN_USERS_LIST_ENDPOINT, listAdminUsers } from "../list";

const mockPost = apiClient.post as jest.Mock;

describe("admin users-list service", () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it("keeps search/filter PII in a non-retried POST body", async () => {
    mockPost.mockResolvedValue({
      data: [{ id: "1", phone: "+989120000000" }],
      meta: {
        pagination: { page: 1, pageSize: 25, pageCount: 1, total: 1 },
        recycleCount: 0,
      },
    });
    const controller = new AbortController();

    const result = await listAdminUsers({
      page: 1,
      pageSize: 25,
      removed: false,
      search: "Synthetic Person",
      managerRolesOnly: true,
      filters: [{ field: "[phone]", operator: "$startsWith", value: "+98912" }],
      signal: controller.signal,
    });

    expect(ADMIN_USERS_LIST_ENDPOINT).toBe("/admin/users-list/query");
    expect(ADMIN_USERS_LIST_ENDPOINT).not.toContain("Synthetic");
    expect(ADMIN_USERS_LIST_ENDPOINT).not.toContain("+98912");
    expect(mockPost).toHaveBeenCalledWith(
      "/admin/users-list/query",
      expect.objectContaining({
        page: 1,
        pageSize: 25,
        removed: false,
        search: "Synthetic Person",
        managerRolesOnly: true,
        filters: [
          { field: "[phone]", operator: "$startsWith", value: "+98912" },
        ],
        sort: { field: "id", direction: "desc" },
      }),
      { signal: controller.signal, retries: 0, timeout: 20_000 },
    );
    expect(result.meta.pagination.total).toBe(1);
  });

  it("normalizes boolean filter values for the backend contract", async () => {
    mockPost.mockResolvedValue({
      data: [],
      meta: {
        pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 },
        recycleCount: 0,
      },
    });

    await listAdminUsers({
      page: 1,
      pageSize: 25,
      removed: false,
      filters: [
        { field: "[blocked]", operator: "$eq", value: "true" },
        { field: "[confirmed]", operator: "$eq", value: "false" },
      ],
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/admin/users-list/query",
      expect.objectContaining({
        filters: [
          { field: "[blocked]", operator: "$eq", value: true },
          { field: "[confirmed]", operator: "$eq", value: false },
        ],
      }),
      expect.any(Object),
    );
  });
});
