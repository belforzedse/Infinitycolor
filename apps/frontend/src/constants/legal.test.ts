import { RETURNS_CLAUSES, RETURNS_PATH, RETURNS_TITLE } from "./legal";

describe("return policy storefront copy", () => {
  it("keeps the exchange and return policy on a public path", () => {
    expect(RETURNS_PATH).toBe("/returns");
    expect(RETURNS_TITLE).toBe("شرایط و مقررات تعویض و مرجوع");
  });

  it("covers ten numbered exchange and return clauses", () => {
    expect(RETURNS_CLAUSES.map((clause) => clause.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
