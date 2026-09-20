"use client";

import { useEffect, useState } from "react";
import WalletIcon from "@/components/PLP/Icons/WalletIcon";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import WalletService from "@/services/wallet";
import { priceFormatter } from "@/utils/price";

type MobileWalletBalanceProps = {
  isOpen: boolean;
  onNavigate: () => void;
};

export default function MobileWalletBalance({ isOpen, onNavigate }: MobileWalletBalanceProps) {
  const { isAuthenticated, isLoading } = useCurrentUser();
  const [balanceIrr, setBalanceIrr] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen || isLoading || !isAuthenticated) {
      if (!isOpen) setBalanceIrr(null);
      return undefined;
    }

    let cancelled = false;
    WalletService.getMyWallet()
      .then((res) => {
        if (cancelled) return;
        if (res?.success && res.data) setBalanceIrr(Number(res.data.balance || 0));
        else setBalanceIrr(0);
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
    </a>
  );
}
