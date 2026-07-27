import localFont from "next/font/local";

/**
 * Storefront variants expose the same font families without forcing every
 * weight into the document's critical preload header. The browser downloads
 * only faces that rendered content actually uses.
 */
export const peyda = localFont({
  src: [
    {
      path: "../assets/peyda-regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../assets/peyda-medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../assets/peyda-bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--font-peyda",
  preload: false,
});

export const peydaFanum = localFont({
  src: [
    {
      path: "../assets/peyda-regular-fanum.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../assets/peyda-medium-fanum.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../assets/peyda-bold-fanum.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--font-peyda-fanum",
  preload: false,
  adjustFontFallback: false,
});

export const rokh = localFont({
  src: [
    {
      path: "../assets/woff2/Rokh-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../assets/woff2/Rokh-Medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../assets/woff2/Rokh-SemiBold.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../assets/woff2/Rokh-Bold.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "../assets/woff2/Rokh-ExtraBold.woff2",
      weight: "800",
      style: "normal",
    },
    {
      path: "../assets/woff2/Rokh-Black.woff2",
      weight: "900",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--font-rokh",
  preload: false,
});

export const kaghaz = localFont({
  src: [
    {
      path: "../assets/kaghaz.woff2",
      weight: "400",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--font-kaghaz",
  preload: false,
  adjustFontFallback: false,
});
