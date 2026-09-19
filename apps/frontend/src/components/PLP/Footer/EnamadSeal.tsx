import { ENAMAD_SEAL, ENAMAD_SEAL_IMAGE_URL, ENAMAD_SEAL_VERIFY_URL } from "@/constants/footer";

/**
 * eNamad trust seal badge.
 *
 * Deliberately a native `<img>` hot-linked from eNamad: `next.config.ts` sets
 * `images.loader: "custom"` and the image allowlist only covers Strapi
 * `/uploads/**`, so `next/image` would resolve this source to an empty string.
 * eNamad also checks the referring domain and the `code` attribute, so the
 * badge only renders on the registered domain — expect a broken image in local
 * dev, where eNamad answers 403.
 */
const EnamadSeal = () => {
  return (
    <a
      href={ENAMAD_SEAL_VERIFY_URL}
      target="_blank"
      // `noreferrer` is intentionally omitted: eNamad validates the referring
      // domain on the verification page.
      rel="noopener"
      referrerPolicy="origin"
      className="inline-block shrink-0 leading-none"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- eNamad must serve the seal from its own origin. */}
      <img
        src={ENAMAD_SEAL_IMAGE_URL}
        alt="نماد اعتماد الکترونیکی"
        referrerPolicy="origin"
        width={125}
        height={136}
        loading="lazy"
        {...{ code: ENAMAD_SEAL.code }}
        className="h-16 w-auto object-contain lg:h-24"
      />
    </a>
  );
};

export default EnamadSeal;
