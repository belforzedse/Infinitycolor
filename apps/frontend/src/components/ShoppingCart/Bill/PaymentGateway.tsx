import React from "react";
import Image from "next/image";
import classNames from "classnames";
import { type CheckoutGatewayCode } from "@/services/cart/types/cart";

interface Props {
  selected: CheckoutGatewayCode;
  onChange: (gw: CheckoutGatewayCode) => void;
  availableGateways?: CheckoutGatewayCode[];
  snappEligible?: boolean;
  snappTitle?: string;
  snappDescription?: string;
  /**
   * The shopper has chosen to cover the whole order from their wallet, so the
   * bank gateways are not part of this payment.
   */
  walletCoversTotal?: boolean;
  /**
   * A partial wallet tender is in play and SnappPay is not one of the gateways
   * the server will split with. The card is withheld rather than left to fail
   * at the quote, and the reason is said out loud so the shopper can see that
   * unticking the wallet brings it back.
   */
  snappBlockedByWalletSplit?: boolean;
}

function ShoppingCartBillPaymentGateway({
  selected,
  onChange,
  availableGateways = [],
  snappEligible,
  snappTitle,
  snappDescription,
  walletCoversTotal = false,
  snappBlockedByWalletSplit = false,
}: Props) {

  const snappDisplayTitle = snappTitle?.trim() || "اسنپ پی";
  const snappDisplayDescription = snappDescription?.trim();
  const snappHelper = (
    <div className="flex flex-col gap-2 text-right">
      <div className="text-md font-bold text-neutral-800">{snappDisplayTitle}</div>
      {snappDisplayDescription ? (
        <div className="text-sm text-neutral-600">{snappDisplayDescription}</div>
      ) : null}
    </div>
  );

  const saman = {
    id: "samankish" as const,
    name: "سامان‌کیش",
    img: "/images/cart/samankish.png",
  };

  const mellat = {
    id: "mellat" as const,
    name: "بانک ملت",
    img: "/images/cart/melat.png",
  };

  const zarinpal = {
    id: "zarinpal" as const,
    name: "زرین‌پال",
    img: "/images/cart/zarinpal.svg",
  };

  const snappay = {
    id: "snappay" as const,
    name: snappDisplayTitle,
    img: "/images/cart/snappay.svg",
    helper: snappHelper,
    disabled: snappEligible !== true,
  };

  const showSaman = availableGateways.includes("samankish");
  const showMellat = availableGateways.includes("mellat");
  const showZarinPal = availableGateways.includes("zarinpal");
  const showSnappay = availableGateways.includes("snappay") && snappEligible !== false;

  if (walletCoversTotal) {
    // Nothing is left for a bank to carry, so offering one would be a choice
    // with no effect.
    return (
      <div className="flex flex-col gap-2" data-testid="payment-gateway-wallet-only">
        <span className="text-2xl text-neutral-800 lg:text-xl">روش پرداخت</span>
        <p className="rounded-lg border border-stone-100 bg-stone-50 p-4 text-base text-neutral-700">
          کل مبلغ سفارش از کیف پول شما پرداخت می‌شود و نیازی به انتخاب درگاه بانکی نیست.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <span className="text-2xl text-neutral-800 lg:text-xl">درگاه پرداخت خود را انتخاب کنید</span>
      {snappBlockedByWalletSplit && availableGateways.includes("snappay") && (
        <p
          data-testid="payment-gateway-snappay-wallet-blocked"
          className="rounded-lg border border-stone-100 bg-stone-50 p-4 text-sm text-neutral-700"
        >
          پرداخت اقساطی اسنپ‌پی همراه با کیف پول امکان‌پذیر نیست. برای استفاده از اسنپ‌پی، تیک کیف
          پول را بردارید.
        </p>
      )}
      {showSnappay && (
        <button
          onClick={() => !snappay.disabled && onChange(snappay.id)}
          data-testid="payment-gateway-snappay"
          disabled={snappay.disabled}
          aria-disabled={snappay.disabled}
          className={classNames(
            "flex w-full flex-row items-center justify-between gap-4 rounded-lg border border-stone-50 bg-stone-50 py-4 pr-4 transition-opacity duration-300 lg:gap-6 lg:p-2",
            selected === snappay.id && !snappay.disabled && "!border-infinity-primary",
            snappay.disabled && "cursor-not-allowed opacity-50",
          )}
          type="button"
        >
          <div className="relative h-24 w-24 flex-shrink-0 lg:h-36 lg:w-36">
            <Image
              src={snappay.img}
              alt={snappay.name}
              fill
              className="bg-stone-50 object-contain p-3"
              sizes="(min-width: 1024px) 144px, 96px"
            />
          </div>

          <div className="flex flex-1 flex-col items-start gap-2">
            <div className="text-md lg:text-lg">{snappay.helper}</div>
          </div>
        </button>
      )}

      <div className="flex w-full flex-col gap-2">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {showSaman && (
            <button
              onClick={() => onChange(saman.id)}
              data-testid="payment-gateway-samankish"
              className={classNames(
                "flex w-full flex-col items-center gap-2 text-nowrap rounded-lg border border-stone-50 bg-stone-50 p-4",
                selected === saman.id && "!border-infinity-primary",
              )}
              type="button"
            >
              <div className="relative h-24 w-24 flex-shrink-0 lg:h-32 lg:w-32">
                <Image
                  src={saman.img}
                  alt={saman.name}
                  fill
                  className="bg-stone-50 object-contain p-3"
                  sizes="(min-width: 1024px) 128px, 96px"
                />
              </div>
              <span className="text-sm lg:text-base">درگاه پرداخت {saman.name}</span>
            </button>
          )}

          {showMellat && (
            <button
              onClick={() => onChange(mellat.id)}
              data-testid="payment-gateway-mellat"
              className={classNames(
                "flex w-full flex-col items-center gap-2 text-nowrap rounded-lg border border-stone-50 bg-stone-50 p-4",
                selected === mellat.id && "!border-infinity-primary",
              )}
              type="button"
            >
              <div className="relative h-24 w-24 flex-shrink-0 lg:h-32 lg:w-32">
                <Image
                  src={mellat.img}
                  alt={mellat.name}
                  fill
                  className="bg-stone-50 object-contain p-3"
                  sizes="(min-width: 1024px) 128px, 96px"
                />
              </div>
              <span className="text-sm lg:text-base">درگاه پرداخت {mellat.name}</span>
            </button>
          )}

          {showZarinPal && (
            <button
              onClick={() => onChange(zarinpal.id)}
              data-testid="payment-gateway-zarinpal"
              data-selected={selected === zarinpal.id ? "true" : "false"}
              className={classNames(
                "flex w-full flex-col items-center gap-2 text-nowrap rounded-lg border border-stone-50 bg-stone-50 p-4",
                selected === zarinpal.id && "!border-infinity-primary",
              )}
              type="button"
            >
              <div className="relative h-24 w-24 flex-shrink-0 lg:h-32 lg:w-32">
                <Image
                  src={zarinpal.img}
                  alt={zarinpal.name}
                  fill
                  className="bg-stone-50 object-contain p-3"
                  sizes="(min-width: 1024px) 128px, 96px"
                />
              </div>
              <span className="text-sm lg:text-base">درگاه پرداخت {zarinpal.name}</span>
            </button>
          )}

        </div>
      </div>
    </div>
  );
}

export default ShoppingCartBillPaymentGateway;
