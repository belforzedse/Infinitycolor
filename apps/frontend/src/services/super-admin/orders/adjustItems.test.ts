import { apiClient } from "@/services";
import { changeOrderStatus } from "./adjustItems";

jest.mock("@/services", () => ({
  apiClient: {
    post: jest.fn(),
    put: jest.fn(),
  },
}));

describe("changeOrderStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the guarded lifecycle endpoint for non-SnappPay orders", async () => {
    (apiClient.post as jest.Mock).mockResolvedValue({ data: { success: true } });

    await changeOrderStatus("41", "Shipment");

    expect(apiClient.post).toHaveBeenCalledWith("/orders/41/admin/transition", {
      status: "Shipment",
    });
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it("preserves the established generic update request for SnappPay orders", async () => {
    (apiClient.put as jest.Mock).mockResolvedValue({ data: { success: true } });

    await changeOrderStatus("42", "Started", true);

    expect(apiClient.put).toHaveBeenCalledWith("/orders/42", {
      data: { Status: "Started" },
    });
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
