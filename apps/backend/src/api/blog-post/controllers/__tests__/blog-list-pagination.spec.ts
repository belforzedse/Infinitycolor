import { normalizeBlogListPagination } from "../blog-list-pagination";

describe("normalizeBlogListPagination", () => {
  it("converts REST page pagination to Entity Service start/limit", () => {
    expect(normalizeBlogListPagination({ page: "3", pageSize: "8" })).toEqual({
      page: 3,
      pageSize: 8,
      start: 16,
      limit: 8,
    });
  });

  it("preserves offset pagination and reports matching response metadata", () => {
    expect(normalizeBlogListPagination({ start: "40", limit: "20" })).toEqual({
      page: 3,
      pageSize: 20,
      start: 40,
      limit: 20,
    });
  });

  it("falls back to the bounded API defaults for malformed input", () => {
    expect(normalizeBlogListPagination({ page: 0, pageSize: "nope" })).toEqual({
      page: 1,
      pageSize: 25,
      start: 0,
      limit: 25,
    });
  });
});
