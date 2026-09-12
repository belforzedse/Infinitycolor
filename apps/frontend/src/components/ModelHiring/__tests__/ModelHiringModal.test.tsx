import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import ModelHiringModal from "../ModelHiringModal";
import ModelHiringModalContent from "../ModelHiringModalContent";
import { modelHiringModalOpenAtom } from "@/atoms/modelHiring";
import { submitModelApplication } from "@/services/model-applications";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

jest.mock("@/services/model-applications", () => ({
  ...jest.requireActual("@/services/model-applications"),
  submitModelApplication: jest.fn(),
}));

const submit = submitModelApplication as jest.MockedFunction<typeof submitModelApplication>;

function renderModal() {
  const store = createStore();
  store.set(modelHiringModalOpenAtom, true);
  return render(
    <Provider store={store}>
      <ModelHiringModalContent />
    </Provider>,
  );
}

function renderGate(open: boolean) {
  const store = createStore();
  store.set(modelHiringModalOpenAtom, open);
  return render(
    <Provider store={store}>
      <ModelHiringModal />
    </Provider>,
  );
}

describe("ModelHiringModal", () => {
  beforeEach(() => {
    submit.mockReset();
  });

  it("requires name, phone, and age before submit", async () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "ارسال درخواست" }));
    expect(await screen.findByText("نام و نام خانوادگی را وارد کنید.")).toBeInTheDocument();
    expect(screen.getByText("شماره تماس را وارد کنید.")).toBeInTheDocument();
    expect(screen.getByText("سن را وارد کنید.")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a photo larger than 5 MB", async () => {
    renderModal();
    const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.jpg", {
      type: "image/jpeg",
    });
    const input = screen.getByLabelText("عکس اول (حداکثر ۵ مگابایت)");
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(await screen.findByText("حجم هر عکس باید حداکثر ۵ مگابایت باشد.")).toBeInTheDocument();
  });

  it("submits the hiring form", async () => {
    submit.mockResolvedValue({
      applicationId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-09-09T12:00:00.000Z",
      replayed: false,
    });
    renderModal();
    fireEvent.change(screen.getByPlaceholderText("مثلاً علی رضایی"), {
      target: { value: "علی رضایی" },
    });
    fireEvent.change(screen.getByPlaceholderText("۰۹۱۲۰۰۰۰۰۰۰"), {
      target: { value: "09121234567" },
    });
    fireEvent.change(screen.getByPlaceholderText("مثلاً ۲۵"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "ارسال درخواست" }));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(await screen.findByText("درخواست شما ثبت شد.")).toBeInTheDocument();
  });

  it("renders nothing until the modal is opened", () => {
    const { container } = renderGate(false);
    expect(container).toBeEmptyDOMElement();
  });

  it("loads the form once the modal is opened", async () => {
    renderGate(true);
    expect(await screen.findByRole("button", { name: "ارسال درخواست" })).toBeInTheDocument();
  });
});
