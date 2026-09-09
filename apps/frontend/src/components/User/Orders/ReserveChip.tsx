"use client";

import React from "react";
import { Clock, Package } from "lucide-react";
import { faNum } from "@/utils/faNum";
import {
  formatReserveCountdown,
  formatReserveDeadline,
  reserveStateLabel,
} from "@/utils/reserveTime";

export interface ReserveChipProps {
  isReserveOrder?: boolean;
  reserveExpiresAt?: string | null;
  reserveState?: string | null;
  reserveClosureReason?: string | null;
  /** Server-derived: the window is open AND its deadline is still ahead. */
  reserveIsActive?: boolean;
  groupOrderCount?: number;
}

/**
 * The reserve marker on an order row/card.
 *
 * It keys off `reserveIsActive`, never off `isReserveOrder`: membership is
 * permanent, the window is not. The order's `reserveExpiresAt` column is frozen at
 * creation, so a closed group would otherwise keep rendering a live countdown.
 * A closed group still shows a chip -- reserve history must not disappear -- but
 * it states the outcome instead of a deadline.
 */
export default function ReserveChip({
  isReserveOrder,
  reserveExpiresAt,
  reserveState,
  reserveClosureReason,
  reserveIsActive,
  groupOrderCount,
}: ReserveChipProps) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!reserveIsActive) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [reserveIsActive]);

  if (!isReserveOrder) return null;

  const count =
    groupOrderCount && groupOrderCount > 1 ? ` • ${faNum(groupOrderCount)} سفارش` : "";

  if (reserveIsActive && reserveExpiresAt) {
    return (
      <span
        data-testid="reserve-chip-active"
        title={`مهلت افزودن سفارش تا ${formatReserveDeadline(reserveExpiresAt)}`}
        className="flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800"
      >
        <Clock className="h-3.5 w-3.5" />
        ارسال رزروی ({formatReserveCountdown(reserveExpiresAt, now)})
        {count}
      </span>
    );
  }

  return (
    <span
      data-testid="reserve-chip-closed"
      className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-700"
    >
      <Package className="h-3.5 w-3.5" />
      ارسال رزروی — {reserveStateLabel(reserveState, reserveClosureReason)}
      {count}
    </span>
  );
}
