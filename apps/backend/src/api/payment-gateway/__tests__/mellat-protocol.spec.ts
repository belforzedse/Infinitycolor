import { createHash } from "crypto";
import {
  mellatAmountIrr,
  mellatLocalDateTime,
  mellatLong,
  mellatTerminalFingerprint,
  parseMellatReturn,
} from "../services/mellat-v3";

describe("Mellat protocol values", () => {
  it.each([
    ["2026-01-01T20:34:05Z", "20260102", "000405"],
    ["2026-03-21T00:00:00Z", "20260321", "033000"],
    ["2026-07-01T20:31:02Z", "20260702", "000102"],
    ["2026-12-31T21:35:07Z", "20270101", "010507"],
  ])("uses zero-padded Tehran local date/time for %s", (iso, localDate, localTime) => {
    expect(mellatLocalDateTime(new Date(iso))).toEqual({ localDate, localTime });
  });

  it("preserves exact signed-long IDs beyond JavaScript's integer precision", () => {
    expect(mellatLong("9007199254740993")).toBe("9007199254740993");
    expect(mellatLong("9223372036854775807")).toBe("9223372036854775807");
    expect(mellatLong("000123")).toBe("123");
    expect(mellatLong(123)).toBe("123");
    expect(mellatLong(0, true)).toBe("0");
  });

  it.each([null, undefined, {}, true, "", "1.0", "1e4", "1 ", "-1", "0", "9223372036854775808", 9007199254740992])(
    "rejects noncanonical or out-of-range identifier %s", (value) => {
      expect(() => mellatLong(value)).toThrow("Invalid Mellat identifier");
    },
  );

  it("converts once and permits only safe positive integer IRR", () => {
    expect(mellatAmountIrr(1000)).toBe(10000);
    expect(mellatAmountIrr(10000, true)).toBe(10000);
    expect(mellatAmountIrr(Number.MAX_SAFE_INTEGER, true)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => mellatAmountIrr(Number.MAX_SAFE_INTEGER)).toThrow();
    expect(() => mellatAmountIrr("100" as any)).toThrow();
  });

  it("fingerprints only trimmed terminal identity and never the password", () => {
    process.env.MELLAT_TERMINAL_ID = " 123 ";
    process.env.MELLAT_USERNAME = " merchant ";
    process.env.MELLAT_PASSWORD = "first-password";
    const first = mellatTerminalFingerprint();
    expect(first).toBe(createHash("sha256").update("123|merchant").digest("hex"));
    process.env.MELLAT_PASSWORD = "second-password";
    expect(mellatTerminalFingerprint()).toBe(first);
    process.env.MELLAT_USERNAME = "another-merchant";
    expect(mellatTerminalFingerprint()).not.toBe(first);
  });

  it("accepts only 0 plus an exact nonempty RefId for pay success", () => {
    expect(parseMellatReturn({ return: "0,aBcD123" }, true)).toEqual({
      valid: true, resCode: 0, rawResCode: "0", refId: "aBcD123",
    });
    expect(parseMellatReturn({ return: "17" }, true)).toEqual({ valid: true, resCode: 17, rawResCode: "17" });
  });

  it.each(["", " 0", "0 ", "+0", "00", "0x0", "1e2", "NaN", "Infinity", "-1", "9007199254740992"])(
    "rejects malformed response code %s", (raw) => {
      expect(parseMellatReturn({ return: raw }).valid).toBe(false);
    },
  );

  it.each(["0", "0,", "0, ", "0,ref,extra", "0, ref", "0,ref\n", "0,ref\u0000", "17,ref"])(
    "rejects malformed pay fields %s", (raw) => {
      expect(parseMellatReturn({ return: raw }, true).valid).toBe(false);
    },
  );

  it.each(["0", "43", "45", "48", "421"])("retains raw transaction code %s", (raw) => {
    expect(parseMellatReturn({ return: raw })).toEqual({ valid: true, resCode: Number(raw), rawResCode: raw });
  });

  it.each([undefined, [], { return: null }, { return: 0 }, { return: ["0"] }, { RefId: "ref" }])(
    "rejects non-string SOAP return %j", (response) => {
      expect(parseMellatReturn(response)).toEqual({ valid: false });
    },
  );
});
