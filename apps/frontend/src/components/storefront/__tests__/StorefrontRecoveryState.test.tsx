import { fireEvent, render, screen } from "@testing-library/react";
import StorefrontRecoveryState from "../StorefrontRecoveryState";

const captureException = jest.fn();
const setTag = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  withScope: (callback: (scope: { setTag: typeof setTag }) => void) =>
    callback({ setTag }),
}));

const TRANSIENT_RETRY_OFFSET_MS = 31_000;

describe("StorefrontRecoveryState", () => {
  const originalDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  afterEach(() => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = originalDsn;
    jest.clearAllMocks();
  });

  it("provides a focused, semantic recovery path", () => {
    const retry = jest.fn();

    render(
      <StorefrontRecoveryState
        surface="catalog"
        title="بارگذاری کامل نشد"
        message="دوباره تلاش کنید"
        onRetry={retry}
      />,
    );

    const alert = screen.getByRole("alert");
    const heading = screen.getByRole("heading", { name: "بارگذاری کامل نشد" });
    expect(alert).toHaveAttribute("dir", "rtl");
    expect(heading).toHaveFocus();
    expect(screen.getByRole("link", { name: "بازگشت به فروشگاه" })).toHaveAttribute(
      "href",
      "/",
    );

    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("reports only fixed diagnostic tags when monitoring is configured", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@example.test/1";
    const error = Object.assign(new Error("private failure detail"), { digest: "digest-123" });

    render(
      <StorefrontRecoveryState
        surface="account"
        title="خطا"
        message="دوباره تلاش کنید"
        error={error}
      />,
    );

    expect(setTag).toHaveBeenCalledWith("recovery_surface", "account");
    expect(setTag).toHaveBeenCalledWith("next_error_digest", "digest-123");
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it("silently retries once on a transient RSC stream closure, then displays it if it recurs immediately", () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@example.test/1";
    const retry = jest.fn();
    const error = new Error("Connection closed.");
    const props = {
      surface: "catalog" as const,
      title: "خطا",
      message: "دوباره تلاش کنید",
      error,
      onRetry: retry,
    };

    const first = render(<StorefrontRecoveryState {...props} />);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    // The error boundary remounts a fresh instance of this component on
    // every occurrence, so only the module-scoped retry-window guard (not
    // component state) can tell an immediate recurrence apart from a fresh
    // one minutes later.
    render(<StorefrontRecoveryState {...props} />);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "خطا" })).toBeInTheDocument();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([
    ["Load failed", 1],
    ["Failed to fetch", 2],
    ["network error", 3],
  ] as const)(
    "silently retries once on %s, then displays it if it recurs immediately",
    (message, windowOffset) => {
      process.env.NEXT_PUBLIC_SENTRY_DSN = "https://public@example.test/1";
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + windowOffset * TRANSIENT_RETRY_OFFSET_MS);
      const retry = jest.fn();
      const error = new Error(message);
      const props = {
        surface: "product" as const,
        title: "خطا",
        message: "دوباره تلاش کنید",
        error,
        onRetry: retry,
      };

      const first = render(<StorefrontRecoveryState {...props} />);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(captureException).not.toHaveBeenCalled();
      expect(first.container).toBeEmptyDOMElement();
      first.unmount();

      render(<StorefrontRecoveryState {...props} />);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("heading", { name: "خطا" })).toBeInTheDocument();
      expect(captureException).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    },
  );
});
