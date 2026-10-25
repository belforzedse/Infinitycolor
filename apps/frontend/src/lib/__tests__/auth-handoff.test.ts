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

  it("distinguishes a transport failure from an HTTP rejection", async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockRejectedValue(new TypeError("private URL"));
    await expect(updateRouteHint("DELETE", fetchImpl)).rejects.toMatchObject({
      name: "AuthHandoffError", status: 503, reasonCode: "network",
    });
    expect(jest.getTimerCount()).toBe(0);
  });

});
