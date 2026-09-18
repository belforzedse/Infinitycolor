import { checkoutAttemptOrderId, existingAttemptBlocksReplacement, gateCheckoutResume } from "../checkout-resume";
import { resolveEligibleCheckoutHold } from "../checkout-hold";

jest.mock("../checkout-hold", () => {
  const actual = jest.requireActual("../checkout-hold");
  return {
    ...actual,
    resolveEligibleCheckoutHold: jest.fn().mockResolvedValue({ status: "missing" }),
  };
});

const mockedResolveHold = resolveEligibleCheckoutHold as jest.MockedFunction<
  typeof resolveEligibleCheckoutHold
>;

describe("existingAttemptBlocksReplacement", () => {
  it("does not replay a live attempt at a different payable quote", () => {
    expect(
      existingAttemptBlocksReplacement(
        {
          Status: "Redirected",
          Gateway: "snappay",
          quoteHash: "sha256:original",
        },
        "snappay",
        "sha256:after-discount",
      ),
    ).toBe("conflict");
  });

  it("still resumes when no new quote hash is presented", () => {
    expect(
      existingAttemptBlocksReplacement(
        {
          Status: "Redirected",
          Gateway: "snappay",
          quoteHash: "sha256:original",
        },
        "snappay",
        "",
      ),
    ).toBe("replay");
  });

  it("does not reuse an unresolved SnappPay generation for a different total", () => {
    expect(
      existingAttemptBlocksReplacement(
        {
          Status: "Redirected",
          Gateway: "snappay",
          quoteHash: "sha256:original",
          providerResponse: { tokenAttemptSeq: 1, tokenFingerprint: "fp" },
        },
        "snappay",
        "sha256:after-discount",
      ),
    ).toBe("conflict");
  });

  it("still conflicts a terminal attempt so a fresh checkout can start", () => {
    expect(
      existingAttemptBlocksReplacement(
        { Status: "Failed", Gateway: "snappay", quoteHash: "sha256:original" },
        "snappay",
        "sha256:original",
      ),
    ).toBe("conflict");
  });

  it("does not apply a different gateway to the original payment", () => {
    expect(
      existingAttemptBlocksReplacement(
        { Status: "Redirected", Gateway: "snappay", quoteHash: "sha256:original" },
        "mellat",
        "sha256:original",
      ),
    ).toBe("conflict");
  });

  it("does not apply a different gateway to an unresolved SnappPay generation", () => {
    expect(
      existingAttemptBlocksReplacement(
        {
          Status: "Redirected",
          Gateway: "snappay",
          quoteHash: "sha256:original",
          providerResponse: { tokenAttemptSeq: 1, tokenFingerprint: "fp" },
        },
        "mellat",
        "sha256:original",
      ),
    ).toBe("in_progress");
  });

  it("reads a populated order id from a replayed attempt", () => {
    expect(checkoutAttemptOrderId({ order: { id: 91 } })).toBe(91);
    expect(checkoutAttemptOrderId({ order: 111459 })).toBe(111459);
    expect(checkoutAttemptOrderId({ order: { id: 0 } })).toBeUndefined();
  });
});

describe("gateCheckoutResume", () => {
  beforeEach(() => {
    mockedResolveHold.mockReset();
    mockedResolveHold.mockResolvedValue({ status: "missing" });
  });

  it("replays a live same-gateway attempt when the identified hold is still held", async () => {
    mockedResolveHold.mockResolvedValue({
      status: "held",
      hold: {
        attemptId: "attempt-1",
        orderId: 91,
        quantitiesByStockId: new Map([[700, 1]]),
      },
    });

    await expect(
      gateCheckoutResume(
        {} as never,
        17,
        { Status: "Created", Gateway: "mellat", attemptId: "attempt-1" },
        "mellat",
      ),
    ).resolves.toBe("replay");
    expect(mockedResolveHold).toHaveBeenCalledWith({}, 17, "attempt-1");
  });

  it("does not resurrect an expired reservation as a replay", async () => {
    mockedResolveHold.mockResolvedValue({ status: "expired" });

    await expect(
      gateCheckoutResume(
        {} as never,
        17,
        { Status: "Created", Gateway: "mellat", attemptId: "attempt-1" },
        "mellat",
      ),
    ).resolves.toBe("expired");
  });

  it("defers resume when the reservation lookup throws instead of treating it as expired", async () => {
    mockedResolveHold.mockRejectedValue(new Error("temporary query failure"));

    await expect(
      gateCheckoutResume(
        {} as never,
        17,
        { Status: "Created", Gateway: "mellat", attemptId: "attempt-1" },
        "mellat",
      ),
    ).resolves.toBe("unavailable");
  });
});
