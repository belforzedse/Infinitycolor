import { render, waitFor } from "@testing-library/react";
import ServiceWorkerRegistration from "../ServiceWorkerRegistration";

describe("ServiceWorkerRegistration", () => {
  const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

  afterEach(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
    jest.restoreAllMocks();
  });

  it("treats a blocked registration as unsupported", async () => {
    const register = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);

    render(<ServiceWorkerRegistration />);

    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not raise an unhandled rejection when the periodic update() call fails", async () => {
    jest.useFakeTimers({ legacyFakeTimers: false });

    const update = jest.fn().mockRejectedValue(
      new DOMException("newestWorker is null", "InvalidStateError"),
    );
    const registration = {
      waiting: null,
      installing: null,
      active: null,
      update,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const register = jest.fn().mockResolvedValue(registration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        controller: null,
        ready: new Promise(() => undefined),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const onUnhandledRejection = jest.fn();
    process.on("unhandledRejection", onUnhandledRejection);

    render(<ServiceWorkerRegistration />);
    await waitFor(() => expect(register).toHaveBeenCalled());

    await jest.advanceTimersByTimeAsync(60000);
    expect(update).toHaveBeenCalledTimes(1);

    process.off("unhandledRejection", onUnhandledRejection);
    expect(onUnhandledRejection).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});
