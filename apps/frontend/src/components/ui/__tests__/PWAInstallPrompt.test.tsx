import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PWAInstallPromptCard } from "../PWAInstallPrompt";

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
