import { verifyOTP } from "../verifyOTP";
import { apiClient } from "../../index";
import { ENDPOINTS } from "@/constants/api";
import { clearOtpToken, readOtpToken, rememberOtpToken } from "../otpChallenge";

jest.mock("../../index", () => ({
  apiClient: {
    post: jest.fn(),
  },
}));

describe("verifyOTP", () => {
  const mockPost = apiClient.post as jest.MockedFunction<typeof apiClient.post>;

  beforeEach(() => {
    mockPost.mockReset();
    clearOtpToken();
    sessionStorage.clear();
  });

  it("posts the OTP with the stored otpToken and returns the API payload", async () => {
    const response = { token: "auth-token", user: { id: 1, name: "Test User" } };
    rememberOtpToken("mock-otp-token");
    mockPost.mockResolvedValueOnce(response);

    const result = await verifyOTP("123456");

    expect(mockPost).toHaveBeenCalledWith(
      ENDPOINTS.AUTH.VERIFY_OTP,
      {
        otpToken: "mock-otp-token",
        otp: "123456",
      },
      { suppressAuthRedirect: true },
    );
    expect(result).toEqual(response);
    expect(readOtpToken()).toBeNull();
    expect(sessionStorage.getItem("otpToken")).toBeNull();
  });

  it("passes a null otpToken through when sessionStorage has no token", async () => {
    mockPost.mockResolvedValueOnce({ token: "auth-token" });

    await verifyOTP("123456");

    expect(mockPost).toHaveBeenCalledWith(
      ENDPOINTS.AUTH.VERIFY_OTP,
      {
        otpToken: null,
        otp: "123456",
      },
      { suppressAuthRedirect: true },
    );
  });

  it("uses the exact OTP value entered by the user", async () => {
    mockPost.mockResolvedValue({ token: "auth-token" });

    for (const otp of ["123456", "000000", "999999"]) {
      rememberOtpToken("mock-otp-token");
      await verifyOTP(otp);
      expect(mockPost).toHaveBeenLastCalledWith(
        ENDPOINTS.AUTH.VERIFY_OTP,
        { otpToken: "mock-otp-token", otp },
        { suppressAuthRedirect: true },
      );
    }
  });

  it("propagates API errors", async () => {
    const error = new Error("Invalid OTP");
    rememberOtpToken("mock-otp-token");
    mockPost.mockRejectedValueOnce(error);

    await expect(verifyOTP("123456")).rejects.toThrow("Invalid OTP");
  });
});
