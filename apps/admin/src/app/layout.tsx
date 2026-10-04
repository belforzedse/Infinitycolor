import { getLegacyRuntimePolyfillScript } from "@/lib/legacyRuntimePolyfills";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@repo/ui/styles.css";
import "../styles/components.css";
import "./globals.css";
import { peyda, peydaFanum, rokh, kaghaz } from "@repo/fonts/storefront";
import AdminProviders from "./AdminProviders";
import {
  adminEnvironment,
  validateAdminRuntimeConfiguration,
} from "@/config/admin-env";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const staging = adminEnvironment() === "staging";
validateAdminRuntimeConfiguration();
const applicationTitle = staging
  ? "مدیریت اینفینیتی - آزمایشی"
  : "مدیریت اینفینیتی";
const iconPrefix = staging ? "admin-staging" : "admin";

export const metadata: Metadata = {
  title: { default: applicationTitle, template: `%s | ${applicationTitle}` },
  description: "سامانه مستقل مدیریت اینفینیتی",
  applicationName: "مدیریت اینفینیتی",
  robots: { index: false, follow: false, nocache: true },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      {
        url: `/icons/${iconPrefix}-192.png`,
        sizes: "192x192",
        type: "image/png",
      },
      {
        url: `/icons/${iconPrefix}-512.png`,
        sizes: "512x512",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: `/icons/${iconPrefix}-apple-touch.png`,
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: staging ? "#c2410c" : "#3d4c6e",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;
  return (
    <html
      lang="fa"
      dir="rtl"
      className={`${peyda.variable} ${peydaFanum.variable} ${rokh.variable} ${kaghaz.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: getLegacyRuntimePolyfillScript() }}
        />
        <meta name="csp-nonce" content={nonce} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={applicationTitle} />
      </head>
      <body
        className={`${peydaFanum.className} min-h-screen bg-neutral-50 antialiased`}
      >
        <a
          href="#admin-content"
          className="sr-only fixed right-0 top-0 z-[9999] rounded-b-lg bg-infinity-primary px-4 py-2 text-white focus:not-sr-only"
        >
          رفتن به محتوای اصلی
        </a>
        <AdminProviders>
          <div id="admin-content">{children}</div>
        </AdminProviders>
      </body>
    </html>
  );
}
