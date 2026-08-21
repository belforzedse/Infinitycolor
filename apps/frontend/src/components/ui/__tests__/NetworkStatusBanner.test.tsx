import { act, render, screen } from "@testing-library/react";
import NetworkStatusBanner from "../NetworkStatusBanner";

let offline = false;

jest.mock("next/offline", () => ({ useOffline: () => offline }));

describe("NetworkStatusBanner", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    offline = false;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("persists while offline and briefly confirms reconnection", () => {
    const onBackOnline = jest.fn();
    window.addEventListener("app:back-online", onBackOnline);
    const { rerender } = render(<NetworkStatusBanner />);
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();

    act(() => {
      offline = true;
      rerender(<NetworkStatusBanner />);
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent("اتصال اینترنت قطع است");

    act(() => {
      offline = false;
      rerender(<NetworkStatusBanner />);
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent("اتصال اینترنت برقرار شد");
    expect(onBackOnline).toHaveBeenCalledTimes(1);

    act(() => jest.advanceTimersByTime(3000));
    expect(screen.queryByTestId("network-status")).not.toBeInTheDocument();
    window.removeEventListener("app:back-online", onBackOnline);
  });
});
