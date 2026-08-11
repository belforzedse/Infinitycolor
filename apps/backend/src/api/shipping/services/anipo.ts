import axios, { AxiosInstance } from "axios";
import type { Strapi } from "@strapi/strapi";

const DEFAULT_BASE_URL = "https://adminpnx.anipo.ir/api/v1";

export type AnipoCreateOrderPayload = {
  order_code: string;
  receiver_name: string;
  receiver_province: string;
  receiver_city: string;
  receiver_mobile?: string;
  receiver_address?: string;
  receiver_postal_code?: string;
  weight_g?: number;
  box_type?: number;
  parcel_content?: string;
  order_total?: number;
  order_status?: string;
};

export type AnipoBarcodeResult = {
  issued: boolean;
  barcode?: string;
  readyToIssue?: boolean;
  status?: string;
  message?: string;
  postalCost?: unknown;
  issuedAt?: string;
};

export type AnipoOrderResult = AnipoBarcodeResult & {
  orderCode?: string;
  orderStatus?: string;
  weightG?: number;
  service?: string;
};

type AnipoApiErrorBody = {
  message?: string;
};

function getConfig() {
  const base = process.env.ANIPO_BASE_URL || DEFAULT_BASE_URL;
  const token = process.env.ANIPO_TOKEN || "";
  return { baseUrl: base.replace(/\/$/, ""), token };
}

