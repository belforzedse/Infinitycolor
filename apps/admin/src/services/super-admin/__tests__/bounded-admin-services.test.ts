jest.mock("@/services", () => ({
  apiClient: { post: jest.fn() },
}));

import { apiClient } from "@/services";
import {
  ADMIN_DASHBOARD_SUMMARY_ENDPOINT,
  getAdminDashboardSummary,
} from "../dashboard/summary";
import { ADMIN_ORDERS_LIST_ENDPOINT, listAdminOrders } from "../orders/list";
import {
  ADMIN_PRODUCTS_LIST_ENDPOINT,
  listAdminProducts,
} from "../product/list";

const mockPost = apiClient.post as jest.Mock;

describe("bounded admin read services", () => {
  beforeEach(() => mockPost.mockReset());

  it("loads the dashboard through one private POST contract", async () => {
    const summary = {
      metrics: {
        ordersTotal: 1,
        doneOrdersTotal: 1,
        activeProductsTotal: 1,
        customerAccountsTotal: 1,
      },
      latestOrders: [],
      latestOrdersAmount: 0,
    };
    mockPost.mockResolvedValue({ data: summary });
    const controller = new AbortController();

    await expect(getAdminDashboardSummary(controller.signal)).resolves.toEqual(
      summary,
    );
    expect(mockPost).toHaveBeenCalledWith(
      ADMIN_DASHBOARD_SUMMARY_ENDPOINT,
      {},
      { signal: controller.signal, retries: 0, timeout: 20_000 },
    );
  });

  it("keeps order search and filters out of URLs", async () => {
    mockPost.mockResolvedValue({
      data: [],
      meta: { pagination: { page: 1, pageSize: 25, pageCount: 0, total: 0 } },
    });
    await listAdminOrders({
      page: 1,
      pageSize: 25,
      tab: "all",
      sort: "last-edited",
      search: "synthetic-private-id",
      filters: [
        {
          field: "[user][phone]",
          operator: "$containsi",
          value: "synthetic-phone",
        },
      ],
    });

    expect(ADMIN_ORDERS_LIST_ENDPOINT).toBe("/admin/orders-list/query");
    expect(ADMIN_ORDERS_LIST_ENDPOINT).not.toContain("synthetic");
    expect(mockPost).toHaveBeenCalledWith(
      ADMIN_ORDERS_LIST_ENDPOINT,
      expect.objectContaining({
        search: "synthetic-private-id",
        filters: [
          {
            field: "[user][phone]",
            operator: "$containsi",
            value: "synthetic-phone",
          },
        ],
      }),
      expect.objectContaining({ retries: 0 }),
    );
  });

  it("uses the same bounded product contract for server-side custom sorts", async () => {
    mockPost.mockResolvedValue({
      data: [],
      meta: {
        pagination: { page: 2, pageSize: 25, pageCount: 3, total: 60 },
        recycleCount: 4,
      },
    });
    await listAdminProducts({
      page: 2,
      pageSize: 25,
      removed: false,
      sort: "stock-desc",
      search: "synthetic-product",
    });

    expect(ADMIN_PRODUCTS_LIST_ENDPOINT).toBe("/admin/products-list/query");
    expect(mockPost).toHaveBeenCalledWith(
      ADMIN_PRODUCTS_LIST_ENDPOINT,
      expect.objectContaining({
        page: 2,
        pageSize: 25,
        removed: false,
        sort: "stock-desc",
        search: "synthetic-product",
      }),
      expect.objectContaining({ retries: 0 }),
    );
  });
});
