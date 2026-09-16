import { render, waitFor } from "@testing-library/react";
import ServiceWorkerRegistration from "../ServiceWorkerRegistration";

type Listener = () => void;

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

  // sw.js calls skipWaiting()+clients.claim() unconditionally, so a deploy can
  // swap the controller for an already-open tab mid-session. Without a forced
  // reload the tab keeps running whatever JS it already loaded -- the checkout
  // submit button visibly "worked" (disabled, then re-enabled) but ran stale
  // logic against a service worker that had moved on. This is what an
  // incognito tab (no service worker) never reproduced.
  const setupControllerChangeHarness = (initialController: unknown) => {
    const listeners: Listener[] = [];
    const register = jest.fn().mockResolvedValue({
      waiting: null,
      installing: null,
      active: null,
      update: jest.fn().mockResolvedValue(undefined),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        controller: initialController,
        ready: new Promise(() => undefined),
        addEventListener: (event: string, listener: Listener) => {
          if (event === "controllerchange") listeners.push(listener);
        },
        removeEventListener: jest.fn(),
      },
    });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    return { register, fireControllerChange: () => listeners.forEach((fn) => fn()) };
  };

  // jsdom's `window.location.reload` is neither configurable nor writable in
  // this jsdom version, so it cannot be stubbed directly. jsdom does still run
  // the real implementation, which logs exactly this message through the
  // virtual console instead of actually navigating -- observing it is proof
  // `reload()` was invoked without fighting jsdom's Location lockdown.
  const NAVIGATION_NOT_IMPLEMENTED = "Not implemented: navigation";

  it("reloads when the controller changes mid-session (a prior controller existed)", async () => {
    const { register, fireControllerChange } = setupControllerChangeHarness({});
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    render(<ServiceWorkerRegistration />);
    await waitFor(() => expect(register).toHaveBeenCalled());
    fireControllerChange();

    expect(
      consoleError.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes(NAVIGATION_NOT_IMPLEMENTED)),
      ),
    ).toBe(true);
  });

  it("does not reload on the first-ever controllerchange (no prior controller)", async () => {
    const { register, fireControllerChange } = setupControllerChangeHarness(null);
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    render(<ServiceWorkerRegistration />);
    await waitFor(() => expect(register).toHaveBeenCalled());
    fireControllerChange();

    expect(
      consoleError.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes(NAVIGATION_NOT_IMPLEMENTED)),
      ),
    ).toBe(false);
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
