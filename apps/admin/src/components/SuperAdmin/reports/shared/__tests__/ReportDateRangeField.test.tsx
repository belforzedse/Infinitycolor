import { render, screen, fireEvent } from "@testing-library/react";
import type { InputHTMLAttributes } from "react";

type MockDatePickerProps = {
  defaultValue?: Date;
  onChange?: (value: unknown) => void;
  inputAttributes?: InputHTMLAttributes<HTMLInputElement>;
  inputClass?: string;
};

// A faithful-enough stand-in for zaman's real DatePicker: `defaultValue` only
// initializes the DOM input's value and is ignored on re-render (genuine
// uncontrolled-input behavior) unless React remounts the element via `key`.
jest.mock("zaman", () => ({
  DatePicker: ({ defaultValue, onChange, inputAttributes, inputClass }: MockDatePickerProps) => (
    <input
      role="textbox"
      className={inputClass}
      aria-label={
        typeof inputAttributes?.["aria-label"] === "string"
          ? inputAttributes["aria-label"]
          : undefined
      }
      id={typeof inputAttributes?.id === "string" ? inputAttributes.id : undefined}
      defaultValue={defaultValue?.toISOString?.().slice(0, 10) ?? ""}
      onChange={(e) => onChange?.(new Date(e.target.value))}
    />
  ),
}));

import ReportDateRangeField, {
  normalizeDateInput,
  DEFAULT_REPORT_DATE_PRESETS,
} from "../ReportDateRangeField";
import { thisJalaliMonthRange, toDateOnly } from "../reportDates";

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
    expect(normalizeDateInput({ nope: true }, previous)).toBe(previous);
  });
});

describe("ReportDateRangeField", () => {
  const start = new Date(2026, 0, 1);
  const end = new Date(2026, 0, 31);

  it("renders start/end labels and every default preset", () => {
    render(<ReportDateRangeField start={start} end={end} onChange={jest.fn()} />);
    expect(screen.getByLabelText("تاریخ شروع")).toBeInTheDocument();
    expect(screen.getByLabelText("تاریخ پایان")).toBeInTheDocument();
    for (const preset of DEFAULT_REPORT_DATE_PRESETS) {
      expect(screen.getByText(preset.label)).toBeInTheDocument();
    }
  });

  it("gives both pickers a full-width input class so the pair stays equal", () => {
    render(<ReportDateRangeField start={start} end={end} onChange={jest.fn()} />);
    const startInput = screen.getByLabelText("تاریخ شروع");
    const endInput = screen.getByLabelText("تاریخ پایان");
    expect(startInput).toHaveClass("w-full");
    expect(endInput).toHaveClass("w-full");
  });

  it("changing the start picker calls onChange with the new start and the SAME end", () => {
    const onChange = jest.fn();
    render(<ReportDateRangeField start={start} end={end} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("تاریخ شروع"), {
      target: { value: "2026-01-05" },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0] as { start: Date; end: Date };
    expect(call.end).toBe(end);
    expect(call.start.getUTCDate()).toBe(5);
  });

  it("changing the end picker calls onChange with the SAME start and the new end", () => {
    const onChange = jest.fn();
    render(<ReportDateRangeField start={start} end={end} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("تاریخ پایان"), {
      target: { value: "2026-01-20" },
    });

    const call = onChange.mock.calls[0][0] as { start: Date; end: Date };
    expect(call.start).toBe(start);
    expect(call.end.getUTCDate()).toBe(20);
  });

  it("clicking a preset calls onChange with that preset's computed range", () => {
    const onChange = jest.fn();
    render(<ReportDateRangeField start={start} end={end} onChange={onChange} />);
    fireEvent.click(screen.getByText("۷ روز گذشته"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0] as { start: Date; end: Date };
    expect(call.start).toBeInstanceOf(Date);
    expect(call.end).toBeInstanceOf(Date);
  });

  it("این ماه starts on the Jalali first of the current Tehran month", () => {
    const onChange = jest.fn();
    render(<ReportDateRangeField start={start} end={end} onChange={onChange} />);
    fireEvent.click(screen.getByText("این ماه"));

    const call = onChange.mock.calls[0][0] as { start: Date; end: Date };
    expect(toDateOnly(call.start)).toBe(toDateOnly(thisJalaliMonthRange().start));
  });

  it("hides presets when presets={false}", () => {
    render(<ReportDateRangeField start={start} end={end} onChange={jest.fn()} presets={false} />);
    expect(screen.queryByText("۷ روز گذشته")).not.toBeInTheDocument();
  });

  it("updates the displayed dates when start/end change externally (e.g. after a preset click) — not stale", () => {
    const { rerender } = render(
      <ReportDateRangeField start={start} end={end} onChange={jest.fn()} />,
    );
    const newStart = new Date(2026, 5, 1);
    const newEnd = new Date(2026, 5, 30);

    rerender(<ReportDateRangeField start={newStart} end={newEnd} onChange={jest.fn()} />);

    expect((screen.getByLabelText("تاریخ شروع") as HTMLInputElement).value).toBe(
      newStart.toISOString().slice(0, 10),
    );
    expect((screen.getByLabelText("تاریخ پایان") as HTMLInputElement).value).toBe(
      newEnd.toISOString().slice(0, 10),
    );
  });
});
