import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AnipoBarcodeDialog, {
  DEFAULT_ANIPO_BOX_SIZE_ID,
  DEFAULT_ANIPO_WEIGHT_G,
} from "../AnipoBarcodeDialog";

jest.mock("@/components/Kits/Modal", () => ({
  __esModule: true,
  default: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title?: string;
  }) => (
    <div>
      {title ? <h2>{title}</h2> : null}
      {children}
    </div>
  ),
}));

describe("AnipoBarcodeDialog", () => {
  it("pre-fills the automatic 500g / box size 3 parcel and submits it unchanged", async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <AnipoBarcodeDialog isOpen onClose={jest.fn()} onGenerate={onGenerate} />,
    );

    expect(screen.getByRole("spinbutton")).toHaveValue(DEFAULT_ANIPO_WEIGHT_G);
    expect(screen.getByRole("combobox")).toHaveValue(
      String(DEFAULT_ANIPO_BOX_SIZE_ID),
    );

    await user.click(screen.getByRole("button", { name: "ثبت در آنیپو" }));

    expect(onGenerate).toHaveBeenCalledWith(
      DEFAULT_ANIPO_WEIGHT_G,
      DEFAULT_ANIPO_BOX_SIZE_ID,
    );
  });

  it("keeps a stored parcel when the order already has Anipo dimensions", async () => {
    const onGenerate = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <AnipoBarcodeDialog
        isOpen
        onClose={jest.fn()}
        onGenerate={onGenerate}
        initialWeight={850}
        initialBoxSizeId={5}
      />,
    );

    expect(screen.getByRole("spinbutton")).toHaveValue(850);
    expect(screen.getByRole("combobox")).toHaveValue("5");

    await user.click(screen.getByRole("button", { name: "ثبت در آنیپو" }));

    expect(onGenerate).toHaveBeenCalledWith(850, 5);
  });
});
