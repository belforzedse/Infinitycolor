jest.mock("@/services", () => ({
  apiClient: { get: jest.fn(), post: jest.fn() },
}));

import { apiClient } from "@/services";
import {
  ADMIN_DASHBOARD_SUMMARY_ENDPOINT,
  getAdminDashboardSummary,
} from "../dashboard/summary";
import {
  ADMIN_ORDERS_COUNTS_ENDPOINT,
  ADMIN_ORDERS_LIST_ENDPOINT,
  ADMIN_ORDERS_SHIPPING_METHODS_ENDPOINT,
  getAdminOrderCounts,
  listAdminOrders,
  listAdminShippingMethods,
} from "../orders/list";
import {
  ADMIN_PRODUCTS_LIST_ENDPOINT,
  listAdminProducts,
} from "../product/list";

const mockPost = apiClient.post as jest.Mock;
const mockGet = apiClient.get as jest.Mock;

describe("bounded admin read services", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("loads the dashboard through one private POST contract", async () => {
    const summary = {
      metrics: {
        ordersTotal: 1,
        doneOrdersTotal: 1,
        activeProductsTotal: 1,
        customerAccountsTotal: 1,
      },
      todayOrderCounts: {
        all: 1,
        paying: 0,
        inprogress: 0,
        completed: 1,
        cancelled: 0,
      },
      activeReserveGroups: 0,
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

  it("loads filter-aware order counts through a private POST body", async () => {
    const counts = {
      counts: {
        all: 8,
        paying: 1,
        inprogress: 3,
        completed: 3,
        cancelled: 1,
        manual: 2,
      },
      activeReserveGroups: 2,
    };
    mockPost.mockResolvedValue({ data: counts });
    const controller = new AbortController();

    await expect(
      getAdminOrderCounts({
        search: "synthetic-private-id",
        shippingMethodCodes: ["post"],
        filters: [{ field: "[Description]", operator: "$containsi", value: "ویژه" }],
        signal: controller.signal,
      }),
    ).resolves.toEqual(counts);
    expect(mockPost).toHaveBeenCalledWith(
      ADMIN_ORDERS_COUNTS_ENDPOINT,
      {
        search: "synthetic-private-id",
        shippingMethodCodes: ["post"],
        filters: [{ field: "[Description]", operator: "$containsi", value: "ویژه" }],
      },
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

  it("loads shipping-method filter options through the private order-read route", async () => {
    const methods = [
      { code: "post", title: "پست" },
      { code: "tipax", title: "تیپاکس" },
    ];
    mockGet.mockResolvedValue({ data: methods });
    const controller = new AbortController();

    await expect(listAdminShippingMethods(controller.signal)).resolves.toEqual(methods);
    expect(mockGet).toHaveBeenCalledWith(
      ADMIN_ORDERS_SHIPPING_METHODS_ENDPOINT,
      { signal: controller.signal, retries: 0, timeout: 20_000 },
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
