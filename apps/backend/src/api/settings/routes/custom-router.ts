const capabilityPolicy = (capability: string) => [
  {
    name: "global::require-capability",
    config: {
      capability,
    },
  },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/settings/blog-banners",
      handler: "settings.getBlogBanners",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "content.blog.banners.manage" } },
        ],
      },
    },
    {
      method: "PUT",
      path: "/settings/blog-banners",
      handler: "settings.updateBlogBanners",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "content.blog.banners.manage" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/site-settings",
      handler: "settings.find",
      config: {
        auth: false,
        middlewares: [],
        policies: [],
      },
    },
    {
      method: "PUT",
      path: "/site-settings",
      handler: "settings.update",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: capabilityPolicy("system.settings.manage"),
      },
    },
    {
      method: "GET",
      path: "/settings/hero-slider",
      handler: "settings.getHeroSlider",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: capabilityPolicy("system.customization.manage"),
      },
    },
    {
      method: "PUT",
      path: "/settings/hero-slider/draft",
      handler: "settings.updateHeroSliderDraft",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: capabilityPolicy("system.customization.manage"),
      },
    },
    {
      method: "POST",
      path: "/settings/hero-slider/publish",
      handler: "settings.publishHeroSliderDraft",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: capabilityPolicy("system.customization.manage"),
      },
    },
  ],
};
