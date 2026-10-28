import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProductTitleInput from "../ProductTitleInput";
import { useProductTitleKeywords } from "@/hooks/product/useProductTitleKeywords";

jest.mock("@/hooks/product/useProductTitleKeywords", () => ({
  useProductTitleKeywords: jest.fn(),
}));

const mockedKeywords = jest.mocked(useProductTitleKeywords);

function TestForm() {
  const [title, setTitle] = useState("");

  return <ProductTitleInput value={title} onChange={setTitle} />;
}

describe("ProductTitleInput", () => {
  beforeEach(() => {
    mockedKeywords.mockReset();
    mockedKeywords.mockReturnValue(["شومیز", "نخی", "نخ‌پنبه"]);
  });

  it("shows matching suggestions and allows choosing with the mouse", async () => {
    const user = userEvent.setup();

    render(<TestForm />);

    const input = screen.getByRole("combobox", {
      name: "نام محصول",
    });

    await user.type(input, "شو");

    await user.click(screen.getByRole("option", { name: "شومیز" }));

    expect(input).toHaveValue("شومیز");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("chooses with the keyboard and preserves the preceding words", async () => {
    const user = userEvent.setup();

    render(<TestForm />);

    const input = screen.getByRole("combobox", {
      name: "نام محصول",
    });

    await user.type(input, "شومیز نخ");

    expect(screen.getByRole("option", { name: "نخی" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("شومیز نخی");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes suggestions with Escape without changing the title", async () => {
    const user = userEvent.setup();

    render(<TestForm />);

    const input = screen.getByRole("combobox", {
      name: "نام محصول",
    });

    await user.type(input, "شو");

    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(input).toHaveValue("شو");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
