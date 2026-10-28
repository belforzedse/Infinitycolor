import { apiClient } from "@/services";
import { getProductTitleKeywords } from "../title-keywords";

jest.mock("@/services", () => ({
  apiClient: {
    get: jest.fn(),
  },
}));

const mockedGet = jest.mocked(apiClient.get);

describe("getProductTitleKeywords", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("requests the dictionary and returns its keywords", async () => {
    mockedGet.mockResolvedValue({
      data: {
        keywords: ["شومیز", "نخی"],
      },
    });

    await expect(getProductTitleKeywords()).resolves.toEqual(["شومیز", "نخی"]);

    expect(mockedGet).toHaveBeenCalledWith("/products/title-keywords", {
      cache: "no-store",
      retries: 0,
    });
  });

  it("propagates a request failure", async () => {
    const error = new Error("Request failed");
    mockedGet.mockRejectedValue(error);

    await expect(getProductTitleKeywords()).rejects.toThrow(error);
  });
});
