import { render, screen } from "@testing-library/react";
import StoreAddressLine from "../StoreAddressLine";

describe("StoreAddressLine", () => {
  it("keeps the Gonbad title in its own text run so a colon cannot join onto کاووس", () => {
    render(
      <StoreAddressLine
        store={{
          name: "گنبد کاووس",
          address: "گنبد کاووس، ابتدای بلوار دانشجو",
          phones: [],
          showInFooter: true,
          showInAbout: true,
          socialLinks: [],
        }}
      />,
    );

    expect(screen.getByText("گنبد کاووس", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("گنبد کاووس، ابتدای بلوار دانشجو")).toBeInTheDocument();
  });
});
