const bridgeMiddleware = ["api::internal-auth.verify-bridge"];

export default {
  routes: [
    {
      method: "POST",
      path: "/internal/auth/phone-status",
      handler: "internal-auth.phoneStatus",
      config: { auth: false, policies: [], middlewares: bridgeMiddleware },
    },
    {
      method: "POST",
      path: "/internal/auth/otp/request",
      handler: "internal-auth.otpRequest",
      config: { auth: false, policies: [], middlewares: bridgeMiddleware },
    },
    {
      method: "POST",
      path: "/internal/auth/otp/verify",
      handler: "internal-auth.otpVerify",
      config: { auth: false, policies: [], middlewares: bridgeMiddleware },
    },
    {
      method: "POST",
      path: "/internal/auth/password/verify",
      handler: "internal-auth.passwordVerify",
      config: { auth: false, policies: [], middlewares: bridgeMiddleware },
    },
    {
      method: "POST",
      path: "/internal/auth/password/reset",
      handler: "internal-auth.passwordReset",
      config: { auth: false, policies: [], middlewares: bridgeMiddleware },
    },
  ],
};
