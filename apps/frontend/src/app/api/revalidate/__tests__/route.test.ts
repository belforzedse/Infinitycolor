const mockRevalidatePath = jest.fn();
const mockRevalidateTag = jest.fn();

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
  revalidateTag: (...args: unknown[]) => mockRevalidateTag(...args),
}));
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, options?: { status?: number }) => ({
      status: options?.status ?? 200,
      json: async () => body,
    }),
  },
}));

import { buildCategoryPath, POST } from "../route";

describe("category editorial revalidation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REVALIDATION_SECRET = "test-secret";
  });

  it("normalizes encoded Persian category paths", () => {
    expect(buildCategoryPath("%D8%B1%D9%88%D8%B3%D8%B1%DB%8C")).toBe(
      "/plp/category/%D8%B1%D9%88%D8%B3%D8%B1%DB%8C",
    );
  });

  it("invalidates only the exact path and category tag", async () => {
    const request = {
      headers: { get: (name: string) => (name === "authorization" ? "Bearer test-secret" : null) },
      json: async () => ({ type: "category-editorial", slug: "روسری" }),
    };
    const response = await POST(request as any);
    expect(response.status).toBe(200);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/plp/category/%D8%B1%D9%88%D8%B3%D8%B1%DB%8C");
    expect(mockRevalidateTag).toHaveBeenCalledWith("category:slug:روسری", "max");
  });
});
