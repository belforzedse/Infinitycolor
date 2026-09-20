import { useEffect, useState } from "react";
import WalletService from "@/services/wallet";

export default function WalletBalance() {
  const [balanceIrr, setBalanceIrr] = useState<number>(0);
  useEffect(() => {
    const run = async () => {
      try {
        const res = await WalletService.getMyWallet();
        if (res?.success && res.data) setBalanceIrr(Number(res.data.balance || 0));
      } catch {
        // The page still renders; a failed read keeps the last known zero.
      }
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
    </div>
  );
}
