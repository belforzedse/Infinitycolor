let currentOtpToken: string | null = null;

export function rememberOtpToken(token: string | null): void {
  currentOtpToken = token;
}

export function readOtpToken(): string | null {
  return currentOtpToken;
}

export function clearOtpToken(): void {
  currentOtpToken = null;
}
