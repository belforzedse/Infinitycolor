import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import StockAdjustmentDialog from "./StockAdjustmentDialog";

describe("StockAdjustmentDialog", () => {
  const baseProps = {
    isOpen: true,
    adjusted: [{ name: "تیشرت آبی", requested: 5, newQuantity: 2 }],
    removed: [{ name: "شلوار مشکی" }],
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not render when closed", () => {
    render(<StockAdjustmentDialog {...baseProps} isOpen={false} />);
    expect(screen.queryByTestId("stock-adjustment-dialog")).not.toBeInTheDocument();
  });

  it("lists adjusted items with old and new quantities", () => {
    render(<StockAdjustmentDialog {...baseProps} />);
    const adjusted = screen.getByTestId("stock-adjusted-list");
    expect(adjusted).toHaveTextContent("تیشرت آبی");
    expect(adjusted).toHaveTextContent("کاهش یافت");
  });

  it("lists removed items as out of stock", () => {
    render(<StockAdjustmentDialog {...baseProps} />);
    const removed = screen.getByTestId("stock-removed-list");
    expect(removed).toHaveTextContent("شلوار مشکی");
    expect(removed).toHaveTextContent("حذف شد");
  });

  it("fires onConfirm when the user continues", () => {
    render(<StockAdjustmentDialog {...baseProps} />);
    fireEvent.click(screen.getByTestId("stock-adjustment-confirm"));
    expect(baseProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires onCancel when the user goes back", () => {
    render(<StockAdjustmentDialog {...baseProps} />);
    fireEvent.click(screen.getByTestId("stock-adjustment-cancel"));
    expect(baseProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while submitting", () => {
    render(<StockAdjustmentDialog {...baseProps} isSubmitting />);
    expect(screen.getByTestId("stock-adjustment-confirm")).toBeDisabled();
    expect(screen.getByTestId("stock-adjustment-cancel")).toBeDisabled();
  });

  it("omits a list when there are no items of that kind", () => {
    render(<StockAdjustmentDialog {...baseProps} removed={[]} />);
    expect(screen.queryByTestId("stock-removed-list")).not.toBeInTheDocument();
    expect(screen.getByTestId("stock-adjusted-list")).toBeInTheDocument();
  });
});
