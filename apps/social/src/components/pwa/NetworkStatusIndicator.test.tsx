import { act, render, screen } from "@testing-library/react";
import { useOffline } from "next/offline";
import { NetworkStatusIndicator } from "./NetworkStatusIndicator";

jest.mock("next/offline", () => ({
  useOffline: jest.fn(),
}));

const mockedUseOffline = jest.mocked(useOffline);

describe("NetworkStatusIndicator", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedUseOffline.mockReturnValue(false);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("ignores a brief offline transition", () => {
    const { rerender } = render(<NetworkStatusIndicator />);

    mockedUseOffline.mockReturnValue(true);
    rerender(<NetworkStatusIndicator />);
    act(() => jest.advanceTimersByTime(1000));

    mockedUseOffline.mockReturnValue(false);
    rerender(<NetworkStatusIndicator />);
    act(() => jest.runOnlyPendingTimers());

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows one stable offline notice and hides it immediately on recovery", () => {
    const { rerender } = render(<NetworkStatusIndicator />);

    mockedUseOffline.mockReturnValue(true);
    rerender(<NetworkStatusIndicator />);
    act(() => jest.advanceTimersByTime(1500));

    expect(screen.getByRole("status")).toHaveTextContent("بدون اتصال اینترنت");
    expect(screen.queryByText("اتصال برقرار شد")).not.toBeInTheDocument();

    mockedUseOffline.mockReturnValue(false);
    rerender(<NetworkStatusIndicator />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
