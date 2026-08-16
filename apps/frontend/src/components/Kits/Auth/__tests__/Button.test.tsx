import { render, screen, fireEvent } from "@testing-library/react";
import AuthButton from "../Button";

describe("AuthButton", () => {
  it("should render button with text", () => {
    render(<AuthButton>Click me</AuthButton>);

    expect(screen.getByRole("button")).toHaveTextContent("Click me");
  });

  it("should be full width by default", () => {
    render(<AuthButton>Button</AuthButton>);

    const button = screen.getByRole("button");
    expect(button).toHaveClass("w-full");
  });

  it("should not be full width when fullWidth is false", () => {
    render(<AuthButton fullWidth={false}>Button</AuthButton>);

    const button = screen.getByRole("button");
    expect(button).not.toHaveClass("w-full");
  });

  it("should render icon on right by default", () => {
    render(<AuthButton icon={<span data-testid="icon">→</span>}>Button</AuthButton>);

    const button = screen.getByRole("button");
    const icon = screen.getByTestId("icon");

    expect(button).toContainElement(icon);
  });

  it("should render icon on left when iconPosition is left", () => {
    render(
      <AuthButton icon={<span data-testid="icon">←</span>} iconPosition="left">
        Button
      </AuthButton>,
    );

    const icon = screen.getByTestId("icon");
    expect(icon).toBeInTheDocument();
  });

  it("should handle click events", () => {
    const handleClick = jest.fn();

    render(<AuthButton onClick={handleClick}>Click</AuthButton>);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("should be disabled when disabled prop is true", () => {
    render(<AuthButton disabled>Disabled</AuthButton>);

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("should apply custom className", () => {
    render(<AuthButton className="custom-class">Button</AuthButton>);

    const button = screen.getByRole("button");
    expect(button).toHaveClass("custom-class");
  });

  it("should have default button classes", () => {
    render(<AuthButton>Button</AuthButton>);

    const button = screen.getByRole("button");
    expect(button).toHaveClass(
      "btn",
      "min-h-[49px]",
      "rounded-prominent",
      "bg-infinity-primary",
      "px-3",
      "hover:bg-infinity-primary-dark",
      "active:bg-infinity-primary-darker",
      "disabled:bg-infinity-primary/50",
      "focus-visible:ring-infinity-primary",
      "motion-reduce:transition-none",
    );
  });

  it("should render the restrained secondary action variant", () => {
    render(<AuthButton variant="secondary">Secondary</AuthButton>);

    expect(screen.getByRole("button")).toHaveClass(
      "min-h-12",
      "rounded-control",
      "border-infinity-primary",
      "bg-transparent",
      "hover:bg-infinity-primary-lighter/20",
      "active:bg-infinity-primary-lighter/30",
    );
  });

  it("should expose loading state to assistive technology", () => {
    render(<AuthButton aria-busy>Loading</AuthButton>);

    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });

  it("should render children that are not strings", () => {
    render(
      <AuthButton>
        <div data-testid="custom-child">Custom Content</div>
      </AuthButton>,
    );

    expect(screen.getByTestId("custom-child")).toBeInTheDocument();
  });

  it("should wrap string children in span when icon is present", () => {
    render(<AuthButton icon={<span>icon</span>}>Text</AuthButton>);

    const button = screen.getByRole("button");
    expect(button.querySelector("span")).toBeInTheDocument();
    expect(button.firstElementChild).toHaveClass("gap-1");
  });

  it("should pass through HTML button attributes", () => {
    render(
      <AuthButton type="submit" name="submit-btn">
        Submit
      </AuthButton>,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("name", "submit-btn");
  });
});
