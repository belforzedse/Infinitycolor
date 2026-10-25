jest.mock("@/utils/fetchWithTimeout", () => ({ __esModule: true, default: jest.fn() }));

import fetchWithTimeout from "@/utils/fetchWithTimeout";
import { getProductVariationColors } from "../variationAttributes";

describe("color catalog relation identity", () => {
  beforeEach(() => jest.mocked(fetchWithTimeout).mockReset());

  it("retains duplicate-title IDs across catalog pages", async () => {
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        data: [{ id: 11, attributes: { Title: "آبی", ColorCode: "#00f" } }],
        meta: { pagination: { pageCount: 2 } },
      }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        data: [
          { id: 12, Title: "آبی", ColorCode: "#00f" },
          { id: 13, Title: "قرمز", ColorCode: "#f00" },
        ], meta: { pagination: { pageCount: 2 } },
      }) } as Response);
    expect(await getProductVariationColors()).toEqual([
      { title: "آبی", colorCode: "#00f", ids: [11, 12] },
      { title: "قرمز", colorCode: "#f00", ids: [13] },
    ]);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("retains title semantics when any matching relation lacks a trustworthy ID", async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValue({ ok: true, json: async () => ({
      data: [
        { id: 11, Title: "آبی" }, { Title: "آبی" }, { id: 12, Title: "آبی" },
        { id: 13, Title: " قرمز " }, { id: 14, Title: "قرمز" },
      ],
    }) } as Response);
    expect(await getProductVariationColors()).toEqual([
      { title: "آبی", colorCode: null }, { title: "قرمز", colorCode: null },
    ]);
  });
});
