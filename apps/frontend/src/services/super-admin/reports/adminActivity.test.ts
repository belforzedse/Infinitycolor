import { apiClient } from "@/services";
import { getAdminActivity } from "./adminActivity";

jest.mock("@/services", () => ({
  apiClient: {
    get: jest.fn(),
  },
}));

const getMock = apiClient.get as jest.Mock;

describe("admin activity report service", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it("sends resource search and scope filters", async () => {
    getMock.mockResolvedValueOnce({ data: [], meta: { pagination: { total: 0 } } });

    await getAdminActivity({
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-31T00:00:00.000Z",
      resourceSearch: "SKU-100",
      resourceScope: "product",
      page: 1,
      pageSize: 100,
    });

    const calledUrl = getMock.mock.calls[0][0] as string;
    const url = new URL(calledUrl, "https://test.invalid");
    expect(url.pathname).toBe("/reports/admin-activity");
    expect(url.searchParams.get("resourceSearch")).toBe("SKU-100");
    expect(url.searchParams.get("resourceScope")).toBe("product");
  });
});
