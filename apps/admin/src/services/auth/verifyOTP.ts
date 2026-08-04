import { apiClient } from "../index";
import { ENDPOINTS } from "@/constants/api";
import { clearOtpToken, readOtpToken } from "./otpChallenge";

export interface Response {
  token: string;
}

export const verifyOTP = async (otp: string): Promise<Response> => {
  const endpoint = ENDPOINTS.AUTH.VERIFY_OTP;

  const response = await apiClient.post<Response>(
    endpoint,
    {
      otpToken: readOtpToken(),
      otp: otp,
    },
    { suppressAuthRedirect: true },
  );

  clearOtpToken();
  return response as any;
};
