"use client";

import { useCallback, useEffect, useState } from "react";

const toPersianDigits = (value: string) =>
  value.replace(/[0-9]/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)] ?? digit);

export function useOtpCountdown(initialSeconds = 120) {
  const [seconds, setSeconds] = useState(initialSeconds);
  const [active, setActive] = useState(true);
  const restart = useCallback(() => {
    setSeconds(initialSeconds);
    setActive(true);
  }, [initialSeconds]);

  useEffect(() => {
    if (!active) return;
    if (seconds <= 0) {
      setActive(false);
      return;
    }
    const timer = window.setTimeout(
      () => setSeconds((current) => current - 1),
      1_000,
    );
    return () => window.clearTimeout(timer);
  }, [active, seconds]);

  const timeLeft = toPersianDigits(
    `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`,
  );
  return { timeLeft, active, restart };
}
