import { fireEvent, render, screen } from "@testing-library/react";
import SizeFilter from "../Size";
import type { SizeBucket } from "@/utils/plpSizeFilter";

const buckets: SizeBucket[] = [
  { key: "m", kind: "clothing", label: "M", titles: ["M", "E2E Medium"] },
  { key: "3xl", kind: "clothing", label: "3XL", titles: ["3xl", "XXXL"] },
  { key: "36", kind: "numeric", label: "۳۶", titles: ["36"] },
];

describe("SizeFilter", () => {
  it("maps 3xl search onto the 3XL bucket and toggles it", () => {
    const onToggle = jest.fn();
    render(<SizeFilter buckets={buckets} selectedKeys={[]} onToggle={onToggle} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "جستجوی سایز" }), {
      target: { value: "xxxl" },
    });

    expect(screen.getByTestId("plp-size-option-3xl")).toBeInTheDocument();
    expect(screen.queryByTestId("plp-size-option-m")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("plp-size-option-3xl"));
    expect(onToggle).toHaveBeenCalledWith("3xl");
  });
});
