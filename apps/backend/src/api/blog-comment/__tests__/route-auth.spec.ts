import routeConfig from "../routes/custom-router";
import { CONTENT_EDITOR_ROLES } from "../../../utils/roles";

describe("blog moderation route authorization", () => {
  it.each(["/blog-comments/:id/approve", "/blog-comments/:id/reject"])(
    "keeps %s limited to content editors",
    (path) => {
      const route = routeConfig.routes.find((entry) => entry.path === path);
      expect(route?.config.policies).toEqual([
        {
          name: "global::role-based",
          config: { roles: CONTENT_EDITOR_ROLES },
        },
      ]);
    },
  );
});
