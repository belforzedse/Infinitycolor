import {
  getActiveReserve,
  getMyReserveGroup,
  getMyReserveGroups,
  releaseReserve,
} from "../reserve";
import { apiClient } from "../../index";

jest.mock("../../index", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockGet = apiClient.get as jest.Mock;
const mockPost = apiClient.post as jest.Mock;

/**
 * Regression cover for a double-unwrap that took the whole customer-facing
 * reserve feature down in production while every component test stayed green.
 *
 * `apiClient` resolves to the RAW parsed body, and types it as
 * ApiResponse<T> = { data: T }. These services used to pass the envelope type as
 * the generic and then unwrap `.data` a second time, so callers doing the
 * documented `result.data` got `undefined` -- the attach card silently vanished,
 * the reserve-groups panel rendered empty, and the group page 404'd.
 *
 * The component suites mocked the service at the CORRECT (envelope) shape, so
 * they never saw it. These tests assert the seam itself: given a real API body,
 * the service must hand back that body unchanged.
 */
describe("reserve services return the API envelope unchanged", () => {
  beforeEach(() => jest.clearAllMocks());

  it("getActiveReserve preserves the { data } wrapper for an open group", async () => {
    const body = {
      data: {
        reserveGroupId: "f7efd60a-bf21-44b7-ab4a-cc0ac5a00fe8",
        reserveExpiresAt: "2026-09-11T20:10:41.037Z",
        orders: [],
        orderCount: 1,
        shippingCostPaid: 150000,
        shippingMethodTitle: "ارسال با پست",
        deliveryAddress: null,
        lastOrderAttachedAt: null,
        rootOrderId: 103639,
      },
    };
    mockGet.mockResolvedValue(body);

    const result = await getActiveReserve();

    // suppressAuthRedirect matters: a 401 on this unprompted side-fetch must not
    // bounce the shopper to central login and discard the checkout form.
    expect(mockGet).toHaveBeenCalledWith("/orders/active-reserve", {
      suppressAuthRedirect: true,
    });
    // The contract Bill relies on: `res?.data?.reserveGroupId` must resolve.
    expect(result.data?.reserveGroupId).toBe("f7efd60a-bf21-44b7-ab4a-cc0ac5a00fe8");
    expect(result).toEqual(body);
  });

  it("getActiveReserve preserves an explicit null payload", async () => {
    mockGet.mockResolvedValue({ data: null });
    await expect(getActiveReserve()).resolves.toEqual({ data: null });
  });

  it("getMyReserveGroups preserves the wrapper and its pagination meta", async () => {
    const body = {
      data: [{ reserveGroupId: "g1", state: "Active" }],
      meta: { pagination: { page: 1, pageSize: 50, pageCount: 1, total: 1 } },
    };
    mockGet.mockResolvedValue(body);

    const result = await getMyReserveGroups(1, 50);

    // ReserveGroupsPanel does `response.data ?? []` -- an unwrapped payload
    // would silently render an empty panel rather than throwing.
    expect(result.data).toHaveLength(1);
    expect(result.meta?.pagination?.total).toBe(1);
  });

  it("getMyReserveGroup preserves the wrapper and encodes the key", async () => {
    mockGet.mockResolvedValue({ data: { reserveGroupId: "a/b" } });

    const result = await getMyReserveGroup("a/b");

    expect(mockGet).toHaveBeenCalledWith("/orders/reserve-groups/a%2Fb");
    expect(result.data?.reserveGroupId).toBe("a/b");
  });

  it("releaseReserve preserves the wrapper", async () => {
    mockPost.mockResolvedValue({
      data: { success: true, message: "ok", orderCount: 2 },
    });

    const result = await releaseReserve(103639);

    expect(mockPost).toHaveBeenCalledWith("/orders/103639/release-reserve");
    expect(result.data.success).toBe(true);
    expect(result.data.orderCount).toBe(2);
  });
});
