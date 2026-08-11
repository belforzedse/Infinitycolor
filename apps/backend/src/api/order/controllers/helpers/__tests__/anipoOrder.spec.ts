import {
  buildAnipoOrderRecipient,
  normalizeAnipoLocationName,
  normalizeAnipoPostalCode,
} from "../anipoOrder";

describe("Anipo order recipient", () => {
  test("uses the actual lowercase users-permissions phone and profile name", () => {
    expect(buildAnipoOrderRecipient({
      user: {
        phone: "+989123456789",
        user_info: { FirstName: "زهرا", LastName: "محمدی" },
      },
      delivery_address: {
        PostalCode: "۳۱۵۳۶۱۲۳۴۵",
        FullAddress: " خیابان شهید بهشتی، پلاک ۱۲ ",
        shipping_city: {
          Title: " كرج ",
          shipping_province: { Title: " البرز " },
        },
      },
    })).toEqual({
      receiverName: "زهرا محمدی",
      provinceName: "البرز",
      cityName: "کرج",
      mobile: "09123456789",
      fullAddress: "خیابان شهید بهشتی، پلاک ۱۲",
      postalCode: "3153612345",
    });
  });

  test("prefers immutable address recipient fields over the account profile", () => {
    const recipient = buildAnipoOrderRecipient({
      user: {
        phone: "09120000000",
        user_info: { FirstName: "کاربر", LastName: "حساب" },
      },
      delivery_address: {
        FullName: "گیرنده سفارش",
        Phone: "989111111111",
      },
    });
    expect(recipient.receiverName).toBe("گیرنده سفارش");
    expect(recipient.mobile).toBe("09111111111");
  });

  test("normalizes provider-visible location names and omits invalid postal sentinels", () => {
    expect(normalizeAnipoLocationName("  كهگيلويه   و بويراحمد  ")).toBe("کهگیلویه و بویراحمد");
    expect(normalizeAnipoPostalCode("0000000000")).toBeUndefined();
    expect(normalizeAnipoPostalCode("12345")).toBeUndefined();
  });
});
