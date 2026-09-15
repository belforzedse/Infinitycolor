import {
  getActiveStaffRecipients,
  normalizeRecipients,
} from "../lib/recipients";

function strapiWith(entity: any) {
  return {
    db: {
      query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(entity) })),
    },
  } as any;
}

describe("order alert recipients", () => {
  it("normalizes every accepted Iranian mobile format to E.164", () => {
    expect(
      normalizeRecipients([
        { label: "انبار", phone: "09121234567", enabled: true },
        { label: " پشتیبانی  فنی ", phone: "+989129876543", enabled: true },
        { label: "مدیر", phone: "۹۱۲۱۱۱۲۲۳۳", enabled: false },
      ]),
    ).toEqual([
      { label: "انبار", phone: "+989121234567", enabled: true },
      { label: "پشتیبانی فنی", phone: "+989129876543", enabled: true },
      { label: "مدیر", phone: "+989121112233", enabled: false },
    ]);
  });

  it("drops invalid rows instead of rejecting the whole list", () => {
    expect(
      normalizeRecipients([
        { phone: "02112345678", enabled: true },
        { phone: "not-a-number", enabled: true },
        { phone: "", enabled: true },
        null,
        "09121234567",
        { phone: "09121234567", enabled: true },
      ]),
    ).toEqual([{ label: "", phone: "+989121234567", enabled: true }]);
  });

  it("de-duplicates numbers that normalize to the same line", () => {
    expect(
      normalizeRecipients([
        { label: "الف", phone: "09121234567", enabled: true },
        { label: "ب", phone: "+989121234567", enabled: true },
      ]),
    ).toEqual([{ label: "الف", phone: "+989121234567", enabled: true }]);
  });

  it("defaults a missing enabled flag to true", () => {
    expect(normalizeRecipients([{ phone: "09121234567" }])[0].enabled).toBe(true);
  });

  it("caps the list so a paste cannot fan out unbounded SMS", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      phone: `0912${String(1000000 + i).slice(-7)}`,
      enabled: true,
    }));
    expect(normalizeRecipients(many)).toHaveLength(20);
  });

  it.each([undefined, null, "", 42, {}])("treats %p as an empty list", (value) => {
    expect(normalizeRecipients(value)).toEqual([]);
  });

  it("returns an empty list when the single type has never been saved", async () => {
    await expect(getActiveStaffRecipients(strapiWith(null))).resolves.toEqual([]);
  });

  it("returns an empty list when the alert is switched off", async () => {
    const entity = {
      enabled: false,
      recipients: [{ phone: "09121234567", enabled: true }],
    };
    await expect(getActiveStaffRecipients(strapiWith(entity))).resolves.toEqual([]);
  });

  it("returns only enabled rows", async () => {
    const entity = {
      enabled: true,
      recipients: [
        { label: "انبار", phone: "09121234567", enabled: false },
        { label: "پشتیبانی", phone: "09129876543", enabled: true },
      ],
    };
    await expect(getActiveStaffRecipients(strapiWith(entity))).resolves.toEqual([
      { label: "پشتیبانی", phone: "+989129876543", enabled: true },
    ]);
  });
});
