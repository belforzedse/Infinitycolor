import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import GlobalError from "./global-error";
import {
  retryStorefrontError,
  reportStorefrontError,
  exhaustStorefrontRecovery,
  RECOVERY_WINDOW_MS,
} from "@/lib/storefront-recovery";

jest.mock("@/lib/storefront-recovery", () => ({
  RECOVERY_WINDOW_MS: 30_000,
  retryStorefrontError: jest.fn(() => true),
  reportStorefrontError: jest.fn(),
  exhaustStorefrontRecovery: jest.fn(),
}));

// This boundary owns the document, including <html> and <body>.
function renderBoundary(element: ReactNode) {
  const root = createRoot(document);
  act(() => root.render(element));
  return { unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

it("reports a root retry that never commits once, including under StrictMode", () => {
  jest.useFakeTimers();
  const error = new Error("Connection closed.");
  const retry = jest.fn();
  const view = renderBoundary(
    <StrictMode>
      <GlobalError error={error} retry={retry} />
    </StrictMode>,
  );
  expect(retryStorefrontError).toHaveBeenCalledTimes(1);
  expect(reportStorefrontError).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(RECOVERY_WINDOW_MS));
  expect(exhaustStorefrontRecovery).toHaveBeenCalledTimes(1);
  expect(exhaustStorefrontRecovery).toHaveBeenCalledWith(error, "root-layout");
  view.unmount();
});

it("cancels the exhausted-retry report when the boundary leaves after recovery", () => {
  jest.useFakeTimers();
  const view = renderBoundary(
    <GlobalError error={new Error("Failed to fetch")} retry={jest.fn()} />,
  );
  view.unmount();
  act(() => jest.advanceTimersByTime(RECOVERY_WINDOW_MS));
  expect(reportStorefrontError).not.toHaveBeenCalled();
});
