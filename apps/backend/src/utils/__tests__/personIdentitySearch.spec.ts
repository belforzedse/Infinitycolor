import {
  customerPhoneSearchAlternatives,
  personNameSearchAlternatives,
} from "../personIdentitySearch";

describe("person identity search", () => {
  it("splits a three-word name the same way the users list does", () => {
    expect(personNameSearchAlternatives("سید محمد حسینی")).toEqual([
      { user_info: { FirstName: { $containsi: "سید محمد حسینی" } } },
      { user_info: { LastName: { $containsi: "سید محمد حسینی" } } },
      {
        $and: [
          { user_info: { FirstName: { $containsi: "سید" } } },
          { user_info: { LastName: { $containsi: "محمد حسینی" } } },
        ],
      },
      {
        $and: [
          { user_info: { FirstName: { $containsi: "سید محمد" } } },
          { user_info: { LastName: { $containsi: "حسینی" } } },
        ],
      },
    ]);
  });

  it("matches complete numbers against stored shapes and every common typed layout", () => {
    const clauses = customerPhoneSearchAlternatives("09123381098");
    expect(clauses).toEqual(
      expect.arrayContaining([
        { phone: { $containsi: "09123381098" } },
        { phone: { $in: ["+989123381098", "09123381098"] } },
        { phone: { $containsi: "9123381098" } },
        { phone: { $containsi: "+989123381098" } },
        { phone: { $containsi: "989123381098" } },
      ]),
    );
  });

  it("treats a bare national number the same as the 09 and +98 forms", () => {
    const clauses = customerPhoneSearchAlternatives("9123381098");
    expect(clauses).toEqual(
      expect.arrayContaining([
        { phone: { $in: ["+989123381098", "09123381098"] } },
        { phone: { $containsi: "9123381098" } },
        { phone: { $containsi: "09123381098" } },
      ]),
    );
  });

  it("folds Persian digits before matching a complete phone", () => {
    const clauses = customerPhoneSearchAlternatives("۰۹۱۲۳۳۸۱۰۹۸");
    expect(clauses).toEqual(
      expect.arrayContaining([
        { phone: { $in: ["+989123381098", "09123381098"] } },
        { phone: { $containsi: "9123381098" } },
      ]),
    );
  });
});
