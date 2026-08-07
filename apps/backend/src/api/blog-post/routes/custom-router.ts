export default {
  routes: [
    {
      method: "GET",
      path: "/blog-posts/homepage/cards",
      handler: "blog-post.findHomepage",
      config: {
        auth: false,
        middlewares: [],
        policies: [],
      },
    },
    {
      method: "GET",
      path: "/blog-posts/slug/:slug",
      handler: "blog-post.findBySlug",
      config: {
        auth: false,
        middlewares: [],
        policies: [],
      },
    },
  ],
};
