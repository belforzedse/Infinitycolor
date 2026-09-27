export default {
  routes: [
    {
      method: "POST",
      path: "/admin/media-library/query",
      handler: "admin-media-library.query",
      config: {
        auth: { scope: [] },
        policies: [
          {
            name: "global::require-capability",
            config: { capability: "product.media.manage" },
          },
        ],
      },
    },
  ],
};
