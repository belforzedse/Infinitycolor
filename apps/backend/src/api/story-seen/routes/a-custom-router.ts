/**
 * Custom router for story-seen APIs
 */

export default {
  routes: [
    {
      method: "POST",
      path: "/story-seens/mark",
      handler: "story-seen.markSeen",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "POST",
      path: "/story-seens/mark-item",
      handler: "story-seen.markItemSeen",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/story-seens/mine",
      handler: "story-seen.getMine",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "GET",
      path: "/story-seens/mine-items",
      handler: "story-seen.getMineItems",
      config: {
        auth: { scope: [] },
      },
    },
  ],
};
