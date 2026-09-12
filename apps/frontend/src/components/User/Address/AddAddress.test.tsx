import { act, render, screen } from "@testing-library/react";
import AddAddress from "./AddAddress";

jest.mock("jotai", () => ({
  atom: jest.fn(() => ({})),
  useAtom: () => [[], jest.fn()],
}));

jest.mock("@/components/Kits/Modal", () => ({
  __esModule: true,
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null,
}));

jest.mock("@/services/user", () => ({
  __esModule: true,
  default: {
    me: jest.fn().mockResolvedValue(null),
    addresses: {
      create: jest.fn(),
      update: jest.fn(),
      getAll: jest.fn().mockResolvedValue([]),
    },
  },
}));

jest.mock("@/services/location", () => ({
  getProvinces: jest.fn().mockResolvedValue([]),
  getCities: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/api-cache", () => ({
  apiCache: { invalidate: jest.fn() },
}));

describe("AddAddress", () => {
  it("uses searchable province and city controls", async () => {
    await act(async () => {
      render(<AddAddress isOpen showButton={false} />);
    });

    expect(screen.getByRole("combobox", { name: "استان" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "شهر" })).toBeVisible();
  });
});
