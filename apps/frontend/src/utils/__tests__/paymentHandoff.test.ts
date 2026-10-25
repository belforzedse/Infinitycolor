import { submitPaymentHandoff, watchPaymentHandoff } from "../paymentHandoff";

describe("submitPaymentHandoff", () => {
  const navigate = jest.fn();
  const submit = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(HTMLFormElement.prototype, "submit", {
      value: submit,
      writable: true,
      configurable: true,
    });
  });

  it("navigates directly for GET providers such as ZarinPal sandbox", () => {
    expect(
      submitPaymentHandoff(
        {
          redirectUrl: "https://sandbox.zarinpal.com/pg/StartPay/AUTHORITY",
          redirectMethod: "GET",
        },
        navigate,
      ),
    ).toBe(true);

    expect(navigate).toHaveBeenCalledWith(
      "https://sandbox.zarinpal.com/pg/StartPay/AUTHORITY",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("posts SEP's exact capital-T Token without placing it in the URL", () => {
    const token = "SEP-TOKEN-SECRET";
    expect(
      submitPaymentHandoff({
        redirectUrl: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
        redirectMethod: "POST",
        formFields: { Token: token },
      }),
    ).toBe(true);

    const form = document.body.querySelector("form") as HTMLFormElement;
    const input = form.querySelector("input") as HTMLInputElement;
    expect(form.method).toBe("post");
    expect(form.action).toBe("https://sep.shaparak.ir/OnlinePG/OnlinePG");
    expect(form.action).not.toContain(token);
    expect(input.name).toBe("Token");
    expect(input.value).toBe(token);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("refuses an incomplete POST handoff", () => {
    expect(
      submitPaymentHandoff({
        redirectUrl: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
        redirectMethod: "POST",
      }),
    ).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("payment handoff watchdog", () => {
  let stop: (() => void) | undefined;
  const setVisibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  beforeEach(() => {
    jest.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    jest.useRealTimers();
    setVisibility("visible");
  });
  it("recovers only after ten visible seconds across hidden intervals", () => {
    const stalled = jest.fn();
    stop = watchPaymentHandoff(stalled);
    jest.advanceTimersByTime(4_000);
    setVisibility("hidden");
    jest.advanceTimersByTime(60_000);
    expect(stalled).not.toHaveBeenCalled();
    setVisibility("visible");
    jest.advanceTimersByTime(5_999);
    expect(stalled).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(stalled).toHaveBeenCalledTimes(1);
  });
  it("does not count an initially hidden page or recover after pagehide", () => {
    const stalled = jest.fn();
    setVisibility("hidden");
    stop = watchPaymentHandoff(stalled);
    jest.advanceTimersByTime(60_000);
    setVisibility("visible");
    jest.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event("pagehide"));
    jest.advanceTimersByTime(60_000);
    expect(stalled).not.toHaveBeenCalled();
  });
  it("removes work when its owner unmounts", () => {
    const stalled = jest.fn();
    stop = watchPaymentHandoff(stalled);
    stop();
    setVisibility("hidden");
    setVisibility("visible");
    jest.advanceTimersByTime(20_000);
    expect(stalled).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
