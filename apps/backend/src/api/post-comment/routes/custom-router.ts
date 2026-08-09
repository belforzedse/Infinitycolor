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
      path: "/post-comments/post/:postId",
      handler: "post-comment.findByPost",
      config: {
        auth: false,
        middlewares: [],
        policies: [],
      },
    },
    {
      method: "PUT",
      path: "/post-comments/:id/approve",
      handler: "post-comment.approve",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: contentEditorPolicy,
      },
    },
    {
      method: "PUT",
      path: "/post-comments/:id/reject",
      handler: "post-comment.reject",
      config: {
        auth: { scope: [] },
        middlewares: [],
        policies: contentEditorPolicy,
      },
    },
  ],
};
