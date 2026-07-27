import { classifyHighEndUserAgent, resolveHighEndUserAgentAdmission } from "../high-end-user-agent";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36";

describe("high-end user-agent promotion admission", () => {
  it.each([
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
      undefined,
      "apple-iphone",
    ],
    [ANDROID_UA.replace("; K)", "; Pixel 10 Pro XL)"), undefined, "google-pixel-pro"],
    [ANDROID_UA.replace("; K)", "; SM-S928B Build/UP1A)"), undefined, "samsung-galaxy-s"],
    [ANDROID_UA.replace("; K)", "; SM-F966U1 Build/AP3A)"), undefined, "samsung-galaxy-foldable"],
    [ANDROID_UA.replace("; K)", "; CPH2653 Build/AP3A)"), undefined, "oneplus-flagship"],
    [ANDROID_UA.replace("; K)", "; Xiaomi 15 Ultra Build/AQ3A)"), undefined, "xiaomi-ultra"],
  ])("admits a researched high-end family", (userAgent, model, family) => {
    expect(classifyHighEndUserAgent({ userAgent, model })).toEqual({
      eligible: true,
      family,
      source: "user-agent",
    });
  });

  it.each([
    "",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    ANDROID_UA,
    ANDROID_UA.replace("; K)", "; Pixel 8a)"),
    ANDROID_UA.replace("; K)", "; SM-A566B)"),
    ANDROID_UA.replace("; K)", "; Galaxy S22 Ultra)"),
  ])("rejects absent, generic, desktop, or non-allowlisted reports", (userAgent) => {
    expect(classifyHighEndUserAgent({ userAgent })).toEqual({
      eligible: false,
      source: "none",
    });
  });

  it("uses the Android UA-CH model when the reduced UA hides it", async () => {
    const navigatorValue = {
      userAgent: ANDROID_UA,
      userAgentData: {
        getHighEntropyValues: jest.fn().mockResolvedValue({
          model: "Pixel 9 Pro",
        }),
      },
    } as unknown as Navigator;

    await expect(resolveHighEndUserAgentAdmission(navigatorValue)).resolves.toEqual({
      eligible: true,
      family: "google-pixel-pro",
      source: "user-agent-client-hint",
    });
  });

  it("fails closed when UA-CH is missing, denied, or contradictory", async () => {
    const missing = { userAgent: ANDROID_UA } as Navigator;
    const denied = {
      userAgent: ANDROID_UA,
      userAgentData: {
        getHighEntropyValues: jest.fn().mockRejectedValue(new Error("denied")),
      },
    } as unknown as Navigator;
    const contradictory = {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      userAgentData: {
        getHighEntropyValues: jest.fn().mockResolvedValue({
          model: "Pixel 10 Pro",
        }),
      },
    } as unknown as Navigator;

    await expect(resolveHighEndUserAgentAdmission(missing)).resolves.toEqual({
      eligible: false,
      source: "none",
    });
    await expect(resolveHighEndUserAgentAdmission(denied)).resolves.toEqual({
      eligible: false,
      source: "none",
    });
    await expect(resolveHighEndUserAgentAdmission(contradictory)).resolves.toEqual({
      eligible: false,
      source: "none",
    });
  });
});
