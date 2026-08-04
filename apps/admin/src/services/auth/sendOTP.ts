import { apiClient } from "../index";
import { ENDPOINTS } from "@/constants/api";
import { normalizePhoneNumber } from "@/utils/auth";
import { rememberOtpToken } from "./otpChallenge";

export interface Response {
  otpToken: string;
}

export const sendOTP = async (phoneNumber: string): Promise<Response> => {
  const endpoint = ENDPOINTS.AUTH.SEND_OTP;
  const normalizedPhone = normalizePhoneNumber(phoneNumber);
  rememberOtpToken(null);

  const response = await apiClient.post<Response>(endpoint, {
    phone: normalizedPhone,
  });

  rememberOtpToken(
    typeof (response as any)?.otpToken === "string" ? (response as any).otpToken : null,
  );

  return response as any;
};
