import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Modal from "../Modal";

describe("Modal", () => {
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders dialog content in a portal when open", async () => {
    render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <div>Modal Content</div>
      </Modal>,
    );

    expect(await screen.findByRole("dialog")).toHaveClass("rounded-panel");
    expect(screen.getByText("Modal Content")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(
      <Modal isOpen={false} onClose={mockOnClose}>
        <div>Modal Content</div>
      </Modal>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Modal Content")).not.toBeInTheDocument();
  });

  it("labels the dialog with the title when provided", async () => {
    render(
      <Modal isOpen={true} title="Test Title" onClose={mockOnClose}>
        <div>Content</div>
      </Modal>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Test Title" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("heading", { name: "Test Title" })).toHaveClass("text-lg");
  });

  it("uses the provided aria-labelledby when no title is rendered", async () => {
    render(
      <>
        <h2 id="external-title">External Title</h2>
        <Modal isOpen={true} onClose={mockOnClose} aria-labelledby="external-title">
          <div>Content</div>
        </Modal>
      </>,
    );

    expect(await screen.findByRole("dialog", { name: "External Title" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "External Title" })).toBeInTheDocument();
  });

  it("calls onClose from the close button, Escape key, and backdrop click", async () => {
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <button type="button">Focusable child</button>
      </Modal>,
    );

    const closeButton = await screen.findByRole("button", { name: "بستن" });
    expect(closeButton).toHaveClass("rounded-pill", "focus-visible:ring-infinity-primary");
    fireEvent.click(closeButton);
    fireEvent.keyDown(window, { key: "Escape" });
    now += 600;
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);

    expect(mockOnClose).toHaveBeenCalledTimes(3);
    jest.restoreAllMocks();
  });

  it("ignores leftover backdrop taps after open", async () => {
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);

    render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <div>Content</div>
      </Modal>,
    );

    const backdrop = (await screen.findByRole("dialog")).parentElement as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(mockOnClose).not.toHaveBeenCalled();

    now += 600;
    fireEvent.click(backdrop);
    expect(mockOnClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(mockOnClose).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it("does not close when clicking inside the dialog panel", async () => {
    render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <div>Content</div>
      </Modal>,
    );

    fireEvent.click(await screen.findByRole("dialog"));

    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("renders a custom close icon when provided", async () => {
    render(
      <Modal
        isOpen={true}
        onClose={mockOnClose}
        closeIcon={<span data-testid="custom-icon">X</span>}
      >
        <div>Content</div>
      </Modal>,
    );

    expect(await screen.findByTestId("custom-icon")).toBeInTheDocument();
  });

  it("applies custom classes to the dialog, title, and content wrapper", async () => {
    render(
      <Modal
        isOpen={true}
        title="Title"
        onClose={mockOnClose}
        className="custom-panel"
        titleClassName="custom-title"
        contentClassName="custom-content"
      >
        <div>Content</div>
      </Modal>,
    );

    expect(await screen.findByRole("dialog")).toHaveClass("custom-panel");
    expect(screen.getByRole("heading", { name: "Title" })).toHaveClass("custom-title");
    expect(screen.getByText("Content").parentElement).toHaveClass("custom-content");
  });

  it("locks body scroll while open and restores it after unmount", async () => {
    const { unmount } = render(
      <Modal isOpen={true} onClose={mockOnClose}>
        <div>Content</div>
      </Modal>,
    );

    await screen.findByRole("dialog");
    expect(document.body.style.overflow).toBe("hidden");

    unmount();

    await waitFor(() => {
      expect(document.body.style.overflow).toBe("");
    });
  });
});
