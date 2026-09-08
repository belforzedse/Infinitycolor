import CirculePlusIcon from "@/components/User/Icons/CirculePlusIcon";
import { useEffect, useState } from "react";
import WalletService from "@/services/wallet";

type WalletBalanceProps = {
  /** Mirrors the wallet page: top-up is currently switched off site-wide. */
  chargeDisabled?: boolean;
  /** Moves focus to the top-up amounts once charging is enabled again. */
  onIncrease?: () => void;
};

export default function WalletBalance({ chargeDisabled = false, onIncrease }: WalletBalanceProps) {
  const [balanceIrr, setBalanceIrr] = useState<number>(0);
  useEffect(() => {
    const run = async () => {
      try {
        const res = await WalletService.getMyWallet();
        if (res?.success && res.data) setBalanceIrr(Number(res.data.balance || 0));
      } catch {}
    };
    run();
  }, []);
  return (
    <div className="flex w-full flex-col items-end gap-3 lg:w-2/5">
      <div
        className="flex h-[199px] w-full flex-col items-start gap-10 rounded-2xl p-5"
        style={{
          background: "linear-gradient(66.02deg, #3d4c6e 0%, #98BDFF 84.01%)",
        }}
      >
        <span className="text-[20px] text-white">کیف پول اینفینیتی</span>
        <span className="text-[36px] text-white">{(balanceIrr / 10).toLocaleString()} تومان</span>
      </div>

      {/*
        This button carried no handler and no disabled state, so it looked live
        and did nothing at all — the reported "top-up does nothing". The page's
        other top-up entry point was already correctly disabled behind a notice;
        this one now matches it, and takes the customer to the amounts once
        charging is switched back on.
      */}
      <button
        type="button"
        disabled={chargeDisabled}
        onClick={onIncrease}
        aria-describedby={chargeDisabled ? "wallet-charge-disabled-notice" : undefined}
        className="flex items-center gap-1 rounded-lg disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="text-base text-infinity-primary">افزایش موجودی</span>
        <CirculePlusIcon />
      </button>
    </div>
  );
}
