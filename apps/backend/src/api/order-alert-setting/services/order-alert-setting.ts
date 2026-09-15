/**
 * order-alert-setting service
 *
 * The recipient helpers live in `../lib/recipients` so the SMS sender can import
 * them without pulling in the Strapi service factory.
 */

import { factories } from "@strapi/strapi";

import { ORDER_ALERT_SETTING_UID } from "../lib/recipients";

export default factories.createCoreService(ORDER_ALERT_SETTING_UID);
