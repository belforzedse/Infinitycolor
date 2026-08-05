import {
  translateAction,
  translateResourceType,
  translateFieldLabel,
  formatChangeValue,
  summarizeChange,
  summarizeActivity,
  getSeverityMeta,
  formatMetadataValue,
  translateMetadataKey,
  formatActivityIp,
} from "../adminActivityLabels";

describe("translateAction / translateResourceType", () => {
  it("maps known codes to Persian", () => {
    expect(translateAction("StatusChange")).toBe("تغییر وضعیت");
    expect(translateResourceType("Order")).toBe("سفارش");
  });

  it("falls back to the raw value for unknown codes", () => {
    expect(translateAction("SomethingNew")).toBe("SomethingNew");
    expect(translateResourceType("Widget")).toBe("Widget");
    expect(translateAction(null)).toBe("نامشخص");
  });
});

describe("translateFieldLabel", () => {
  it("maps known fields and the Item_<id>_Count pattern", () => {
    expect(translateFieldLabel("Status")).toBe("وضعیت سفارش");
    expect(translateFieldLabel("Item_42_Count")).toBe("تعداد قلم");
  });

  it("falls back to the raw key for unknown fields", () => {
    expect(translateFieldLabel("WeirdField")).toBe("WeirdField");
  });
});

describe("formatChangeValue", () => {
  it("translates status values", () => {
    expect(formatChangeValue("Status", "delivered")).toBe("تحویل داده شده");
  });

  it("formats amount fields with Persian digits", () => {
    expect(formatChangeValue("ShippingCost", 120000)).toBe(faDigits("120000"));
  });

  it("renders null/empty as an em dash", () => {
    expect(formatChangeValue("Note", null)).toBe("—");
    expect(formatChangeValue("Note", "")).toBe("—");
  });

  it("handles booleans and objects without crashing", () => {
    expect(formatChangeValue("Flag", true)).toBe("بله");
    expect(formatChangeValue("Obj", { a: 1 })).toBe("(مقدار به‌روزرسانی شد)");
  });
});

describe("summarizeChange", () => {
  it("produces a meaningful status sentence", () => {
    expect(summarizeChange("Status", { from: "paying", to: "started" })).toBe(
      "وضعیت سفارش از «در انتظار پرداخت» به «در حال انجام» تغییر کرد",
    );
  });

  it("produces dedicated messages for shipping / amount / customer fields", () => {
    expect(summarizeChange("ShippingMethod", {})).toBe("روش ارسال تغییر کرد");
    expect(summarizeChange("ShippingCost", {})).toBe("هزینه ارسال حذف شد");
    expect(summarizeChange("CustomerPhone", {})).toBe("اطلاعات مشتری به‌روزرسانی شد");
  });

  it("falls back to a generic sentence for unknown fields", () => {
    expect(summarizeChange("WeirdField", {})).toBe("WeirdField تغییر کرد");
  });
});

describe("summarizeActivity", () => {
  it("prefers the backend Title", () => {
    expect(summarizeActivity({ Title: "سفارش ویرایش شد" })).toBe("سفارش ویرایش شد");
  });

  it("derives from a single change when no title/message", () => {
    expect(
      summarizeActivity({ Changes: { Status: { from: "paying", to: "started" } } }),
    ).toBe("وضعیت سفارش از «در انتظار پرداخت» به «در حال انجام» تغییر کرد");
  });

  it("derives from action + resource as the last resort", () => {
    expect(summarizeActivity({ Action: "Create", ResourceType: "Order" })).toBe("ایجاد سفارش");
  });

  it("does not crash on an empty/old row", () => {
    expect(typeof summarizeActivity({})).toBe("string");
  });
});

describe("getSeverityMeta", () => {
  it("returns meta for known severities and defaults to info", () => {
    expect(getSeverityMeta("error").label).toBe("خطا");
    expect(getSeverityMeta(undefined).label).toBe("اطلاعات");
    expect(getSeverityMeta("nonsense").label).toBe("اطلاعات");
  });
});

describe("metadata + ip helpers", () => {
  it("translates metadata keys and formats values", () => {
    expect(translateMetadataKey("reason")).toBe("دلیل");
    expect(translateMetadataKey("custom")).toBe("custom");
    expect(formatMetadataValue(["Status", "Note"])).toBe("وضعیت سفارش، یادداشت مشتری");
    expect(formatMetadataValue(null)).toBe("—");
  });

  it("formats IP with a dash fallback", () => {
    expect(formatActivityIp("1.2.3.4")).toBe("1.2.3.4");
    expect(formatActivityIp(null)).toBe("—");
  });
});

/** faNum uses fa-IR grouping; build the expected string the same way for a robust assertion. */
function faDigits(input: string): string {
  return new Intl.NumberFormat("fa-IR").format(Number(input));
}
