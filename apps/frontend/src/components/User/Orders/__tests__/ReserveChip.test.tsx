import React from "react";
import { render, screen } from "@testing-library/react";
import ReserveChip from "../ReserveChip";

/**
 * The order's `reserveExpiresAt` column is frozen at creation, so a chip driven by
 * it alone would keep counting down on a group that closed hours ago. These tests
 * pin the gate to the server-derived `reserveIsActive`.
 */
describe("ReserveChip", () => {
  const future = new Date(Date.now() + 5 * 3_600_000).toISOString();
  const past = new Date(Date.now() - 5 * 3_600_000).toISOString();

  it("renders nothing for an order that never joined a group", () => {
    const { container } = render(<ReserveChip isReserveOrder={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("counts down while the window is open", () => {
    render(
      <ReserveChip
        isReserveOrder
        reserveIsActive
        reserveState="Active"
        reserveExpiresAt={future}
        groupOrderCount={3}
      />,
    );

    const chip = screen.getByTestId("reserve-chip-active");
    expect(chip).toHaveTextContent("ارسال رزروی");
    // Persian-digit compact countdown, e.g. «۴س ۵۹د».
    expect(chip).toHaveTextContent(/[۰-۹]+س [۰-۹]+د/);
    expect(chip).toHaveTextContent("۳ سفارش");
    expect(screen.queryByTestId("reserve-chip-closed")).not.toBeInTheDocument();
  });

  it("states the outcome instead of a countdown once the window has closed", () => {
    render(
      <ReserveChip
        isReserveOrder
        reserveIsActive={false}
        reserveState="ReadyToFulfill"
        reserveClosureReason="Expired"
        // The frozen column still holds a timestamp; it must not drive the chip.
        reserveExpiresAt={past}
      />,
    );

    expect(screen.queryByTestId("reserve-chip-active")).not.toBeInTheDocument();
    expect(screen.getByTestId("reserve-chip-closed")).toHaveTextContent(
      "مهلت رزرو پایان یافته / آماده ارسال",
    );
  });

  it("keeps an early release distinguishable from an automatic expiry", () => {
    render(
      <ReserveChip
        isReserveOrder
        reserveIsActive={false}
        reserveState="ReadyToFulfill"
        reserveClosureReason="ReleasedEarly"
      />,
    );

    expect(screen.getByTestId("reserve-chip-closed")).toHaveTextContent("آزادسازی زودهنگام");
  });

  it("does not resurrect a countdown from a stale deadline on a completed group", () => {
    render(
      <ReserveChip
        isReserveOrder
        reserveIsActive={false}
        reserveState="Completed"
        reserveExpiresAt={future}
      />,
    );

    expect(screen.queryByTestId("reserve-chip-active")).not.toBeInTheDocument();
    expect(screen.getByTestId("reserve-chip-closed")).toHaveTextContent("ارسال شده");
  });
});
