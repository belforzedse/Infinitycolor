import { normalizeSiteIdentity } from "./site-identity";

describe("normalizeSiteIdentity", () => {
  it("preserves the store postal code used by invoice printouts", () => {
    const identity = normalizeSiteIdentity({
      siteName: "مجموعه فروشگاه پوشاک",
      stores: [
        {
          name: "گرگان",
          address: "گرگان، بلوار ناهارخوران",
          postalCode: "4916976618",
          phones: [],
          socialLinks: [],
        },
      ],
      socialLinks: [],
      contactNumbers: [],
    });

    expect(identity.stores[0]).toMatchObject({
      name: "گرگان",
      address: "گرگان، بلوار ناهارخوران",
      postalCode: "4916976618",
    });
  });
});
