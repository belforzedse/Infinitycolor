import { readFileSync } from "node:fs";
import path from "node:path";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const requiredRuntimeAssets = [
  "Infinity.svg",
  "Logo.png",
  "animations/infloading.json",
  "images/cart/melat.png",
  "images/cart/samankish.png",
  "images/cart/snappay.svg",
  "images/cart/wallet.svg",
  "images/cart/zarinpal.svg",
  "images/cropped-021.webp",
  "images/full-logo.png",
  "images/pdf-icon.png",
  "images/placeholders/file-placeholder.svg",
  "images/placeholders/image-placeholder.svg",
  "images/placeholders/pdf-placeholder.svg",
  "images/placeholders/video-placeholder.svg",
  "images/social/balad.png",
  "images/social/g-map.png",
  "images/social/neshan.png",
  "images/social/phone.png",
  "images/social/waze.png",
  "images/social/whatsapp.png",
];

describe("admin runtime asset closure", () => {
  it.each([
    "Logo.png",
    "images/full-logo.png",
    "icons/admin-192.png",
    "icons/admin-apple-touch.png",
    "icons/admin-maskable-512.png",
    "icons/admin-staging-192.png",
    "icons/admin-staging-apple-touch.png",
    "icons/admin-staging-maskable-512.png",
  ])("ships a valid PNG for /%s", (relativePath) => {
    const contents = readFileSync(
      path.join(process.cwd(), "public", relativePath),
    );

    expect(contents.subarray(0, pngSignature.length)).toEqual(pngSignature);
  });

  it.each(requiredRuntimeAssets)(
    "ships the extracted dependency /%s",
    (relativePath) => {
      expect(
        readFileSync(path.join(process.cwd(), "public", relativePath))
          .byteLength,
      ).toBeGreaterThan(0);
    },
  );
});
