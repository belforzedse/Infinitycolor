jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), put: jest.fn() },
}));

import { apiClient } from "@/lib/api-client";
import {
  getCategoryEditorial,
  listCategoryEditorialTargets,
  saveCategoryEditorial,
} from "../categoryEditorial";

describe("category editorial admin service", () => {
  beforeEach(() => jest.clearAllMocks());

  it("uses only the bounded category editorial endpoints", async () => {
    (apiClient.get as jest.Mock)
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: { category: { id: 4 }, editorial: null },
      });
    await listCategoryEditorialTargets({ q: "روسری" });
    await getCategoryEditorial(4);
    expect(apiClient.get).toHaveBeenNthCalledWith(
      1,
      "/category-editorial/targets?page=1&pageSize=50&q=%D8%B1%D9%88%D8%B3%D8%B1%DB%8C",
    );
    expect(apiClient.get).toHaveBeenNthCalledWith(2, "/category-editorial/4", {
      cache: "no-store",
    });
  });

  it("sends the optimistic timestamp and never calls generic CRUD", async () => {
    (apiClient.put as jest.Mock).mockResolvedValue({ data: {} });
    await saveCategoryEditorial(
      4,
      {
        title: "راهنما",
        paragraph: "مقدمه",
        content: "<p>متن</p>",
        isPublished: true,
        isRtl: true,
      },
      "2026-09-08T08:00:00.000Z",
    );
    expect(apiClient.put).toHaveBeenCalledWith("/category-editorial/4", {
      data: {
        Title: "راهنما",
        Paragraph: "مقدمه",
        Content: "<p>متن</p>",
        IsPublished: true,
        IsRTL: true,
      },
      expectedUpdatedAt: "2026-09-08T08:00:00.000Z",
    });
  });
});
