import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getSafeLocalStorage, PWAInstallPromptCard } from "../PWAInstallPrompt";

describe("PWAInstallPromptCard", () => {
  it("renders a compact card that stays on short screens", () => {
    const { container } = render(
      <PWAInstallPromptCard isIOS={false} onInstall={jest.fn()} onDismiss={jest.fn()} />,
    );

    const card = screen.getByTestId("pwa-install-prompt").querySelector(".relative");
    expect(card).toHaveClass("max-w-[17.5rem]");
    expect(container.innerHTML).not.toContain("max-w-md");
    expect(container.querySelector(".h-20")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "نصب اپلیکیشن" })).toHaveClass("text-sm");
  });

  it("dismisses from the compact actions without covering the viewport as a sheet", async () => {
    const user = userEvent.setup();
    const onDismiss = jest.fn();
    render(<PWAInstallPromptCard isIOS onInstall={jest.fn()} onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "متوجه شدم" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("PWA install storage guards", () => {
  it("treats a null embedded-browser localStorage as unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: null,
    });

    expect(getSafeLocalStorage()).toBeNull();

    if (descriptor) {
      Object.defineProperty(window, "localStorage", descriptor);
    }
  });

  it("treats storage access exceptions as unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    });

    expect(getSafeLocalStorage()).toBeNull();

    if (descriptor) {
      Object.defineProperty(window, "localStorage", descriptor);
    }
  });
});
