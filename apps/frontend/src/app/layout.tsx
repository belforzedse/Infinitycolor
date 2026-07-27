import type { Metadata, Viewport } from "next";
import { Toaster } from "react-hot-toast";
import { Suspense } from "react";
import "@repo/ui/styles.css";
import "../styles/components.css";
import "./globals.css";
import { NuqsAdapter } from "nuqs/adapters/next";
import { CartProvider } from "@/contexts/CartContext";
import { MobileMenuProvider } from "@/contexts/MobileMenuContext";
import Providers from "./Providers";
import { peyda, peydaFanum, rokh, kaghaz } from "@repo/fonts";
import DevOnlyDebugPanel from "@/components/Debug/DevOnlyDebugPanel";
import { NavigationProgress } from "@repo/ui/navigation-progress";
import { OrganizationSchema } from "@/components/SEO/OrganizationSchema";
import { IMAGE_BASE_URL, MEDIA_CDN_URL } from "@/constants/api";
import { SITE_URL } from "@/config/site";
import { getSiteIdentity, resolveSiteName } from "@/services/site-identity";
import { SiteIdentityProvider } from "@/components/providers/SiteIdentityProvider";
import { getAdaptiveQualityBootstrapScript } from "@/lib/adaptive-quality/bootstrap-script";

const DEFAULT_SITE_DESCRIPTION =
  "فروشگاه پوشاک آنلاین اینفینیتی - جدیدترین محصولات، تخفیف‌ها و پیشنهادهای ویژه";

