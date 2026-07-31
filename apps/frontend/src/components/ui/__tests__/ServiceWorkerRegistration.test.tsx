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
});
