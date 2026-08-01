export function validatePhone(ctx, phone: string) {
  if (!phone) {
    ctx.status = 400;
    ctx.body = {
      message: "شماره همراه الزامی است.",
    };
    return ctx;
  }

  // Accept both formats:
  // - 09XXXXXXXXX (11 digits starting with 0)
  // - +989XXXXXXXXX (international format with +98)
  const isValid = /^(?:09[0-9]{9}|\+989[0-9]{9})$/.test(phone);

  if (!isValid) {
    ctx.status = 400;
    ctx.body = {
      message: "شماره همراه معتبر نیست. دوباره تلاش کنید.",
    };
    return ctx;
  }

  return 200;
}
