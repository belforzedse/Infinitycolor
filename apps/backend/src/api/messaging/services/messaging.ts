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
          if (result.disabled && process.env.NODE_ENV === "development") {
            strapi.log.info(`[dev-otp] SMS disabled; local OTP is ${message}`);
            return 200;
          }
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
