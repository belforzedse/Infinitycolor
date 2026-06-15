/**
 * messaging service
 */

import { sendLegacyOtpSms } from "../../../services/sms";

export default () => ({
  async sendSMS(ctx, { phone, message, isOTP = true }) {
    try {
      if (isOTP) {
        const result = await sendLegacyOtpSms({
          phone,
          code: message,
          logger: strapi.log,
        });
        if (!result.ok) {
          return false;
        }
      }

      return 200;
    } catch (err) {
      strapi.log.error("[messaging] SMS send failed", {
        error: (err as Error)?.message || err,
      });
      return false;
    }
  },
});
