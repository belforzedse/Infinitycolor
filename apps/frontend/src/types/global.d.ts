declare module "rc-slider/assets/index.css";
declare module "swiper/css";
declare module "*.css";

declare module "react-window" {
  import type * as React from "react";

  export type ListChildComponentProps = {
    index: number;
    style: React.CSSProperties;
    data?: any;
    isScrolling?: boolean;
  };

  export const FixedSizeList: React.ComponentType<{
    height: number | string;
    itemCount: number;
    itemSize: number;
    width: number | string;
    children: React.ComponentType<ListChildComponentProps>;
  }>;
}

declare module "jalaliday" {
  const plugin: any;
  export default plugin;
}

interface Window {
  umami?: {
    track: {
      (): void;
      (eventName: string, data?: Record<string, string | number | boolean>): void;
      (
        payload:
          | Record<string, unknown>
          | ((defaults: Record<string, unknown>) => Record<string, unknown>),
      ): void;
    };
    identify: {
      (id: string, data?: Record<string, string | number | boolean>): void;
      (data: Record<string, string | number | boolean>): void;
    };
  };
  __analyticsPendingCalls?: Array<(api: NonNullable<Window["umami"]>) => void>;
  __infinityAnalyticsBeforeSend?: (
    type: string,
    payload: Record<string, unknown>,
  ) => Record<string, unknown> | null;
}
