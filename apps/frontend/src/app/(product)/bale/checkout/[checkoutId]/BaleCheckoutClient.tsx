"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PageContainer from "@/components/layout/PageContainer";
import ShoppingCartBillForm from "@/components/ShoppingCart/Bill";
import {
  BaleCheckoutCartProvider,
  useBaleCheckoutCart,
  type BaleRecipient,
} from "@/contexts/BaleCheckoutCart";
import { centralAuth, centralLoginUrl, subscribeToAuthState } from "@/lib/central-auth";
import { apiClient, CartService } from "@/services";
import type { CartResponse, CheckoutGatewayCode } from "@/services/cart/types/cart";
import { unwrap } from "@/services/cart/helpers/response";
import { submitPaymentHandoff } from "@/utils/paymentHandoff";
import { faNum } from "@/utils/faNum";

type Handoff = {
  checkoutId: string;
  orderId: number | null;
  expiresAt: string;
  baleReturnUrl: string;
  recipient?: BaleRecipient;
  shippingMethodId?: number | null;
  resume?: { gateway: CheckoutGatewayCode; attemptId: string; quoteHash: string };
};

const checkoutIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const grantPattern = /^[A-Za-z0-9_-]{43}$/;
const unusableLink = "این لینک سفارش معتبر نیست یا مهلت آن تمام شده است. از ربات بله لینک تازه بگیرید.";

function SelectedItems() {
  const cart = useBaleCheckoutCart();
  return (
    <section id="bale-checkout-items" className="scroll-mt-24 border-b border-neutral-200 pb-5">
      <h1 className="mb-3 text-xl font-semibold text-neutral-900">سفارش شما از بله</h1>
      <ul className="divide-y divide-neutral-200">
        {cart?.cartItems.map((item) => (
          <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
            <span className="text-neutral-900">
              {item.name}
              {[item.color, item.size, item.model].filter(Boolean).length > 0 && (
                <span className="ms-2 text-neutral-600">
                  {[item.color, item.size, item.model].filter(Boolean).join("، ")}
                </span>
              )}
            </span>
            <span className="text-neutral-700">{faNum(item.quantity)} عدد</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function BaleCheckoutClient({ checkoutId }: { checkoutId: string }) {
  const router = useRouter();
  const grantInTab = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState<{ handoff: Handoff; cart: CartResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Handoff | null>(null);
  const [resuming, setResuming] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => subscribeToAuthState(() => {
    setReady(null);
    setPending(null);
    setError(null);
    setRetry((value) => value + 1);
  }), []);

  useEffect(() => {
    if (!checkoutIdPattern.test(checkoutId)) {
      setError(unusableLink);
      return;
    }

    const path = `/bale/checkout/${checkoutId}`;
    const key = `bale-checkout-grant:${checkoutId}`;
    const hash = window.location.hash.slice(1);
    if (hash) {
      grantInTab.current = grantPattern.test(hash) ? hash : undefined;
      window.history.replaceState(null, "", path);
    }
    let storedGrant = false;
    try {
      if (grantInTab.current) window.sessionStorage.setItem(key, grantInTab.current);
      else grantInTab.current = window.sessionStorage.getItem(key) || undefined;
      storedGrant = Boolean(grantInTab.current);
    } catch {
      // A shopper with storage disabled can still claim a link while signed in.
    }

    let active = true;
    const load = async () => {
      const auth = await centralAuth.tokenManager.getTokenOutcome();
      if (!active) return;
      if (auth.state === "unauthenticated") {
        if (grantInTab.current && !storedGrant) {
          setError("ابتدا وارد حساب خود شوید و سپس لینک سفارش را دوباره از بله باز کنید.");
          return;
        }
        window.location.replace(centralLoginUrl(path));
        return;
      }

      if (auth.state !== "authenticated") throw new Error("AUTH_UNAVAILABLE");

      const grant = grantInTab.current;
      const endpoint = `/bale/checkout/${checkoutId}`;
      const response = grant
        ? await apiClient.post<Handoff>(`${endpoint}/claim`, { grant }, { retries: 0 })
        : await apiClient.get<Handoff>(endpoint, { cache: "no-store" });
      if (!active) return;
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Ownership is recorded on the server.
      }
      grantInTab.current = undefined;
      const handoff = unwrap<Handoff>(response);
      if (handoff.orderId) {
        if (handoff.resume) setPending(handoff);
        else router.replace(`/payment/result?orderId=${handoff.orderId}`);
        return;
      }
      const cart = await CartService.getUserCart(checkoutId);
      if (active) setReady({ handoff, cart });
    };

    void load().catch((failure: unknown) => {
      if (!active) return;
      const status = (failure as { status?: number } | null)?.status;
      setError([403, 404, 410].includes(Number(status))
        ? unusableLink
        : "سفارش بارگیری نشد. لطفاً دوباره تلاش کنید.");
    });
    return () => { active = false; };
  }, [checkoutId, retry, router]);

  const resume = async () => {
    if (!pending?.resume || resuming) return;
    setResuming(true);
    setError(null);
    try {
      const result = await CartService.finalizeCart(pending.resume, checkoutId);
      if (result.redirectUrl && submitPaymentHandoff(result)) return;
      router.replace(`/payment/result?orderId=${pending.orderId}`);
    } catch {
      setError("ادامه پرداخت ممکن نشد. وضعیت سفارش را بررسی کنید.");
      setResuming(false);
    }
  };

  return (
    <PageContainer variant="wide" className="space-y-6 pb-16 pt-8">
      {pending ? (
        <div className="min-h-[35vh] space-y-4 text-neutral-800">
          <h1 className="text-xl font-semibold">پرداخت سفارش بله</h1>
          {error && <p role="alert">{error}</p>}
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              className="rounded-xl bg-infinity-primary px-5 py-3 font-medium text-white disabled:opacity-60"
              onClick={() => void resume()}
              disabled={resuming}
            >
              {resuming ? "در حال بررسی…" : "ادامه پرداخت"}
            </button>
            <a
              className="font-medium text-infinity-primary underline underline-offset-4"
              href={`/payment/result?orderId=${pending.orderId}`}
            >
              مشاهده نتیجه پرداخت
            </a>
          </div>
        </div>
      ) : ready ? (
        <BaleCheckoutCartProvider
          checkoutId={checkoutId}
          initialCart={ready.cart}
          recipient={ready.handoff.recipient}
          shippingMethodId={ready.handoff.shippingMethodId}
        >
          <SelectedItems />
          <ShoppingCartBillForm baleReturnUrl={ready.handoff.baleReturnUrl} />
        </BaleCheckoutCartProvider>
      ) : (
        <div className="min-h-[35vh] space-y-3 text-neutral-800">
          <h1 className="text-xl font-semibold">سفارش شما از بله</h1>
          {error ? (
            <>
              <p role="alert">{error}</p>
              {error !== unusableLink && (
                <button
                  type="button"
                  className="font-medium text-infinity-primary underline underline-offset-4"
                  onClick={() => { setError(null); setRetry((value) => value + 1); }}
                >
                  تلاش دوباره
                </button>
              )}
            </>
          ) : <p role="status">در حال بارگیری سفارش…</p>}
        </div>
      )}
    </PageContainer>
  );
}
