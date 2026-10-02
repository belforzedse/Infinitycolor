"use client";

import { useCart } from "@/contexts/CartContext";

export default function AuthRecoveryNotice() {
  const { retryAuthRecovery } = useCart();
  return (
    <div role="alert" className="p-6 text-center" dir="rtl">
      <p>بازیابی سبد خرید موقتاً ممکن نیست.</p>
      <button
        type="button"
        onClick={retryAuthRecovery}
        className="mt-4 min-h-11 rounded-xl bg-infinity-primary px-5 py-2 text-white"
      >
        تلاش دوباره
      </button>
    </div>
  );
}
