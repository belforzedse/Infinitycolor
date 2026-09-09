import { unwrapStrapiEntity, unwrapStrapiFields } from "../strapiEntity";

describe("unwrapStrapiEntity", () => {
  it("unwraps classic REST { data: { id, attributes } }", () => {
    expect(
      unwrapStrapiEntity({
        data: { id: 9, attributes: { username: "sara", phone: "+989121234567" } },
      }),
    ).toEqual({ id: 9, username: "sara", phone: "+989121234567" });
  });

  it("unwraps users-permissions payloads that skip attributes", () => {
    expect(
      unwrapStrapiEntity({
        data: { id: 4, username: "ali", phone: "09120000000" },
      }),
    ).toEqual({ id: 4, username: "ali", phone: "09120000000" });
  });

  it("unwraps flattened entity-service objects", () => {
    expect(unwrapStrapiEntity({ id: 2, Title: "کیف" })).toEqual({
      id: 2,
      Title: "کیف",
    });
  });

  it("returns undefined when the relation is empty", () => {
    expect(unwrapStrapiEntity({ data: null })).toBeUndefined();
    expect(unwrapStrapiEntity(undefined)).toBeUndefined();
  });
});

describe("unwrapStrapiFields", () => {
  it("reads nested attributes without requiring an id", () => {
    expect(
      unwrapStrapiFields({
        data: { attributes: { FirstName: "سارا", LastName: "محمدی" } },
      }),
    ).toEqual({ FirstName: "سارا", LastName: "محمدی" });
  });
});
