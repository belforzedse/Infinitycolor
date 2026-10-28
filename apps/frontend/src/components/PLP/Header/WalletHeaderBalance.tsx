"use client";

import { useEffect, useState } from "react";
import WalletIcon from "@/components/PLP/Icons/WalletIcon";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import WalletService from "@/services/wallet";
import { priceFormatter } from "@/utils/price";
import { heldBalanceTooltip } from "@/utils/walletHolds";

type WalletHeaderBalanceProps = {
  className: string;
};

export default function WalletHeaderBalance({ className }: WalletHeaderBalanceProps) {
  const { isAuthenticated, isLoading } = useCurrentUser();
  const [balanceIrr, setBalanceIrr] = useState<number | null>(null);
  const [heldIrr, setHeldIrr] = useState<number>(0);

  useEffect(() => {
    if (isLoading || !isAuthenticated) {
      setBalanceIrr(null);
      setHeldIrr(0);
      return undefined;
    }

    let cancelled = false;
    WalletService.getMyWallet()
      .then((res) => {
        if (cancelled) return;
        if (res?.success && res.data) {
          const balance = Number(res.data.balance || 0);
          const held = Number(res.data.heldBalance || 0);
          setHeldIrr(held);
          // The chip shows spendable credit, so it never offers money the
          // checkout is going to refuse.
          setBalanceIrr(
            res.data.availableBalance != null
              ? Number(res.data.availableBalance)
              : Math.max(0, balance - held),
          );
        } else {
          setBalanceIrr(0);
          setHeldIrr(0);
        }
      })
      .catch(() => {
        if (!cancelled) setBalanceIrr(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isLoading]);

  const balanceToman = balanceIrr === null ? null : Math.round(balanceIrr / 10);
  const balanceLabel =
    balanceToman === null ? "کیف پول" : `${priceFormatter(balanceToman)} تومان`;
  const heldTooltip = heldBalanceTooltip(heldIrr);

  return (
    <div className="group/wallet relative">
      <a href="/wallet" aria-label={balanceLabel} className={className}>
        <WalletIcon className="h-6 w-6" />
      </a>
      {isAuthenticated ? (
        <div
          role="tooltip"
          data-testid="wallet-header-balance"
          className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover/wallet:opacity-100 group-focus-within/wallet:opacity-100"
          dir="rtl"
        >
          {balanceToman === null ? "در حال دریافت موجودی…" : `${priceFormatter(balanceToman)} تومان`}
          {heldTooltip ? (
            <span className="mt-1 block text-[11px] text-white/80">{heldTooltip}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
