import { act, render, screen } from "@testing-library/react";
import NetworkStatusBanner from "../NetworkStatusBanner";

describe("NetworkStatusBanner", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("persists while offline and briefly confirms reconnection", () => {
    const onBackOnline = jest.fn();
    window.addEventListener("app:back-online", onBackOnline);
    render(<NetworkStatusBanner />);
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent("اتصال اینترنت قطع است");

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent("اتصال اینترنت برقرار شد");
    expect(onBackOnline).toHaveBeenCalledTimes(1);

    act(() => jest.advanceTimersByTime(3000));
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();
    window.removeEventListener("app:back-online", onBackOnline);
  });

  it("does not infer connectivity from route or authorization failures", () => {
    render(<NetworkStatusBanner />);
    act(() => {
      window.dispatchEvent(new Event("popstate"));
      window.dispatchEvent(new CustomEvent("app:auth-error", { detail: { status: 401 } }));
    });
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();
  });
  it("deduplicates online events and cancels the previous recovery timer", () => {
    render(<NetworkStatusBanner />);
    const recovered = jest.fn();
    window.addEventListener("app:back-online", recovered);
    act(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); });
    act(() => jest.advanceTimersByTime(2000));
    act(() => { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("online")); });
    act(() => jest.advanceTimersByTime(1500));
    expect(recovered).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("network-status")).toHaveTextContent("برقرار شد");
    act(() => jest.advanceTimersByTime(1500));
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();
    window.removeEventListener("app:back-online", recovered);
  });

});
