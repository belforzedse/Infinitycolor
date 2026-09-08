import controller from "../controllers/issue-report";
import { requireCapability } from "../../../utils/adminAuthorization";
import { queryIssueReports } from "../services/issue-report";

jest.mock("../../../utils/adminAuthorization", () => ({ requireCapability: jest.fn() }));
jest.mock("../services/issue-report", () => ({
  ...jest.requireActual("../services/issue-report"),
  queryIssueReports: jest.fn(),
}));

describe("issue report admin query", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).strapi = {};
    (requireCapability as jest.Mock).mockResolvedValue(true);
    (queryIssueReports as jest.Mock).mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
  });

  it("accepts the shared client's cache buster without passing it to report filters", async () => {
    const ctx: any = { query: { limit: "25", _cb: "1788897236387", from: "2026-09-08" }, set: jest.fn() };
    await controller.query(ctx);
    expect(ctx.body.data.items).toEqual([]);
    expect(queryIssueReports).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 25, from: "2026-09-08" }));
    expect((queryIssueReports as jest.Mock).mock.calls[0][1]).not.toHaveProperty("_cb");
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("still rejects unknown filters", async () => {
    const ctx: any = { query: { _cb: "123", unexpected: "value" }, set: jest.fn() };
    await controller.query(ctx);
    expect(ctx.status).toBe(400);
    expect(queryIssueReports).not.toHaveBeenCalled();
  });

  it("still requires report management access", async () => {
    (requireCapability as jest.Mock).mockResolvedValue(false);
    await controller.query({ query: { _cb: "123" }, set: jest.fn() });
    expect(queryIssueReports).not.toHaveBeenCalled();
  });
});
