import type { SmsNotificationType } from "./types";

const DEFAULT_BASE_URL = "https://edge.ippanel.com/v1";
const DEFAULT_PATTERN_ENDPOINT = "/api/send";
const DEFAULT_TIMEOUT_MS = 4000;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export type SmsConfig = {
  enabled: boolean;
  apiUrl: string;
  apiKey?: string;
  sender?: string;
  defaultPatternCode?: string;
  timeoutMs: number;
  patternCodes: Partial<Record<SmsNotificationType, string>>;
};

function normalizeFlag(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return false;
}

function joinUrl(baseUrl: string, endpoint: string): string {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const path = String(endpoint || DEFAULT_PATTERN_ENDPOINT).replace(/^\/?/, "/");
  return `${base}${path}`;
}

function readPatternCodes(env: NodeJS.ProcessEnv): Partial<Record<SmsNotificationType, string>> {
  return {
    otp: env.IP_PANEL_PATTERN_OTP || env.IP_PANEL_PATTERN_CODE,
    order_created: env.IP_PANEL_PATTERN_ORDER_CREATED || env.IP_PANEL_PATTERN_CODE,
    order_status_updated: env.IP_PANEL_PATTERN_ORDER_STATUS_UPDATED || env.IP_PANEL_PATTERN_CODE,
    shipped: env.IP_PANEL_PATTERN_SHIPPED || env.IP_PANEL_PATTERN_CODE,
    delivered: env.IP_PANEL_PATTERN_DELIVERED || env.IP_PANEL_PATTERN_CODE,
    cancelled: env.IP_PANEL_PATTERN_CANCELLED || env.IP_PANEL_PATTERN_CODE,
  };
}

export function loadSmsConfig(env: NodeJS.ProcessEnv = process.env): SmsConfig {
  const explicitUrl = String(env.IP_PANEL_API_URL || "").trim();
  const baseUrl = String(env.IP_PANEL_API_BASE_URL || DEFAULT_BASE_URL).trim();
  const endpoint = String(env.IP_PANEL_PATTERN_ENDPOINT || DEFAULT_PATTERN_ENDPOINT).trim();
  const timeoutMs = Number(env.IP_PANEL_TIMEOUT_MS || env.SMS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  return {
    enabled: normalizeFlag(env.SMS_ENABLED),
    apiUrl: explicitUrl || joinUrl(baseUrl, endpoint),
    apiKey: env.IP_PANEL_API_KEY,
    sender: env.IP_PANEL_SENDER,
    defaultPatternCode: env.IP_PANEL_PATTERN_CODE,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    patternCodes: readPatternCodes(env),
  };
}

export function getPatternCode(config: SmsConfig, type: SmsNotificationType): string | undefined {
  return config.patternCodes[type] || config.defaultPatternCode;
}
