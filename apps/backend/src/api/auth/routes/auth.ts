export default {
  routes: [
    {
      method: "POST",
      path: "/auth/otp",
      handler: "auth.otp",
      config: {
        auth: false,
        policies: [],
        middlewares: ["api::auth.throttle"],
      },
    },
    {
      method: "POST",
      path: "/auth/login",
      handler: "auth.login",
      config: {
        auth: false,
        policies: [],
        middlewares: ["api::auth.login-throttle"], // Prevent brute force: 5 attempts per 10 min
      },
    },
    {
      method: "GET",
      path: "/auth/self",
      handler: "auth.self",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "PUT",
      path: "/auth/self",
      handler: "auth.updateSelf",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "POST",
      path: "/auth/welcome",
      handler: "auth.welcome",
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
    {
      method: "POST",
      path: "/auth/register-info",
      handler: "auth.registerInfo",
      config: {
        auth: { scope: [] },
      },
    },
    {
      method: "POST",
      path: "/auth/login-with-password",
      handler: "auth.loginWithPassword",
      config: {
        auth: false,
        policies: [],
        middlewares: ["api::auth.login-throttle"], // Prevent brute force: 5 attempts per 10 min
      },
    },
    {
      method: "POST",
      path: "/auth/reset-password",
      handler: "auth.resetPassword",
      config: {
        auth: false,
        policies: [],
        // Browser-reachable password resets belong to the central auth app, which is the
        // only place that can revoke the Better Auth sessions a reset has to invalidate.
        // Strapi has no access to `auth.sessions`, so this handler could change the
        // password and leave every existing session alive -- the behaviour
        // docs/auth/architecture.md promises against. Requiring the signed bridge means
        // the only route into it is apps/auth, which revokes.
        middlewares: [
          "api::internal-auth.verify-bridge",
          "api::auth.login-throttle", // Prevent brute force: 5 attempts per 10 min
        ],
      },
    },
  ],
};
