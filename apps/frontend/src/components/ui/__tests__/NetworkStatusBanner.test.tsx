import { act, render, screen } from "@testing-library/react";
import NetworkStatusBanner from "../NetworkStatusBanner";

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value,
  });
}

describe("NetworkStatusBanner", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setOnline(true);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("persists while offline and briefly confirms reconnection", () => {
    render(<NetworkStatusBanner />);
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent("اتصال اینترنت قطع است");

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent("اتصال اینترنت برقرار شد");

    act(() => jest.advanceTimersByTime(3000));
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();
  });
});
