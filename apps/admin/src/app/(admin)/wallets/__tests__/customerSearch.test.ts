import {
  formatCustomerName,
  unwrapCustomerSearchResults,
  type WalletCustomer,
} from "../customerSearch";

const customer: WalletCustomer = {
  id: 12,
  phone: "+989123381098",
  firstName: "سید محمد",
  lastName: "حسینی",
  isActive: true,
};

describe("wallet customer search helpers", () => {
  it("unwraps the Strapi envelope used by apiClient", () => {
    expect(
      unwrapCustomerSearchResults({
        data: [customer],
        meta: { pageSize: 20, count: 1 },
      }),
    ).toEqual([customer]);
  });

  it("unwraps a double-wrapped generic mix-up", () => {
    expect(
      unwrapCustomerSearchResults({
        data: { data: [customer] },
      }),
    ).toEqual([customer]);
  });

  it("accepts a bare array", () => {
    expect(unwrapCustomerSearchResults([customer])).toEqual([customer]);
  });

  it("returns an empty list instead of crashing on an object payload", () => {
    expect(unwrapCustomerSearchResults({ data: { meta: { count: 0 } } })).toEqual([]);
    expect(unwrapCustomerSearchResults(null)).toEqual([]);
  });

  it("joins a first and last name without inventing placeholders", () => {
    expect(formatCustomerName(customer)).toBe("سید محمد حسینی");
    expect(formatCustomerName({ firstName: null, lastName: null })).toBe("");
  });
});
