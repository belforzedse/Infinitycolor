import { render, screen, fireEvent } from "@testing-library/react";

// A faithful-enough stand-in for zaman's real DatePicker: `defaultValue` only
// initializes the DOM input's value and is ignored on re-render (genuine
// uncontrolled-input behavior) unless React remounts the element via `key`.
jest.mock("zaman", () => ({
  DatePicker: ({ defaultValue, onChange }: any) => (
    <input
      role="textbox"
      defaultValue={defaultValue?.toISOString?.().slice(0, 10) ?? ""}
      onChange={(e) => onChange(new Date(e.target.value))}
    />
  ),
}));

import ReportDateRangeField, {
  normalizeDateInput,
  DEFAULT_REPORT_DATE_PRESETS,
} from "../ReportDateRangeField";

describe("normalizeDateInput", () => {
  const previous = new Date("2026-01-01T00:00:00Z");

  it("passes a Date straight through", () => {
    const d = new Date("2026-02-02T00:00:00Z");
    expect(normalizeDateInput(d, previous)).toBe(d);
  });

  it("unwraps a { value: Date } shape (zaman's onChange payload)", () => {
    const d = new Date("2026-03-03T00:00:00Z");
    expect(normalizeDateInput({ value: d }, previous)).toBe(d);
  });

  it("parses a valid date string", () => {
    const result = normalizeDateInput("2026-04-04", previous);
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(3);
  });

  it("falls back to the previous value for garbage input", () => {
    expect(normalizeDateInput("not-a-date", previous)).toBe(previous);
    expect(normalizeDateInput(null, previous)).toBe(previous);
    expect(normalizeDateInput(undefined, previous)).toBe(previous);
  });
});

describe("ReportDateRangeField", () => {
  const start = new Date(2026, 0, 1);
  const end = new Date(2026, 0, 31);

  it("renders start/end labels and every default preset", () => {
    render(<ReportDateRangeField start={start} end={end} onChange={jest.fn()} />);
    expect(screen.getByText("تاریخ شروع")).toBeInTheDocument();
    expect(screen.getByText("تاریخ پایان")).toBeInTheDocument();
    for (const preset of DEFAULT_REPORT_DATE_PRESETS) {
      expect(screen.getByText(preset.label)).toBeInTheDocument();
    }
  });

  it("changing the start picker calls onChange with the new start and the SAME end", () => {
    const onChange = jest.fn();
    render(<ReportDateRangeField start={start} end={end} onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "2026-01-05" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0];
    expect(call.end).toBe(end);
    expect(call.start.getUTCDate()).toBe(5);
  });

  it("changing the end picker calls onChange with the SAME start and the new end", () => {
    const onChange = jest.fn();
    render(<ReportDateRangeField start={start} end={end} onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[1], { target: { value: "2026-01-20" } });

    const call = onChange.mock.calls[0][0];
    expect(call.start).toBe(start);
    expect(call.end.getUTCDate()).toBe(20);
  });

  it("clicking a preset calls onChange with that preset's computed range", () => {
    const onChange = jest.fn();
    render(<ReportDateRangeField start={start} end={end} onChange={onChange} />);
    fireEvent.click(screen.getByText("۷ روز گذشته"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0];
    expect(call.start).toBeInstanceOf(Date);
    expect(call.end).toBeInstanceOf(Date);
  });

  it("hides presets when presets={false}", () => {
    render(<ReportDateRangeField start={start} end={end} onChange={jest.fn()} presets={false} />);
    expect(screen.queryByText("۷ روز گذشته")).not.toBeInTheDocument();
  });

  it("updates the displayed dates when start/end change externally (e.g. after a preset click) — not stale", () => {
    const { rerender } = render(<ReportDateRangeField start={start} end={end} onChange={jest.fn()} />);
    const newStart = new Date(2026, 5, 1);
    const newEnd = new Date(2026, 5, 30);

    rerender(<ReportDateRangeField start={newStart} end={newEnd} onChange={jest.fn()} />);

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    // A DatePicker whose `key` doesn't track the incoming value would keep the OLD
    // uncontrolled input's value here — this is exactly the "date pickers go stale
    // after a preset click" regression.
    expect(inputs[0].value).toBe(newStart.toISOString().slice(0, 10));
    expect(inputs[1].value).toBe(newEnd.toISOString().slice(0, 10));
  });
});
