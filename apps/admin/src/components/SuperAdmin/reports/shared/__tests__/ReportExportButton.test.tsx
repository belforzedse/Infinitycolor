import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ReportExportButton from "../ReportExportButton";

describe("ReportExportButton", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("calls onExport when clicked and shows the loading label meanwhile", async () => {
    let resolveExport: () => void = () => {};
    const onExport = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = resolve;
        }),
    );
    render(<ReportExportButton onExport={onExport} />);

    fireEvent.click(screen.getByText("دریافت اکسل"));
    expect(onExport).toHaveBeenCalledTimes(1);
    await screen.findByText("در حال آماده‌سازی...");
    expect(screen.getByRole("button")).toBeDisabled();

    resolveExport();
    await waitFor(() => expect(screen.getByText("دریافت اکسل")).toBeInTheDocument());
  });

  it("alerts and re-enables the button when onExport rejects", async () => {
    const alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
    const onExport = jest.fn().mockRejectedValue(new Error("network down"));
    render(<ReportExportButton onExport={onExport} />);

    fireEvent.click(screen.getByText("دریافت اکسل"));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("خطا در دریافت خروجی اکسل"));
    expect(screen.getByRole("button")).not.toBeDisabled();
  });

  it("supports custom labels", () => {
    render(
      <ReportExportButton
        onExport={jest.fn().mockResolvedValue(undefined)}
        label="خروجی سفارشی"
        errorMessage="خطای سفارشی"
      />,
    );
    expect(screen.getByText("خروجی سفارشی")).toBeInTheDocument();
  });
});
