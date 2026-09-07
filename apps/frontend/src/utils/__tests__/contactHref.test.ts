import { contactHref, normalizeContactDigits } from "../identityIcons";

/**
 * Phone and WhatsApp details rendered as plain text, so a shopper on a phone
 * could not tap to call or open a chat. CMS values arrive with Persian digits
 * and separators, so normalisation has to survive both.
 */
describe("normalizeContactDigits", () => {
  it.each([
    ["09121234567", "989121234567"],
    ["۰۹۱۲۱۲۳۴۵۶۷", "989121234567"],
    ["0912 123 4567", "989121234567"],
    ["0912-123-4567", "989121234567"],
    ["+98 912 123 4567", "989121234567"],
    ["00989121234567", "989121234567"],
    ["989121234567", "989121234567"],
    ["021-88776655", "982188776655"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeContactDigits(input)).toBe(expected);
  });

  it.each(["", "   ", "تماس بگیرید", "12345"])("rejects unusable value %p", (input) => {
    expect(normalizeContactDigits(input)).toBeNull();
  });
});

describe("contactHref", () => {
  it("dials phone and mobile numbers", () => {
    expect(contactHref({ number: "09121234567", type: "mobile" })).toBe("tel:+989121234567");
    expect(contactHref({ number: "021-88776655", type: "phone" })).toBe("tel:+982188776655");
  });

  it("opens a WhatsApp chat without a plus sign", () => {
    expect(contactHref({ number: "۰۹۱۲۱۲۳۴۵۶۷", type: "whatsapp" })).toBe(
      "https://wa.me/989121234567",
    );
  });

  it("returns null so an unusable number stays plain text", () => {
    expect(contactHref({ number: "به زودی", type: "phone" })).toBeNull();
  });
});
