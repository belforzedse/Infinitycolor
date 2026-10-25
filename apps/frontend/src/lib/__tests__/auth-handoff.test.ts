import { AuthHandoffError, updateRouteHint, withTransientAuthRetry } from "@repo/auth-core/browser";

describe("auth handoff recovery", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("retries temporary failures and eventually succeeds", async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new AuthHandoffError("unavailable", 503))
      .mockResolvedValue("ok");

    const result = withTransientAuthRetry(operation);
    await jest.advanceTimersByTimeAsync(400);

    await expect(result).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry invalid credentials", async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValue(new AuthHandoffError("unauthorized", 401));

    await expect(withTransientAuthRetry(operation)).rejects.toMatchObject({ status: 401 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rejects a route hint response that was not persisted", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 403 } as Response);

    await expect(updateRouteHint("PUT", fetchImpl)).rejects.toMatchObject({ status: 403 });
  });

  it("settles the deadline even when fetch ignores cancellation", async () => {
    let rejectFetch!: (error: Error) => void;
    const fetchImpl = jest.fn<typeof fetch>(() => new Promise((_resolve, reject) => { rejectFetch = reject; }));
    let failure: unknown;
    const pending = updateRouteHint("PUT", fetchImpl).catch((error) => {
      failure = error;
    });

    await jest.advanceTimersByTimeAsync(5_000);

    expect(failure).toMatchObject({
      name: "AuthHandoffError",
      status: 503,
      reasonCode: "timeout",
    });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await pending;
    rejectFetch(new DOMException("late rejection", "AbortError"));
    await Promise.resolve();
  });

  it("returns a typed transport failure without hiding HTTP rejection", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockRejectedValue(new TypeError("private URL"));

    await expect(updateRouteHint("DELETE", fetchImpl)).rejects.toMatchObject({
      name: "AuthHandoffError",
      status: 503,
      reasonCode: "network",
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
