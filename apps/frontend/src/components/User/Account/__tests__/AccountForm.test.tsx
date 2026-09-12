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

const setBirthDate = (year: string, month: string, day: string) => {
  fireEvent.change(screen.getByLabelText("سال تولد"), { target: { value: year } });
  fireEvent.change(screen.getByLabelText("ماه تولد"), { target: { value: month } });
  fireEvent.change(screen.getByLabelText("روز تولد"), { target: { value: day } });
};

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

  it("accepts Persian digits that a number input would have dropped", () => {
    render(<AccountForm />);

    fireEvent.change(screen.getByLabelText("سال تولد"), { target: { value: "۱۳۸۸" } });
    expect(screen.getByLabelText("سال تولد")).toHaveValue("1388");
  });

  it("refuses a day the Jalali month does not have instead of silently keeping the old date", async () => {
    render(<AccountForm />);

    // Aban has 30 days. This used to fall back to the stored value and still claim success.
    setBirthDate("1388", "8", "31");
    save();

    expect(await screen.findByRole("alert")).toHaveTextContent("این ماه ۳۰ روز دارد.");
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("refuses a partially filled birth date", async () => {
    render(<AccountForm />);

    setBirthDate("1388", "", "");
    save();

    expect(await screen.findByRole("alert")).toHaveTextContent("تاریخ تولد را کامل وارد کنید");
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it("saves a valid birth date and never submits fields the form does not render", async () => {
    render(<AccountForm />);

    setBirthDate("1388", "8", "30");
    save();

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledTimes(1));
    const payload = mockUpdateProfile.mock.calls[0][0];
    expect(payload.BirthDate).toBe("2009-11-21");
    // The allowlist rejects the whole request on any unknown key, and the form renders
    // neither of these.
    expect(payload).not.toHaveProperty("NationalCode");
    expect(payload).not.toHaveProperty("Phone");
  });

  it("clears the birth date when all three parts are emptied", async () => {
    render(<AccountForm />);

    setBirthDate("", "", "");
    save();

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledTimes(1));
    expect(mockUpdateProfile.mock.calls[0][0].BirthDate).toBeNull();
  });

  it("round-trips the gender the user picks", async () => {
    render(<AccountForm />);

    fireEvent.click(screen.getByLabelText("زن"));
    save();

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledTimes(1));
    expect(mockUpdateProfile.mock.calls[0][0].Sex).toBe("female");
  });

  it("omits the gender entirely when the user never answered", async () => {
    render(<AccountForm />);

    save();

    await waitFor(() => expect(mockUpdateProfile).toHaveBeenCalledTimes(1));
    expect(mockUpdateProfile.mock.calls[0][0]).not.toHaveProperty("Sex");
  });

  it("preselects the stored gender", () => {
    mockUserData = { ...mockUserData, Sex: "male" };
    render(<AccountForm />);

    expect(screen.getByLabelText("مرد")).toBeChecked();
  });
});
