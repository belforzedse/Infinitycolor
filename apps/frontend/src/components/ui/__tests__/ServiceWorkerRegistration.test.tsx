import { render, waitFor } from "@testing-library/react";
import ServiceWorkerRegistration from "../ServiceWorkerRegistration";
import { serviceWorkerHost } from "../service-worker-host";

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

  const stubHostname = (hostname: string) => {
    jest.spyOn(serviceWorkerHost, "getHostname").mockReturnValue(hostname);
  };

  // sw.js calls skipWaiting()+clients.claim() unconditionally, so a deploy can
  // swap the controller for an already-open tab mid-session. Without a forced
  // reload the tab keeps running whatever JS it already loaded -- the checkout
  // submit button visibly "worked" (disabled, then re-enabled) but ran stale
  // logic against a service worker that had moved on. This is what an
  // incognito tab (no service worker) never reproduced.
  const setupControllerChangeHarness = (initialController: unknown) => {
    const listeners: Listener[] = [];
    const update = jest.fn().mockResolvedValue(undefined);
    const registration = {
      waiting: null,
      installing: null,
      active: { state: "activated" } as ServiceWorker,
      update,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const register = jest.fn().mockResolvedValue(registration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistration: jest.fn().mockResolvedValue(registration),
        getRegistrations: jest.fn().mockResolvedValue([]),
        controller: initialController,
        ready: new Promise(() => undefined),
        addEventListener: (event: string, listener: Listener) => {
          if (event === "controllerchange") listeners.push(listener);
        },
        removeEventListener: jest.fn(),
      },
    });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    return { register, update, fireControllerChange: () => listeners.forEach((fn) => fn()) };
  };

  // jsdom's `window.location.reload` is neither configurable nor writable in
  // this jsdom version, so it cannot be stubbed directly. jsdom does still run
  // the real implementation, which logs exactly this message through the
  // virtual console instead of actually navigating -- observing it is proof
  // `reload()` was invoked without fighting jsdom's Location lockdown.
  const NAVIGATION_NOT_IMPLEMENTED = "Not implemented: navigation";

  it("reloads when the controller changes mid-session (a prior controller existed)", async () => {
    stubHostname("infinitycolor.co");
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
    stubHostname("infinitycolor.co");
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
    stubHostname("infinitycolor.co");
    const register = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistration: jest.fn().mockResolvedValue(undefined),
        getRegistrations: jest.fn().mockResolvedValue([]),
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

  it("does not call update() when active/waiting/installing are all null", async () => {
    stubHostname("infinitycolor.co");
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
        getRegistration: jest.fn().mockResolvedValue(registration),
        getRegistrations: jest.fn().mockResolvedValue([registration]),
        controller: null,
        ready: new Promise(() => undefined),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    render(<ServiceWorkerRegistration />);
    await waitFor(() => expect(register).toHaveBeenCalled());

    await jest.advanceTimersByTimeAsync(60_000);
    expect(update).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("catches update() rejection when a worker exists", async () => {
    stubHostname("infinitycolor.co");
    jest.useFakeTimers({ legacyFakeTimers: false });

    const update = jest.fn().mockRejectedValue(
      new DOMException("newestWorker is null", "InvalidStateError"),
    );
    const registration = {
      waiting: null,
      installing: null,
      active: { state: "activated" } as ServiceWorker,
      update,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const register = jest.fn().mockResolvedValue(registration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistration: jest.fn().mockResolvedValue(registration),
        getRegistrations: jest.fn().mockResolvedValue([registration]),
        controller: null,
        ready: new Promise(() => undefined),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const onUnhandledRejection = jest.fn();
    process.on("unhandledRejection", onUnhandledRejection);

    render(<ServiceWorkerRegistration />);
    await waitFor(() => expect(register).toHaveBeenCalled());

    await jest.advanceTimersByTimeAsync(60_000);
    expect(update).toHaveBeenCalledTimes(1);

    // Flush the caught promise
    await Promise.resolve();
    await Promise.resolve();

    process.off("unhandledRejection", onUnhandledRejection);
    expect(onUnhandledRejection).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("does not register on new.infinitycolor.co and unregisters leftover workers", async () => {
    stubHostname("new.infinitycolor.co");
    const unregister = jest.fn().mockResolvedValue(true);
    const register = jest.fn();
    const getRegistrations = jest.fn().mockResolvedValue([{ unregister }]);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistrations,
        getRegistration: jest.fn(),
        controller: null,
        ready: new Promise(() => undefined),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    jest.spyOn(console, "log").mockImplementation(() => undefined);

    render(<ServiceWorkerRegistration />);

    await waitFor(() => expect(getRegistrations).toHaveBeenCalled());
    await waitFor(() => expect(unregister).toHaveBeenCalled());
    expect(register).not.toHaveBeenCalled();
  });

  it("does not register on www.infinitycolor.co and unregisters leftover workers", async () => {
    stubHostname("www.infinitycolor.co");
    const unregister = jest.fn().mockResolvedValue(true);
    const register = jest.fn();
    const getRegistrations = jest.fn().mockResolvedValue([{ unregister }]);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistrations,
        getRegistration: jest.fn(),
        controller: null,
        ready: new Promise(() => undefined),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    jest.spyOn(console, "log").mockImplementation(() => undefined);

    render(<ServiceWorkerRegistration />);

    await waitFor(() => expect(getRegistrations).toHaveBeenCalled());
    await waitFor(() => expect(unregister).toHaveBeenCalled());
    expect(register).not.toHaveBeenCalled();
  });
});
