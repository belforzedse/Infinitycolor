import { submitPaymentHandoff } from "../paymentHandoff";

describe("submitPaymentHandoff", () => {
  const navigate = jest.fn();
  const submit = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(HTMLFormElement.prototype, "submit", {
      value: submit,
      writable: true,
      configurable: true,
    });
  });

  it("navigates directly for GET providers such as ZarinPal sandbox", () => {
    expect(
      submitPaymentHandoff(
        {
          redirectUrl: "https://sandbox.zarinpal.com/pg/StartPay/AUTHORITY",
          redirectMethod: "GET",
        },
        navigate,
      ),
    ).toBe(true);

    expect(navigate).toHaveBeenCalledWith(
      "https://sandbox.zarinpal.com/pg/StartPay/AUTHORITY",
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("posts SEP's exact capital-T Token without placing it in the URL", () => {
    const token = "SEP-TOKEN-SECRET";
    expect(
      submitPaymentHandoff({
        redirectUrl: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
        redirectMethod: "POST",
        formFields: { Token: token },
      }),
    ).toBe(true);

    const form = document.body.querySelector("form") as HTMLFormElement;
    const input = form.querySelector("input") as HTMLInputElement;
    expect(form.method).toBe("post");
    expect(form.action).toBe("https://sep.shaparak.ir/OnlinePG/OnlinePG");
    expect(form.action).not.toContain(token);
    expect(input.name).toBe("Token");
    expect(input.value).toBe(token);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("refuses an incomplete POST handoff", () => {
    expect(
      submitPaymentHandoff({
        redirectUrl: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
        redirectMethod: "POST",
      }),
    ).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
