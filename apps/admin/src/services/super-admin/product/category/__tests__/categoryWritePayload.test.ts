import { buildCategoryWritePayload } from "../categoryWritePayload";

describe("buildCategoryWritePayload", () => {
  it("sends schema field parent, not Parent, when a parent is selected", () => {
    const payload = buildCategoryWritePayload({
      Title: "کیف",
      Slug: "bags",
      parentId: "12",
      Image: 4,
      MegaMenuImage: null,
    });

    expect(payload).toEqual({
      Title: "کیف",
      Slug: "bags",
      parent: "12",
      Image: 4,
      MegaMenuImage: null,
    });
    expect(payload).not.toHaveProperty("Parent");
  });

  it("omits parent on create when the control is empty", () => {
    const payload = buildCategoryWritePayload({
      Title: "کیف",
      Slug: "bags",
      parentId: "",
    });

    expect(payload).toEqual({ Title: "کیف", Slug: "bags" });
    expect(payload).not.toHaveProperty("parent");
    expect(payload).not.toHaveProperty("Parent");
  });

  it("sends parent null on edit so a child can be unlinked", () => {
    const payload = buildCategoryWritePayload({
      Title: "کیف",
      Slug: "bags",
      parentId: "  ",
      unlinkEmptyParent: true,
    });

    expect(payload.parent).toBeNull();
    expect(payload).not.toHaveProperty("Parent");
  });
});
