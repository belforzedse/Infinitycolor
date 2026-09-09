import { FOOTER_DATA } from "./footer";

describe("footer quick-access categories", () => {
  it("uses distinct canonical category destinations", () => {
    expect(FOOTER_DATA.second.links).toEqual([
      { title: "خرید بافت", url: "/plp/category/پلیور-و-بافت" },
      { title: "خرید پیراهن زنانه", url: "/plp/category/shirt" },
      { title: "خرید شال و روسری", url: "/plp/category/shawls-and-scarves" },
      { title: "خرید شومیز", url: "/plp/category/paperback-and-tonic" },
      { title: "خرید مانتو", url: "/plp/category/coat-and-mantle" },
    ]);

    expect(
      new Set(FOOTER_DATA.second.links.map((link) => ("url" in link ? link.url : ""))).size,
    ).toBe(5);
  });

  it("exposes the exchange and return policy in customer-service links", () => {
    expect(FOOTER_DATA.third.header).toBe("خدمات مشتریان");
    expect(FOOTER_DATA.third.links).toContainEqual({
      title: "شرایط و مقررات تعویض و مرجوع",
      url: "/returns",
    });
  });

  it("opens model hiring from درخواست همکاری in customer-service links", () => {
    expect(FOOTER_DATA.third.links).toContainEqual({
      title: "درخواست همکاری",
      action: "open-model-hiring",
    });
  });
});
