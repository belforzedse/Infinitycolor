export type SmsNotificationType =
  | "otp"
  | "order_created"
  | "order_status_updated"
  | "shipped"
  | "delivered"
  | "cancelled";

export type SmsPatternParams = Record<string, string | number | boolean | null | undefined>;

export type SmsSendResult = {
  ok: boolean;
  skipped?: boolean;
  duplicate?: boolean;
  disabled?: boolean;
  reason?: string;
  status?: number;
  messageId?: string | number;
  providerCode?: string;
  providerMessage?: string;
};

export type StrapiSmsLogger = {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
};

export type StrapiSmsLike = {
  log?: StrapiSmsLogger;
  entityService?: {
    findOne?: (uid: string, id: number, options?: any) => Promise<any>;
  };
};
