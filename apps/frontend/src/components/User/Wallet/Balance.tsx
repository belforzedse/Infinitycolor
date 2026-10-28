import { useEffect, useState } from "react";
import Link from "next/link";
import WalletService, { type WalletHold } from "@/services/wallet";
import {
  heldBalanceMessage,
  holdsAreReconciling,
  primaryHold,
} from "@/utils/walletHolds";

export default function WalletBalance() {
  const [balanceIrr, setBalanceIrr] = useState<number>(0);
  const [availableIrr, setAvailableIrr] = useState<number>(0);
  const [heldIrr, setHeldIrr] = useState<number>(0);
  const [holds, setHolds] = useState<WalletHold[]>([]);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const res = await WalletService.getMyWallet();
        if (cancelled || !res?.success || !res.data) return false;
        const balance = Number(res.data.balance || 0);
        const held = Number(res.data.heldBalance || 0);
        setBalanceIrr(balance);
        setHeldIrr(held);
        setAvailableIrr(
          res.data.availableBalance != null
            ? Number(res.data.availableBalance)
            : Math.max(0, balance - held),
        );
        setHolds(Array.isArray(res.data.holds) ? res.data.holds : []);
        return holdsAreReconciling(res.data.holds);
      } catch {
        // The page still renders; a failed read keeps the last known values.
        return false;
      }
    };

    // Reading the page is itself what nudges the backend to re-check the
    // provider, so a shopper who lands here shortly after an abandoned checkout
    // usually sees the money return without doing anything. Two short re-reads
    // cover that window; after them the periodic worker takes over.
    void (async () => {
      const stillReconciling = await read();
      if (!stillReconciling || cancelled) return;
      setTimeout(() => void read(), 3_000);
      setTimeout(() => void read(), 8_000);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const heldMessage = heldBalanceMessage(heldIrr, holds);
  const newestHold = primaryHold(holds);

  return (
    <div className="flex w-full flex-col items-end gap-3 lg:w-2/5">
      <div
        className="flex h-[199px] w-full flex-col items-start gap-10 rounded-2xl p-5"
        style={{
          background: "linear-gradient(66.02deg, #3d4c6e 0%, #98BDFF 84.01%)",
        }}
      >
        <span className="text-[20px] text-white">کیف پول اینفینیتی</span>
        <span className="text-[36px] text-white">
          {/* The spendable number, not the posted one: showing the gross
              balance while part of it is committed is what made held money look
              like it had simply disappeared. */}
          {(availableIrr / 10).toLocaleString()} تومان
        </span>
        {heldIrr > 0 ? (
          <span className="-mt-8 text-[13px] text-white/80">
            موجودی کل: {(balanceIrr / 10).toLocaleString()} تومان
          </span>
        ) : null}
      </div>
      {heldMessage ? (
        <p
          data-testid="wallet-held-notice"
          className="w-full rounded-xl bg-amber-50 p-3 text-right text-[13px] leading-6 text-amber-900"
        >
          {heldMessage}
          {newestHold?.orderId ? (
            <>
              {" "}
              <Link
                href={`/payment/result?orderId=${newestHold.orderId}`}
                className="underline"
              >
                مشاهده وضعیت پرداخت
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
