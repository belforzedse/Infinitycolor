export const STALE_AUTH_STORAGE_KEYS = [
  "accessToken",
  "refreshToken",
  "otpToken",
  "pendingNewPassword",
  "pendingPhone",
] as const;

export type PhoneStatusRequest = { phone: string };
export type PhoneStatusResponse = { message: string; hasUser: boolean };

export type OtpRequest = { phone: string };
export type OtpRequestResponse = { message: string };

export type OtpVerifyRequest = { otp: string };
export type PasswordSignInRequest = { phone: string; password: string };
export type PasswordResetRequest = { otp: string; newPassword: string };

export type AuthSuccessResponse = {
  message: string;
  redirectTo?: string;
};

export type ReturnGrantExchangeRequest = { grant: string };
export type ReturnGrantExchangeResponse = {
  returnTo: string;
  authenticated: true;
};

export type BetterAuthTokenResponse = {
  token: string;
};

export type BridgePhoneRequest = { phone: string };
export type BridgeOtpVerifyRequest = { challengeId: string; otp: string };
export type BridgePasswordVerifyRequest = { phone: string; password: string };
export type BridgePasswordResetRequest = {
  challengeId: string;
  otp: string;
  newPassword: string;
};

export type BridgePhoneStatusResponse = {
  hasUser: boolean;
  strapiUserId?: number;
};

export type BridgeOtpRequestResponse = {
  challengeId: string;
};

export type BridgeVerifiedIdentityResponse = {
  strapiUserId: number;
  confirmed: boolean;
  needsProfileCompletion?: boolean;
};

export type BridgeOtpVerifiedIdentityResponse =
  BridgeVerifiedIdentityResponse & {
    isNewUser: boolean;
    needsProfileCompletion: boolean;
  };

export type AuthStateEvent = "session-changed" | "logout";

export const AUTH_STATE_CHANNEL = "infinity-auth-state";
export const AUTH_STATE_EVENT = "infinity-auth-state-change";

export interface AuthStateEventDetail {
  type: AuthStateEvent;
  at: number;
}