export async function generateMetadata(): Promise<Metadata> {
  const identity = await getSiteIdentity();
  const siteName = resolveSiteName(identity.siteName);
  const description = identity.brandDescription?.trim() || DEFAULT_SITE_DESCRIPTION;

  return {
    metadataBase: new URL(SITE_URL),
    title: {
      template: `%s | ${siteName}`,
      default: siteName,
    },
    description,
    keywords: ["پوشاک", "فروشگاه آنلاین", "مد", "لباس", "اینفینیتی", "خرید آنلاین"],
    applicationName: "اینفینیتی",
    authors: [{ name: siteName }],
    creator: siteName,
    publisher: siteName,
    formatDetection: {
      email: false,
      address: false,
      telephone: false,
    },
    openGraph: {
      type: "website",
      locale: "fa_IR",
      url: SITE_URL,
      siteName,
      title: siteName,
      description,
      images: [
        {
          url: `${SITE_URL}/images/og-default.jpg`,
          width: 1200,
          height: 630,
          alt: siteName,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: siteName,
      description,
      images: [`${SITE_URL}/images/og-default.jpg`],
    },
    alternates: {
      canonical: SITE_URL,
      languages: {
        "fa-IR": SITE_URL,
      },
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-video-preview": -1,
        "max-image-preview": "large",
        "max-snippet": -1,
      },
    },
    verification: {
      google: "l6i1v4-mkeaMxCGEXenzCdyBdhipiZdHuyiaIE011Kg",
    },
  };
}

// Ensure proper mobile scaling and responsiveness
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#3d4c6e", // Infinity primary theme color for mobile browsers
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const identity = await getSiteIdentity();
  const siteName = resolveSiteName(identity.siteName);
  const organizationSocialLinks = identity.socialLinks.map((link) => link.url).filter(Boolean);
  const primaryPhone =
    identity.contactNumbers.find((c) => c.type !== "whatsapp")?.number ??
    identity.contactNumbers[0]?.number;
  const primaryStore = identity.stores[0];

  const defaultApiBaseDomain =
    process.env.NODE_ENV === "production"
      ? "https://api.infinitycolor.co"
      : "http://localhost:1337";

  // Extract base domain for prefetch (API_BASE_URL in constants includes /api suffix)
  const API_BASE_DOMAIN = process.env.NEXT_PUBLIC_API_BASE_URL
    ? process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/api$/, "")
    : defaultApiBaseDomain;

  // Distinct cross-origins to warm early. `new URL(x).origin` strips any trailing
  // slash/path, fixing the malformed/duplicate preconnect hrefs Lighthouse flagged.
  const toOrigin = (value?: string | null): string | null => {
    if (!value) return null;
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };

  const apiOrigin = toOrigin(API_BASE_DOMAIN);
  const imageOrigin = toOrigin(IMAGE_BASE_URL) ?? apiOrigin;
  const mediaCdnOrigin = toOrigin(MEDIA_CDN_URL); // e.g. https://cdn.infinitycolor.co (serves the GIF + images)

  // API uses CORS fetches → preconnect WITH crossOrigin.
  const corsPreconnectOrigins = Array.from(new Set([apiOrigin].filter(Boolean))) as string[];
  // Image/CDN origins serve no-cors <img> (incl. the animated GIF banner) → preconnect
  // WITHOUT crossOrigin, else the warmed connection can't be reused by the image request.
  const mediaPreconnectOrigins = (
    Array.from(new Set([imageOrigin, mediaCdnOrigin].filter(Boolean))) as string[]
  ).filter((origin) => !corsPreconnectOrigins.includes(origin));
  const dnsPrefetchOrigins = Array.from(
    new Set([apiOrigin, imageOrigin, mediaCdnOrigin].filter(Boolean)),
  ) as string[];
  const adaptiveQualityBootstrap = getAdaptiveQualityBootstrapScript();

  return (
    <html
      lang="fa"
      dir="rtl"
      className={`${peyda.variable} ${peydaFanum.variable} ${rokh.variable} ${kaghaz.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          id="infinity-adaptive-quality-bootstrap"
          dangerouslySetInnerHTML={{ __html: adaptiveQualityBootstrap }}
        />
        {/* Favicons */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="icon" href="/favicon-96x96.png" type="image/png" sizes="96x96" />

        {/* Critical Peyda Fanum preloads are emitted by next/font (`peydaFanum` in @repo/fonts). */}

        {/* DNS prefetch for all API/media origins + external social domains. */}
        {dnsPrefetchOrigins.map((origin) => (
          <link key={`dns-${origin}`} rel="dns-prefetch" href={origin} />
        ))}
        <link rel="dns-prefetch" href="https://www.instagram.com" />
        <link rel="dns-prefetch" href="https://www.telegram.org" />

        {/* Preconnect (DNS + TCP + TLS) so the first API/media request starts sooner. */}
        {/* API uses CORS fetches → crossOrigin. */}
        {corsPreconnectOrigins.map((origin) => (
          <link key={`pc-cors-${origin}`} rel="preconnect" href={origin} crossOrigin="anonymous" />
        ))}
        {/* Media/CDN serves no-cors <img> (incl. the animated GIF banner) → no crossOrigin. */}
        {mediaPreconnectOrigins.map((origin) => (
          <link key={`pc-${origin}`} rel="preconnect" href={origin} />
        ))}

        {/* OpenSearch descriptor for browser search integration */}
        <link
          rel="search"
          type="application/opensearchdescription+xml"
          href="/opensearch.xml"
          title={siteName}
        />

        {/* PWA Web App Manifest */}
        <link rel="manifest" href="/manifest.json" />

        {/* PWA meta tags for mobile */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content={siteName} />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="theme-color" content="#3d4c6e" />

        {/* Apple Touch Icons */}
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
      </head>
      <body className={`${peydaFanum.className} bg-background antialiased`}>
        <NavigationProgress />

        {/* Organization Schema for SEO (driven by site identity, with fallbacks) */}
        <OrganizationSchema
          name={siteName}
          description={identity.brandDescription}
          email={identity.contactEmail}
          phone={primaryPhone}
          sameAs={organizationSocialLinks}
          streetAddress={primaryStore?.address}
        />

        {/* Skip to main content link for keyboard users */}
        <a
          href="#main-content"
          className="sr-only fixed right-0 top-0 z-[9999] rounded-b-lg bg-infinity-primary px-4 py-2 text-white focus:not-sr-only"
        >
          رفتن به محتوای اصلی
        </a>

        <SiteIdentityProvider identity={identity}>
          <CartProvider>
            <MobileMenuProvider>
              <NuqsAdapter>
                <Providers>
                  <Suspense fallback={null}>
                    <div id="main-content">{children}</div>
                  </Suspense>
                </Providers>
              </NuqsAdapter>
            </MobileMenuProvider>
          </CartProvider>
        </SiteIdentityProvider>
        <Toaster
          position="bottom-center"
          containerStyle={{ zIndex: 2147483647 }}
          toastOptions={{
            style: { zIndex: 2147483647 },
          }}
        />
        <DevOnlyDebugPanel />
      </body>
    </html>
  );
}
