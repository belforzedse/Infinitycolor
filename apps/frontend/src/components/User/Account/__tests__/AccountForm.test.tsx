import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountForm from "../AccountForm";

const mockUpdateProfile = jest.fn().mockResolvedValue({});
const mockRefetch = jest.fn().mockResolvedValue(undefined);
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

let mockUserData: Record<string, unknown> | null = null;

jest.mock("@/hooks/useUser", () => ({
  __esModule: true,
  default: () => ({
    userData: mockUserData,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
  }),
}));

jest.mock("@/services/user/updateProfile", () => ({
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
}));

jest.mock("react-hot-toast", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const save = () => fireEvent.click(screen.getByRole("button", { name: /ذخیره تغییرات/ }));

describe("AccountForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserData = {
      FirstName: "نیما",
      LastName: "احمدی",
      Phone: "09121234567",
      // Stored as Gregorian; displayed as unpadded Jalali parts.
      BirthDate: "1991-03-28",
      Sex: null,
      NationalCode: null,
    };
  });

  it("shows the stored birth date without storage padding", () => {
    render(<AccountForm />);

    expect(screen.getByLabelText("سال تولد")).toHaveValue("1370");
    expect(screen.getByLabelText("ماه تولد")).toHaveValue("1");
    expect(screen.getByLabelText("روز تولد")).toHaveValue("8");
  });

  it("shows birthday as disabled instead of implying it can be edited", () => {
    render(<AccountForm />);

    const birthYear = screen.getByLabelText("سال تولد");
    expect(birthYear).toBeDisabled();
    expect(birthYear).toHaveClass("bg-neutral-100", "text-slate-400", "cursor-not-allowed");
    expect(screen.getByLabelText("ماه تولد")).toBeDisabled();
    expect(screen.getByLabelText("روز تولد")).toBeDisabled();
  });

  it("shows gender as disabled instead of implying it can be edited", () => {
    mockUserData = { ...mockUserData, Sex: "male" };
    render(<AccountForm />);

    const maleOption = screen.getByLabelText("مرد");
    expect(screen.getByLabelText("زن")).toBeDisabled();
    expect(maleOption).toBeDisabled();
    expect(maleOption).toBeChecked();
    expect(maleOption.closest("label")).toHaveClass(
      "bg-neutral-100",
      "text-slate-400",
      "cursor-not-allowed",
    );
    expect(screen.queryByRole("button", { name: "پاک کردن" })).not.toBeInTheDocument();
  });

  it("saves only the fields that can be edited on this form", async () => {
    mockUserData = { ...mockUserData, Sex: "female" };
    render(<AccountForm />);

    fireEvent.change(screen.getByLabelText("نام"), { target: { value: "سارا" } });
    save();

    await waitFor(() =>
      expect(mockUpdateProfile).toHaveBeenCalledWith({
        FirstName: "سارا",
        LastName: "احمدی",
      }),
    );
    expect(mockUpdateProfile.mock.calls[0][0]).not.toHaveProperty("BirthDate");
    expect(mockUpdateProfile.mock.calls[0][0]).not.toHaveProperty("Sex");
  });
});
