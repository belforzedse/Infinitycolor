import { apiClient } from "../index";
import { ENDPOINTS } from "@/constants/api";
import { normalizePhoneNumber } from "@/utils/auth";
import { clearOtpToken, readOtpToken } from "./otpChallenge";

export interface ResetPasswordRequest {
  otp: string;
  newPassword: string;
  otpToken?: string | null;
  phone?: string;
}

export interface Response {
  message?: string;
  success?: boolean;
}

export const resetPassword = async (payload: ResetPasswordRequest): Promise<Response> => {
  const endpoint = ENDPOINTS.AUTH.RESET_PASSWORD;

  const otpToken = payload.otpToken ?? readOtpToken();

  if (!otpToken) {
    throw new Error("Missing OTP token");
  }

  const normalizedPhone = payload.phone ? normalizePhoneNumber(payload.phone) : undefined;

  const response = await apiClient.post<Response>(endpoint, {
    otpToken,
    otp: payload.otp,
    newPassword: payload.newPassword,
    phone: normalizedPhone,
  });

  clearOtpToken();
  return response as any;
};
