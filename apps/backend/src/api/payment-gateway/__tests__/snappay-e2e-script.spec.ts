/**
 * The deterministic end-to-end scripts, and the one they exist for.
 *
 * SnappPay has no sandbox CI can drive, so `not_found_then_ok` is how the
 * production case gets exercised end to end: a status read at +2 minutes
 * answers 1007, the shopper carries on, and the payment settles. 56 of 481
 * settled production attempts took that path in four days.
 */
import {
  resetSnappayE2EState,
  snappayE2EScript,
  snappayE2EStatus,
} from "../services/snappay-e2e";

beforeEach(() => {
  resetSnappayE2EState();
  delete process.env.SNAPPAY_E2E_STATUS_SCRIPT;
  delete process.env.NODE_ENV;
});

describe("snappayE2EScript", () => {
  it("is off unless explicitly asked for", () => {
    expect(snappayE2EScript({} as NodeJS.ProcessEnv)).toBeNull();
    expect(snappayE2EScript({ SNAPPAY_E2E_STATUS_SCRIPT: "" } as any)).toBeNull();
    // An unrecognised script is off, never a default.
    expect(snappayE2EScript({ SNAPPAY_E2E_STATUS_SCRIPT: "whatever" } as any)).toBeNull();
  });

  it("refuses to simulate payments in a production build", () => {
    expect(() =>
      snappayE2EScript({
        SNAPPAY_E2E_STATUS_SCRIPT: "not_found",
        NODE_ENV: "production",
      } as any),
    ).toThrow(/SNAPPAY_SIMULATION_REFUSED/);
  });

  it("accepts the three documented scripts", () => {
    for (const script of ["not_found", "not_found_then_ok", "registered"]) {
      expect(
        snappayE2EScript({ SNAPPAY_E2E_STATUS_SCRIPT: script, NODE_ENV: "test" } as any),
      ).toBe(script);
    }
  });
});

describe("the not_found_then_ok script", () => {
  it("answers 1007 first and only then reveals the payment", () => {
    const token = "E2E-token-1";
    const first = snappayE2EStatus("not_found_then_ok", token);
    expect(first.successful).toBe(false);
    expect(first.diagnostic.providerCode).toBe(1007);
    expect(first.diagnostic.httpStatus).toBe(404);

    // Still gone on the confirming read — which is exactly the trap: an
    // implementation that confirms on two 1007s without a token-age floor
    // cancels a customer who is still paying.
    expect(snappayE2EStatus("not_found_then_ok", token).diagnostic.providerCode).toBe(1007);

    expect(snappayE2EStatus("not_found_then_ok", token).response?.status).toBe("PENDING");
    expect(snappayE2EStatus("not_found_then_ok", token).response?.status).toBe("VERIFY");
  });

  it("tracks each token separately", () => {
    expect(snappayE2EStatus("not_found_then_ok", "a").successful).toBe(false);
    expect(snappayE2EStatus("not_found_then_ok", "a").successful).toBe(false);
    expect(snappayE2EStatus("not_found_then_ok", "a").successful).toBe(true);
    // A different token starts its own sequence.
    expect(snappayE2EStatus("not_found_then_ok", "b").successful).toBe(false);
  });
});

describe("the steady scripts", () => {
  it("keeps answering 1007 for not_found", () => {
    for (let index = 0; index < 5; index += 1) {
      expect(snappayE2EStatus("not_found", "t").diagnostic.providerCode).toBe(1007);
    }
  });

  it("keeps answering REGISTERED for registered", () => {
    for (let index = 0; index < 5; index += 1) {
      expect(snappayE2EStatus("registered", "t").response?.status).toBe("REGISTERED");
    }
  });
});
