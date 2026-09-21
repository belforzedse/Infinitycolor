"use client";

import { useEffect, useState } from "react";
import WalletIcon from "@/components/PLP/Icons/WalletIcon";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import WalletService from "@/services/wallet";
import { priceFormatter } from "@/utils/price";
import { heldBalanceTooltip } from "@/utils/walletHolds";

type MobileWalletBalanceProps = {
  isOpen: boolean;
  onNavigate: () => void;
};

export default function MobileWalletBalance({ isOpen, onNavigate }: MobileWalletBalanceProps) {
  const { isAuthenticated, isLoading } = useCurrentUser();
  const [balanceIrr, setBalanceIrr] = useState<number | null>(null);
  const [heldIrr, setHeldIrr] = useState<number>(0);

  useEffect(() => {
    if (!isOpen || isLoading || !isAuthenticated) {
      if (!isOpen) {
        setBalanceIrr(null);
        setHeldIrr(0);
      }
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
  }, [isAuthenticated, isLoading, isOpen]);

  const balanceToman = balanceIrr === null ? null : Math.round(balanceIrr / 10);
  const label =
    isAuthenticated && balanceToman !== null
      ? `${priceFormatter(balanceToman)} تومان`
      : "کیف پول";
  const heldLabel = isAuthenticated ? heldBalanceTooltip(heldIrr) : null;

  return (
    <a
      href="/wallet"
      onClick={onNavigate}
      data-testid="mobile-menu-wallet-balance"
      className="pressable inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 text-xs font-medium text-neutral-700 transition-colors hover:bg-stone-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
      dir="rtl"
    >
      <WalletIcon className="h-4 w-4 shrink-0" />
      <span>{label}</span>
      {heldLabel ? (
        <span data-testid="mobile-menu-wallet-held" className="text-[10px] text-amber-700">
          {heldLabel}
        </span>
      ) : null}
    </a>
  );
}
