const contentEditorPolicy = [
  {
    name: "global::require-capability",
    config: { capability: "content.blog.comments.manage" },
  },
];

export default {
  routes: [
    {
      method: "GET",
      path: "/blog-comments/post/:postId",
      handler: "blog-comment.findByPost",
      config: {
        auth: false,
        middlewares: [],
        policies: [],
      },
    },
    {
      method: "PUT",
      path: "/blog-comments/:id/approve",
      handler: "blog-comment.approve",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: contentEditorPolicy,
      },
    },
    {
      method: "PUT",
      path: "/blog-comments/:id/reject",
      handler: "blog-comment.reject",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: contentEditorPolicy,
      },
    },
  ],
};
