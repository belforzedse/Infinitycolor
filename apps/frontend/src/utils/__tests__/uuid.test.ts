import { generateUuidV4 } from "../uuid";

// Mirrors apps/backend/src/api/issue-report/services/issue-report.ts and
// apps/backend/src/api/model-application/services/model-application.ts:
// submissionId is rejected unless it matches this shape exactly.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateUuidV4", () => {
  const originalRandomUUID = globalThis.crypto.randomUUID;

  afterEach(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUUID,
    });
  });

  it("uses crypto.randomUUID when available", () => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: jest.fn(() => "c7150e5a-8dbb-4a73-9742-8c33ee3a61b7"),
    });

    expect(generateUuidV4()).toBe("c7150e5a-8dbb-4a73-9742-8c33ee3a61b7");
  });

  it("falls back to a backend-valid v4 UUID when randomUUID is missing (WebViews without it)", () => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });

    const id = generateUuidV4();
    expect(id).toMatch(UUID_PATTERN);
  });
});
