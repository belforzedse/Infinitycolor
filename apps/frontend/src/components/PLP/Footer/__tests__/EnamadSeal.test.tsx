import { render, screen } from "@testing-library/react";

import { ENAMAD_SEAL_IMAGE_URL, ENAMAD_SEAL_VERIFY_URL } from "@/constants/footer";

import EnamadSeal from "../EnamadSeal";

describe("EnamadSeal", () => {
  it("keeps the attributes eNamad validates the seal by", () => {
    render(<EnamadSeal />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", ENAMAD_SEAL_VERIFY_URL);
    expect(link).toHaveAttribute("referrerpolicy", "origin");
    // eNamad checks the referring domain, so the referrer must survive the click.
    expect(link.getAttribute("rel")).not.toContain("noreferrer");

    const seal = screen.getByRole("img");
    // Hot-linked from eNamad: a proxied or re-hosted copy fails verification.
    expect(seal).toHaveAttribute("src", ENAMAD_SEAL_IMAGE_URL);
    expect(seal).toHaveAttribute("referrerpolicy", "origin");
    expect(seal).toHaveAttribute("code", "ubfacOD0MKGTamyXgVNX");
  });
});
