import { getStrapiServerUrl } from "@/constants/api";
import { POST } from "./route";

jest.mock("next/server", () => ({
  NextResponse: {
    redirect: (target: string | URL, init: { status: number }) => ({
      status: init.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location" ? String(target) : null,
      },
    }),
  },
}));

jest.mock("@/constants/api", () => ({
  getStrapiServerUrl: jest.fn(),
}));

jest.mock("@/lib/central-auth-server", () => ({
  storefrontOrigin: () => "https://storefront.test.invalid",
  storefrontUrl: (path: string) => new URL(path, "https://storefront.test.invalid"),
}));

const mockedApiUrl = getStrapiServerUrl as jest.MockedFunction<
  typeof getStrapiServerUrl
>;

function callbackRequest(
  rawUrl: string,
  fields: Record<string, string>,
) {
  const url = new URL(rawUrl);
  return {
    url: url.toString(),
    nextUrl: url,
    formData: async () => ({
      get: (key: string) => fields[key] ?? null,
    }),
  } as any;
}

describe("SnappPay storefront return proxy", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedApiUrl.mockReturnValue("https://backend.test.invalid/api");
    delete process.env.NEXT_PUBLIC_ALLOWED_REDIRECT_ORIGINS;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("forwards only documented callback fields and the nonce", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 303,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location"
            ? "https://storefront.test.invalid/payment/result?resultHint=processing"
            : null,
      },
    }) as any;
    const request = callbackRequest(
      "https://0.0.0.0:3000/api/snapp/return?nonce=abcdefghijklmnopqrstuv",
      {
        transactionId: "ABC1234567",
        state: "OK",
        amount: "1200000",
        paymentToken: "must-not-be-forwarded",
        OrderId: "must-not-be-forwarded",
      },
    );

    const response = await POST(request);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://backend.test.invalid/api/orders/snappay/callback?nonce=abcdefghijklmnopqrstuv",
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        body: "transactionId=ABC1234567&state=OK&amount=1200000",
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://storefront.test.invalid/payment/result?resultHint=processing",
    );
  });

  it("blocks an off-origin redirect supplied by the backend response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 303,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location"
            ? "https://attacker.invalid/collect"
            : null,
      },
    }) as any;
    const request = callbackRequest("https://0.0.0.0:3000/api/snapp/return", {
      transactionId: "ABC1234567",
      state: "OK",
      amount: "1200000",
    });

    const response = await POST(request);

    expect(response.headers.get("location")).toBe(
      "https://storefront.test.invalid/payment/result?resultHint=invalid_redirect",
    );
  });

  it("uses the configured storefront for fallback redirects behind an internal proxy origin", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
    }) as any;
    const request = callbackRequest("https://0.0.0.0:3000/api/snapp/return", {
      transactionId: "ABC1234567",
      state: "OK",
      amount: "1200000",
    });

    const response = await POST(request);

    expect(response.headers.get("location")).toBe(
      "https://storefront.test.invalid/payment/result?resultHint=processing",
    );
  });
});
