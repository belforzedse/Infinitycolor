import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Select, { type Option } from "../Select";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
});
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

const options: Option[] = [
  { id: 1, name: "تهران" },
  { id: 2, name: "كيش" },
  { id: 3, name: "گُرگان" },
];

function SearchableSelectHarness({ onChange = jest.fn() }: { onChange?: jest.Mock }) {
  const [value, setValue] = useState<Option | null>(null);

  return (
    <Select
      label="شهر"
      value={value}
      onChange={(nextValue) => {
        setValue(nextValue);
        onChange(nextValue);
      }}
      options={options}
      searchable
      searchPlaceholder="جست‌وجوی شهر"
    />
  );
}

describe("Select", () => {
  it("keeps the existing listbox behavior unless search is enabled", () => {
    render(<Select label="آدرس" value={null} onChange={jest.fn()} options={options} />);

    expect(screen.getByRole("button", { name: "انتخاب کنید" })).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("filters Persian text across Arabic glyphs and diacritics", async () => {
    const user = userEvent.setup();
    render(<SearchableSelectHarness />);
    const input = screen.getByRole("combobox", { name: "شهر" });

    await user.click(input);
    await user.type(input, "کیش");

    expect(screen.getByRole("option", { name: "كيش" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "تهران" })).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "گرگان");
    expect(screen.getByRole("option", { name: "گُرگان" })).toBeVisible();
  });

  it("selects with the keyboard and restores the selected value after an empty search", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<SearchableSelectHarness onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "شهر" });

    await user.click(input);
    await user.type(input, "تهر");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith(options[0]);
    expect(input).toHaveValue("تهران");

    await user.clear(input);
    await user.type(input, "وجود ندارد");
    expect(screen.getByText("موردی یافت نشد")).toBeVisible();

    await user.tab();
    expect(input).toHaveValue("تهران");
  });
});
