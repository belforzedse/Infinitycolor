import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { priceFormatter } from "@/utils/price";
import IncreaseBalance from "./IncreaseBalance";
import WalletService from "@/services/wallet";

jest.mock("@/services/wallet", () => ({
  __esModule: true,
  default: { startTopup: jest.fn() },
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { error: jest.fn(), success: jest.fn() },
}));

const startTopup = WalletService.startTopup as jest.Mock;

const options = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  disabledReason: null,
  gateways: [{ code: "Mellat", title: "بانک ملت" }],
  minToman: 10_000,
  maxToman: 50_000_000,
  presetsToman: [100_000, 200_000],
  maxPending: 3,
  ...over,
}) as never;

describe("IncreaseBalance", () => {
  // jsdom implements neither navigation nor form submission, and its `location`
  // is read-only — so the redirect is injected rather than stubbed globally.
  const assign = jest.fn();
  const submit = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(HTMLFormElement.prototype, "submit", {
      value: submit,
      writable: true,
      configurable: true,
    });
  });

  it("refuses an amount below the store minimum before contacting the server", async () => {
    render(<IncreaseBalance options={options()} navigate={assign} />);

    fireEvent.change(screen.getByTestId("wallet-topup-amount"), { target: { value: "5000" } });

    expect(screen.getByTestId("wallet-topup-amount-error")).toHaveTextContent(
      `حداقل مبلغ شارژ ${priceFormatter(10_000)} تومان است.`,
    );
    expect(screen.getByTestId("wallet-topup-submit")).toBeDisabled();
    expect(startTopup).not.toHaveBeenCalled();
  });

  it("accepts Persian digits and sends the amount in toman", async () => {
    startTopup.mockResolvedValue({
      success: true,
      saleOrderId: "1700000000100",
      redirectUrl: "https://gateway.test/pay",
      redirectMethod: "GET",
    });
    render(<IncreaseBalance options={options()} navigate={assign} />);

    fireEvent.change(screen.getByTestId("wallet-topup-amount"), {
      target: { value: "۳۵۰٬۰۰۰" },
    });
    fireEvent.click(screen.getByTestId("wallet-topup-submit"));

    await waitFor(() => expect(startTopup).toHaveBeenCalledTimes(1));
    expect(startTopup).toHaveBeenCalledWith(
      expect.objectContaining({ amountToman: 350_000, gateway: "Mellat" }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://gateway.test/pay"));
  });

  it("rejects a malformed amount instead of coercing it", () => {
    render(<IncreaseBalance options={options()} navigate={assign} />);

    fireEvent.change(screen.getByTestId("wallet-topup-amount"), { target: { value: "12a3" } });

    expect(screen.getByTestId("wallet-topup-amount-error")).toHaveTextContent(
      "مبلغ را با عدد وارد کنید.",
    );
    expect(screen.getByTestId("wallet-topup-submit")).toBeDisabled();
  });

  it("sends one idempotency key for repeated taps so a double submit cannot open two payments", async () => {
    let resolveStart: (value: unknown) => void = () => {};
    startTopup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    render(<IncreaseBalance options={options()} navigate={assign} />);

    const button = screen.getByTestId("wallet-topup-submit");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // The button disables itself while a request is in flight, and the key is
    // stable so even a request that does get through is recognised as a repeat.
    expect(startTopup).toHaveBeenCalledTimes(1);
    const firstKey = startTopup.mock.calls[0][0].idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));

    resolveStart({ success: true, redirectUrl: "https://gateway.test/pay", redirectMethod: "GET" });
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });

  it("posts a form when the provider requires one", async () => {
    startTopup.mockResolvedValue({
      success: true,
      redirectUrl: "https://bpm.shaparak.ir/pay",
      redirectMethod: "POST",
      formFields: { RefId: "MELLAT-REF-1" },
    });
    render(<IncreaseBalance options={options()} navigate={assign} />);

    fireEvent.click(screen.getByTestId("wallet-topup-submit"));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
  });

  it("tracks an accepted uncertain intent and polls instead of opening another payment", async () => {
    const onTopupStarted = jest.fn();
    startTopup.mockResolvedValue({
      success: true,
      saleOrderId: "1700000000200",
      topupStatus: "Unknown",
      nextAction: "poll",
    });
    render(
      <IncreaseBalance
        options={options()}
        navigate={assign}
        onTopupStarted={onTopupStarted}
      />,
    );

    fireEvent.click(screen.getByTestId("wallet-topup-submit"));

    await waitFor(() => expect(onTopupStarted).toHaveBeenCalledWith("1700000000200"));
    expect(assign).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("mints a new key only after the server declares the old intent terminal", async () => {
    startTopup
      .mockResolvedValueOnce({
        success: false,
        saleOrderId: "1700000000300",
        topupStatus: "Failed",
        nextAction: "retry",
        message: "پرداخت انجام نشد.",
      })
      .mockResolvedValueOnce({
        success: true,
        saleOrderId: "1700000000301",
        redirectUrl: "https://gateway.test/pay",
        redirectMethod: "GET",
        nextAction: "redirect",
      });
    render(<IncreaseBalance options={options()} navigate={assign} />);

    const button = screen.getByTestId("wallet-topup-submit");
    fireEvent.click(button);
    await waitFor(() => expect(startTopup).toHaveBeenCalledTimes(1));
    const firstKey = startTopup.mock.calls[0][0].idempotencyKey;

    fireEvent.click(button);
    await waitFor(() => expect(startTopup).toHaveBeenCalledTimes(2));
    expect(startTopup.mock.calls[1][0].idempotencyKey).not.toBe(firstKey);
  });

  it("retains the key after an ambiguous transport error", async () => {
    startTopup
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({
        success: true,
        saleOrderId: "1700000000400",
        topupStatus: "Unknown",
        nextAction: "poll",
      });
    render(<IncreaseBalance options={options()} navigate={assign} />);

    const button = screen.getByTestId("wallet-topup-submit");
    fireEvent.click(button);
    await waitFor(() => expect(startTopup).toHaveBeenCalledTimes(1));
    const firstKey = startTopup.mock.calls[0][0].idempotencyKey;

    fireEvent.click(button);
    await waitFor(() => expect(startTopup).toHaveBeenCalledTimes(2));
    expect(startTopup.mock.calls[1][0].idempotencyKey).toBe(firstKey);
  });

  it("mints a new key after an HTTP error declares the intent terminal", async () => {
    startTopup
      .mockRejectedValueOnce({
        response: {
          data: {
            data: {
              nextAction: "retry",
              message: "پرداخت انجام نشد.",
            },
          },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        saleOrderId: "1700000000501",
        redirectUrl: "https://gateway.test/pay",
        redirectMethod: "GET",
        nextAction: "redirect",
      });
    render(<IncreaseBalance options={options()} navigate={assign} />);

    const button = screen.getByTestId("wallet-topup-submit");
    fireEvent.click(button);
    await waitFor(() => expect(startTopup).toHaveBeenCalledTimes(1));
    const firstKey = startTopup.mock.calls[0][0].idempotencyKey;

    fireEvent.click(button);
    await waitFor(() => expect(startTopup).toHaveBeenCalledTimes(2));
    expect(startTopup.mock.calls[1][0].idempotencyKey).not.toBe(firstKey);
  });

  it("is inert while the capability is switched off", () => {
    render(<IncreaseBalance options={options({ enabled: false })} navigate={assign} />);

    expect(screen.getByTestId("wallet-topup-submit")).toBeDisabled();
    expect(screen.getByTestId("wallet-topup-amount")).toBeDisabled();
  });

  it("offers a gateway choice only when there is a choice to make", () => {
    const { rerender } = render(<IncreaseBalance options={options()} navigate={assign} />);
    expect(screen.queryByText("درگاه پرداخت")).not.toBeInTheDocument();

    rerender(
      <IncreaseBalance
        navigate={assign}
        options={options({
          gateways: [
            { code: "Mellat", title: "بانک ملت" },
            { code: "ZarinPal", title: "زرین‌پال" },
          ],
        })}
      />,
    );
    expect(screen.getByText("درگاه پرداخت")).toBeInTheDocument();
  });
});
