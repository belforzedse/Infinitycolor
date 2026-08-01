/**
 * auth service
 */

import { createOtpChallenge, hasUserForPhone } from "./credential-flow";

export default () => ({
  async hasUser(ctx, { phone }) {
    return hasUserForPhone(phone);
  },
  async otp(ctx, { phone }) {
    try {
      return await createOtpChallenge(ctx, phone);
    } catch (err) {
      strapi.log.error(err);
      ctx.status = 500;
      ctx.body = {
        message: err.message,
      };
    }
  },
});
