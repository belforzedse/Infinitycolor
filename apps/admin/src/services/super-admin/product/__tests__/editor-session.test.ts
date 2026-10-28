jest.mock("@/services", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

import { apiClient } from "@/services";
import {
  ProductEditorSession,
  type ProductEditSnapshot,
} from "../editor-session";

const get = apiClient.get as jest.Mock;
const post = apiClient.post as jest.Mock;
const put = apiClient.put as jest.Mock;
const now = "2026-10-13T10:00:00.000Z";
const status = (owner: { id: number; label: string } | null = null) => ({
  owner,
  generation: 3,
  expiresAt: owner ? "2026-10-13T10:01:30.000Z" : null,
  serverNow: now,
  owned: false,
  leaseSeconds: 90,
  heartbeatSeconds: 30,
  pollSeconds: 10,
});
const snapshot = (revision = 7, title = "fresh") =>
  ({
    product: { id: 42, attributes: { Title: title } },
    revision,
  }) as ProductEditSnapshot;
const acquired = (revision = 8) => ({
  lease: {
    token: "memory-only-secret",
    generation: 4,
    editorInstanceId: "instance",
    expiresAt: "2026-10-13T10:01:30.000Z",
    serverNow: now,
  },
  snapshot: snapshot(revision),
});

describe("one product editor session", () => {
  let session: ProductEditorSession;
  const install = jest.fn();
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));
    jest.clearAllMocks();
    get.mockImplementation(async (url: string) => ({
      data: url.endsWith("edit-snapshot")
        ? snapshot(7, "stale")
        : session?.state.phase === "editing"
          ? { ...status({ id: 42, label: "مالک" }), generation: 4, owned: true }
          : status(),
    }));
    post.mockImplementation(async (url: string) => ({
      data:
        url.endsWith("acquire") || url.endsWith("takeover")
          ? acquired()
          : { released: true },
    }));
    session = new ProductEditorSession(42, install);
  });
  afterEach(() => {
    session.dispose();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("installs acquisition data before enabling writes instead of attaching proof to the earlier snapshot", async () => {
    install.mockImplementation(() =>
      expect(session.state.phase).not.toBe("editing"),
    );
    await session.open(true);
    expect(
      install.mock.calls.map(([value]) => value.product.attributes.Title),
    ).toEqual(["stale", "fresh"]);
    expect(session.state.phase).toBe("editing");
    put.mockResolvedValue({ data: {}, meta: { editRevision: 9 } });
    await session.client.put("/products/42/editor", { data: {} });
    expect(put).toHaveBeenCalledWith(
      "/products/42/editor",
      { data: {} },
      expect.objectContaining({
        retries: 0,
        headers: expect.objectContaining({
          "X-Product-Expected-Revision": "8",
        }),
      }),
    );
  });

  it("polls a busy product in read-only mode without renewing or acquiring it", async () => {
    install.mockReset();
    get.mockImplementation(async (url: string) => ({
      data: url.endsWith("edit-snapshot")
        ? snapshot()
        : status({ id: 5, label: "همکار" }),
    }));
    await session.open(true);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(session.state.phase).toBe("readonly");
    expect(post).not.toHaveBeenCalled();
    await expect(
      session.client.put("/products/42/editor", {}),
    ).rejects.toMatchObject({ errorCode: "EDIT_LEASE_LOST" });
    expect(put).not.toHaveBeenCalled();
  });

  it("explicit takeover discards old drafts only after receiving a fresh snapshot", async () => {
    install.mockReset();
    get.mockImplementation(async (url: string) => ({
      data: url.endsWith("edit-snapshot")
        ? snapshot()
        : status({ id: 5, label: "همکار" }),
    }));
    await session.open(true);
    session.drafts.set("variations", { sku: "unsaved" });
    post.mockResolvedValueOnce({ data: acquired(20) });
    await session.acquire(true, 3);
    expect(post).toHaveBeenCalledWith(
      "/products/42/edit-lease/takeover",
      expect.objectContaining({
        expectedGeneration: 3,
        editorInstanceId: session.editorInstanceId,
      }),
      { retries: 0 },
    );
    expect(session.drafts.size).toBe(0);
    expect(install).toHaveBeenLastCalledWith(snapshot(20));
  });

  it("sends the confirmed generation and returns the latest owner after a stale confirmation", async () => {
    install.mockReset();
    get.mockImplementation(async (url: string) => ({
      data: url.endsWith("edit-snapshot")
        ? snapshot()
        : status({ id: 5, label: "همکار" }),
    }));
    await session.open(true);
    session.drafts.set("variations", { sku: "unsaved" });

    const latestStatus = {
      ...status({ id: 9, label: "همکار جدید" }),
      generation: 4,
    };
    get.mockResolvedValue({ data: latestStatus });
    await session.readStatus();
    post.mockRejectedValueOnce({
      status: 409,
      details: { code: "EDIT_LEASE_CONFLICT" },
    });

    const result = await session.acquire(true, 3);

    expect(post).toHaveBeenCalledWith(
      "/products/42/edit-lease/takeover",
      expect.objectContaining({
        expectedGeneration: 3,
        editorInstanceId: session.editorInstanceId,
      }),
      { retries: 0 },
    );
    expect(result).toEqual({ outcome: "conflict", status: latestStatus });
    expect(session.state.status).toEqual(latestStatus);
    expect(session.state.phase).toBe("readonly");
    expect(session.drafts.get("variations")).toEqual({ sku: "unsaved" });
  });

  it("serializes requests and advances only the committed response revision", async () => {
    install.mockReset();
    await session.open(true);
    let resolveFirst!: (value: unknown) => void;
    put.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    put.mockResolvedValueOnce({
      data: { revision: 999 },
      meta: { editRevision: 10 },
    });
    const first = session.client.put("/product-variations/1", {});
    const second = session.client.put("/product-variations/2", {});
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
    resolveFirst({ data: { revision: 999 }, meta: { editRevision: 9 } });
    await Promise.all([first, second]);
    expect(put.mock.calls[1][2].headers["X-Product-Expected-Revision"]).toBe(
      "9",
    );
  });

  it.each([
    { status: 409, details: { code: "EDIT_LEASE_LOST" } },
    { status: 409, errorCode: "PRODUCT_VERSION_CONFLICT" },
    { status: 409, errorCode: "PRODUCT_STOCK_VERSION_CONFLICT" },
    { status: 0, message: "connection interrupted" },
  ])("freezes queued writes and preserves drafts after %p", async (error) => {
    install.mockReset();
    await session.open(true);
    session.drafts.set("size-guide", { rows: ["unsaved"] });
    put.mockRejectedValueOnce(error);
    const results = await Promise.allSettled([
      session.client.put("/products/42/editor", {}),
      session.client.put("/product-variations/2", {}),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    expect(session.state.phase).toBe("frozen");
    expect(session.drafts.get("size-guide")).toEqual({ rows: ["unsaved"] });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(
      post.mock.calls.filter(([url]) => url.endsWith("renew")),
    ).toHaveLength(0);
  });

  it("does not treat a returned data revision as committed proof when meta is missing", async () => {
    install.mockReset();
    await session.open(true);
    put.mockResolvedValue({ data: { revision: 9 } });
    await expect(
      session.client.put("/products/42/editor", {}),
    ).rejects.toMatchObject({ errorCode: "EDIT_RESULT_UNCERTAIN" });
    expect(session.state.phase).toBe("frozen");
  });

  it("polls ownership with proof every ten seconds and freezes before a stale heartbeat", async () => {
    install.mockReset();
    await session.open(true);
    get.mockResolvedValueOnce({
      data: {
        ...status({ id: 5, label: "همکار" }),
        generation: 5,
        owned: false,
      },
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(session.state.phase).toBe("frozen");
    expect(get).toHaveBeenLastCalledWith(
      "/products/42/edit-lease",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Product-Edit-Token": "memory-only-secret",
        }),
      }),
    );
    expect(get.mock.calls.at(-1)?.[1].headers).not.toHaveProperty(
      "X-Product-Expected-Revision",
    );
    expect(
      post.mock.calls.filter(([url]) => url.endsWith("renew")),
    ).toHaveLength(0);
  });

  it("freezes on renewal uncertainty", async () => {
    install.mockReset();
    await session.open(true);
    post.mockRejectedValueOnce({ status: 0 });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(session.state.phase).toBe("frozen");
    const renew = post.mock.calls.find(([url]) => url.endsWith("renew"));
    expect(renew?.[2]).toMatchObject({
      retries: 0,
      headers: { "X-Product-Edit-Token": "memory-only-secret" },
    });
  });

  it("freezes at expiry even when a pending renewal never answers", async () => {
    install.mockReset();
    await session.open(true);
    post.mockImplementationOnce(() => new Promise(() => undefined));
    await jest.advanceTimersByTimeAsync(90_000);
    expect(session.state.phase).toBe("frozen");
    await expect(
      session.client.put("/products/42/editor", {}),
    ).rejects.toMatchObject({ errorCode: "EDIT_LEASE_LOST" });
    expect(put).not.toHaveBeenCalled();
  });
});