function http(): AxiosInstance {
  const { baseUrl, token } = getConfig();
  return axios.create({
    baseURL: baseUrl,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function maskAuthHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const clone: Record<string, unknown> = {
    ...(headers as Record<string, unknown>),
  };
  if (typeof clone.Authorization === "string") {
    clone.Authorization = "Bearer ***";
  }
  if (typeof clone.authorization === "string") {
    clone.authorization = "Bearer ***";
  }
  return clone;
}

function toJson(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function extractErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as AnipoApiErrorBody).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseAnipoOrderResult(data: unknown): AnipoOrderResult | null {
  if (!data || typeof data !== "object") return null;
  const envelope = data as Record<string, unknown>;
  const raw =
    envelope.order && typeof envelope.order === "object"
      ? (envelope.order as Record<string, unknown>)
      : envelope;

  const barcode = optionalText(raw.barcode);
  const weight = Number(raw.weight_g);
  return {
    orderCode: optionalText(raw.order_code),
    status: optionalText(raw.status),
    orderStatus: optionalText(raw.order_status),
    readyToIssue:
      typeof raw.ready_to_issue === "boolean" ? raw.ready_to_issue : undefined,
    issued: raw.issued === true,
    barcode,
    postalCost: raw.postal_cost,
    issuedAt: optionalText(raw.issued_at),
    weightG: Number.isFinite(weight) && weight > 0 ? weight : undefined,
    service: optionalText(raw.service),
    message: optionalText(raw.message),
  };
}

function safeOrderSummary(data: unknown): Record<string, unknown> {
  const parsed = parseAnipoOrderResult(data);
  return parsed
    ? {
        orderCode: parsed.orderCode,
        status: parsed.status,
        orderStatus: parsed.orderStatus,
        readyToIssue: parsed.readyToIssue,
        issued: parsed.issued,
        hasBarcode: Boolean(parsed.barcode),
        hasPostalCost: parsed.postalCost !== null && parsed.postalCost !== undefined,
        issuedAt: parsed.issued ? parsed.issuedAt : undefined,
        message: parsed.message,
      }
    : { responseShape: "unrecognized" };
}

/** Normalize Iranian mobile for Anipo (local 0… format, max 12 digits). */
export function normalizePhoneForAnipo(raw?: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  let n = digits;
  if (n.startsWith("98")) n = n.substring(2);
  if (n && !n.startsWith("0")) n = `0${n}`;
  return n.substring(0, 12);
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  Paying: "در انتظار پرداخت",
  Started: "در حال آماده‌سازی",
  Shipment: "ارسال شده",
  Done: "تحویل شده",
  Returned: "مرجوع شده",
  Cancelled: "لغو شده",
};

export function mapOrderStatusToAnipo(status?: string | null): string {
  if (!status) return "در حال آماده‌سازی";
  return ORDER_STATUS_LABELS[status] || status;
}

export default ({ strapi }: { strapi: Strapi }) => ({
  async ping(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const { token } = getConfig();
    if (!token) return { ok: false, error: "missing_token" };
    try {
      strapi.log.info(`[anipo] http request endpoint=/ping method=GET`);
      const res = await http().get("/ping");
      strapi.log.info(
        `[anipo] http response endpoint=/ping status=${res.status} body=${toJson(res.data)}`
      );
      return { ok: true, data: res.data };
    } catch (e: unknown) {
      const err = e as {
        message?: string;
        response?: { status?: number; data?: unknown };
        config?: { url?: string; headers?: unknown };
      };
      strapi.log.error(
        `[anipo] http error endpoint=/ping message=${err?.message} status=${
          err?.response?.status
        } url=${err?.config?.url} headers=${toJson(
          maskAuthHeaders(err?.config?.headers)
        )} response=${toJson(err?.response?.data)}`
      );
      return {
        ok: false,
        error: extractErrorMessage(err?.response?.data, "network_error"),
      };
    }
  },

  async createOrUpdateOrder(
    payload: AnipoCreateOrderPayload
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const { token } = getConfig();
    if (!token) return { ok: false, error: "missing_token" };

    const body: AnipoCreateOrderPayload = {
      ...payload,
      receiver_mobile: payload.receiver_mobile
        ? normalizePhoneForAnipo(payload.receiver_mobile)
        : undefined,
      weight_g:
        payload.weight_g !== undefined
          ? Math.max(1, Math.floor(payload.weight_g))
          : undefined,
      box_type:
        payload.box_type !== undefined
          ? Math.min(10, Math.max(1, Math.floor(payload.box_type)))
          : undefined,
      order_total:
        payload.order_total !== undefined
          ? Math.max(0, Math.floor(payload.order_total))
          : undefined,
    };

    try {
      strapi.log.info(`[anipo] http request endpoint=/orders method=POST`, {
        orderCode: body.order_code,
        weightG: body.weight_g,
        boxType: body.box_type,
        orderTotalIrr: body.order_total,
        orderStatus: body.order_status,
        hasMobile: Boolean(body.receiver_mobile),
        hasAddress: Boolean(body.receiver_address),
        hasPostalCode: Boolean(body.receiver_postal_code),
      });
      const res = await http().post("/orders", body);
      strapi.log.info(`[anipo] http response endpoint=/orders status=${res.status}`, {
        ...safeOrderSummary(res.data),
      });
      return { ok: true, data: res.data };
    } catch (e: unknown) {
      const err = e as {
        message?: string;
        response?: { status?: number; data?: unknown };
        config?: { url?: string; data?: unknown; headers?: unknown };
      };
      strapi.log.error(
        `[anipo] http error endpoint=/orders message=${err?.message} status=${
          err?.response?.status
        } url=${err?.config?.url} response=${extractErrorMessage(
          err?.response?.data,
          "provider_error",
        )}`
      );
      return {
        ok: false,
        error: extractErrorMessage(err?.response?.data, "network_error"),
      };
    }
  },

  async getOrderBarcode(
    orderCode: string
  ): Promise<{ ok: boolean; data?: AnipoBarcodeResult; error?: string }> {
    const { token } = getConfig();
    if (!token) return { ok: false, error: "missing_token" };
    const code = encodeURIComponent(String(orderCode));
    const endpoint = `/orders/${code}/barcode`;

    try {
      strapi.log.info(`[anipo] http request endpoint=${endpoint} method=GET`);
      const res = await http().get(endpoint);
      strapi.log.info(`[anipo] http response endpoint=${endpoint} status=${res.status}`, {
        ...safeOrderSummary(res.data),
      });

      const parsed = parseAnipoOrderResult(res.data);
      if (!parsed) {
        return { ok: false, error: "anipo_error" };
      }
      return { ok: true, data: parsed };
    } catch (e: unknown) {
      const err = e as {
        message?: string;
        response?: { status?: number; data?: unknown };
        config?: { url?: string };
      };
      strapi.log.error(
        `[anipo] http error endpoint=${endpoint} message=${err?.message} status=${
          err?.response?.status
        } url=${err?.config?.url} response=${toJson(err?.response?.data)}`
      );
      return {
        ok: false,
        error: extractErrorMessage(err?.response?.data, "network_error"),
      };
    }
  },

  async getOrder(
    orderCode: string
  ): Promise<{ ok: boolean; data?: AnipoOrderResult; error?: string }> {
    const { token } = getConfig();
    if (!token) return { ok: false, error: "missing_token" };
    const code = encodeURIComponent(String(orderCode));
    const endpoint = `/orders/${code}`;

    try {
      strapi.log.info(`[anipo] http request endpoint=${endpoint} method=GET`);
      const res = await http().get(endpoint);
      const parsed = parseAnipoOrderResult(res.data);
      strapi.log.info(`[anipo] http response endpoint=${endpoint} status=${res.status}`, {
        ...safeOrderSummary(res.data),
      });
      if (!parsed) return { ok: false, error: "anipo_error" };
      return { ok: true, data: parsed };
    } catch (e: unknown) {
      const err = e as {
        message?: string;
        response?: { status?: number; data?: unknown };
        config?: { url?: string };
      };
      strapi.log.error(
        `[anipo] http error endpoint=${endpoint} message=${err?.message} status=${
          err?.response?.status
        } url=${err?.config?.url} response=${extractErrorMessage(
          err?.response?.data,
          "provider_error",
        )}`
      );
      return {
        ok: false,
        error: extractErrorMessage(err?.response?.data, "network_error"),
      };
    }
  },

  async updateOrderStatus(
    orderCode: string,
    orderStatus: string
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const { token } = getConfig();
    if (!token) return { ok: false, error: "missing_token" };
    const code = encodeURIComponent(String(orderCode));
    const endpoint = `/orders/${code}/status`;
    const body = { order_status: orderStatus };

    try {
      strapi.log.info(
        `[anipo] http request endpoint=${endpoint} method=PUT body=${toJson(body)}`
      );
      const res = await http().put(endpoint, body);
      strapi.log.info(
        `[anipo] http response endpoint=${endpoint} status=${res.status} body=${toJson(
          res.data
        )}`
      );
      return { ok: true, data: res.data };
    } catch (e: unknown) {
      const err = e as {
        message?: string;
        response?: { status?: number; data?: unknown };
        config?: { url?: string };
      };
      strapi.log.error(
        `[anipo] http error endpoint=${endpoint} message=${err?.message} status=${
          err?.response?.status
        } url=${err?.config?.url} response=${toJson(err?.response?.data)}`
      );
      return {
        ok: false,
        error: extractErrorMessage(err?.response?.data, "network_error"),
      };
    }
  },
});
