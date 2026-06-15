import { getPatternCode, loadSmsConfig, type SmsConfig } from "./config";
import { normalizeIranMobile } from "./phone";
import { maskPhone, maskSecret } from "./redaction";
import type { SmsNotificationType, SmsPatternParams, SmsSendResult, StrapiSmsLogger } from "./types";

const LEGACY_OTP_API_URL = "https://api2.ippanel.com/api/v1/sms/pattern/normal/send";

export type PatternSmsInput = {
  type: SmsNotificationType;
  phone: string;
  params: SmsPatternParams;
  patternCode?: string;
  logger?: StrapiSmsLogger;
  config?: SmsConfig;
};

export type LegacyOtpSmsInput = {
  phone: string;
  code: string | number;
  logger?: StrapiSmsLogger;
  config?: SmsConfig;
};

export function sanitizePatternParams(params: SmsPatternParams): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    clean[key] = String(value);
  }
  return clean;
}

export function buildPatternPayload(input: {
  sender: string;
  patternCode: string;
  recipient: string;
  params: SmsPatternParams;
}) {
  return {
    sending_type: "pattern",
    from_number: input.sender,
    code: input.patternCode,
    recipients: [input.recipient],
    params: sanitizePatternParams(input.params),
  };
}

export function buildLegacyOtpPayload(input: {
  sender: string;
  patternCode: string;
  recipient: string;
  code: string | number;
}) {
  return {
    recipient: input.recipient,
    code: input.patternCode,
    sender: input.sender,
    variable: {
      "verification-code": String(input.code),
    },
  };
}

function providerSucceeded(status: number, body: any): boolean {
  if (status < 200 || status >= 300) return false;
  if (!body) return true;
  if (body?.meta && typeof body.meta.status === "boolean") return body.meta.status === true;
  if (body?.success === true || body?.status === "OK" || body?.code === 200) return true;
  return false;
}

function extractMessageId(body: any): string | number | undefined {
  const ids = body?.data?.message_outbox_ids;
  if (Array.isArray(ids) && ids.length > 0) return ids[0];
  return body?.messageId ?? body?.data?.message_id;
}

async function parseResponseBody(response: Response): Promise<{ raw: string; parsed: any }> {
  const raw = await response.text();
  if (!raw) return { raw, parsed: null };
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    return { raw, parsed: null };
  }
}

export async function sendPatternSms(input: PatternSmsInput): Promise<SmsSendResult> {
  const logger = input.logger;
  const config = input.config || loadSmsConfig();

  if (!config.enabled) {
    logger?.debug?.("[sms] skipped because SMS is disabled", { type: input.type });
    return { ok: false, skipped: true, disabled: true, reason: "disabled" };
  }

  const recipient = normalizeIranMobile(input.phone);
  if (!recipient) {
    logger?.warn?.("[sms] skipped invalid recipient", {
      type: input.type,
      recipient: maskPhone(input.phone),
    });
    return { ok: false, skipped: true, reason: "invalid_phone" };
  }

  const patternCode = input.patternCode || getPatternCode(config, input.type);
  if (!config.apiUrl || !config.apiKey || !config.sender || !patternCode) {
    logger?.error?.("[sms] missing IPPanel configuration", {
      type: input.type,
      hasApiUrl: !!config.apiUrl,
      hasApiKey: !!config.apiKey,
      apiKey: config.apiKey ? maskSecret(config.apiKey) : undefined,
      hasSender: !!config.sender,
      hasPatternCode: !!patternCode,
    });
    return { ok: false, skipped: true, reason: "missing_config" };
  }

  const payload = buildPatternPayload({
    sender: config.sender,
    patternCode,
    recipient,
    params: input.params,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        Authorization: config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const { raw, parsed } = await parseResponseBody(response);
    const ok = providerSucceeded(response.status, parsed);
    const result: SmsSendResult = {
      ok,
      status: response.status,
      messageId: extractMessageId(parsed),
      providerCode: parsed?.meta?.message_code,
      providerMessage: parsed?.meta?.message,
    };

    const logContext = {
      type: input.type,
      status: response.status,
      recipient: maskPhone(recipient),
      patternCode,
      messageId: result.messageId,
      providerCode: result.providerCode,
      providerMessage: result.providerMessage,
    };

    if (ok) {
      logger?.info?.("[sms] IPPanel pattern SMS sent", logContext);
    } else {
      logger?.warn?.("[sms] IPPanel pattern SMS failed", {
        ...logContext,
        body: parsed || raw.slice(0, 500),
      });
    }

    return result;
  } catch (error) {
    logger?.warn?.("[sms] IPPanel request failed", {
      type: input.type,
      recipient: maskPhone(recipient),
      error: (error as Error)?.name === "AbortError" ? "timeout" : (error as Error)?.message,
    });
    return {
      ok: false,
      reason: (error as Error)?.name === "AbortError" ? "timeout" : "request_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendLegacyOtpSms(input: LegacyOtpSmsInput): Promise<SmsSendResult> {
  const logger = input.logger;
  const config = input.config || loadSmsConfig();

  if (!config.enabled) {
    logger?.debug?.("[sms] skipped OTP because SMS is disabled");
    return { ok: false, skipped: true, disabled: true, reason: "disabled" };
  }

  const recipient = normalizeIranMobile(input.phone);
  if (!recipient) {
    logger?.warn?.("[sms] skipped invalid OTP recipient", {
      recipient: maskPhone(input.phone),
    });
    return { ok: false, skipped: true, reason: "invalid_phone" };
  }

  const patternCode = getPatternCode(config, "otp");
  if (!config.apiKey || !config.sender || !patternCode) {
    logger?.error?.("[sms] missing legacy IPPanel OTP configuration", {
      hasApiKey: !!config.apiKey,
      apiKey: config.apiKey ? maskSecret(config.apiKey) : undefined,
      hasSender: !!config.sender,
      hasPatternCode: !!patternCode,
    });
    return { ok: false, skipped: true, reason: "missing_config" };
  }

  const payload = buildLegacyOtpPayload({
    sender: config.sender,
    patternCode,
    recipient,
    code: input.code,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(LEGACY_OTP_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apiKey: config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const { raw, parsed } = await parseResponseBody(response);
    const ok = providerSucceeded(response.status, parsed);
    const result: SmsSendResult = {
      ok,
      status: response.status,
      messageId: extractMessageId(parsed),
      providerCode: parsed?.meta?.message_code,
      providerMessage: parsed?.meta?.message,
    };

    const logContext = {
      type: "otp",
      status: response.status,
      recipient: maskPhone(recipient),
      patternCode,
      messageId: result.messageId,
      providerCode: result.providerCode,
      providerMessage: result.providerMessage,
    };

    if (ok) {
      logger?.info?.("[sms] IPPanel legacy OTP SMS sent", logContext);
    } else {
      logger?.warn?.("[sms] IPPanel legacy OTP SMS failed", {
        ...logContext,
        body: parsed || raw.slice(0, 500),
      });
    }

    return result;
  } catch (error) {
    logger?.warn?.("[sms] IPPanel legacy OTP request failed", {
      recipient: maskPhone(recipient),
      error: (error as Error)?.name === "AbortError" ? "timeout" : (error as Error)?.message,
    });
    return {
      ok: false,
      reason: (error as Error)?.name === "AbortError" ? "timeout" : "request_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}
