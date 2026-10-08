import { isSupportBillingScheduledEvent, preflightSupportBillingAccess, runScheduledSupportBilling, sendSupportBillingNotificationHealthcheck } from "./support-billing.mjs";
import { checkCrossAccountBridge } from "./cross-account.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

const scheduledHandler = createScheduledHandler({
  task: "support-billing",
  matches: isSupportBillingScheduledEvent,
  run: runScheduledSupportBilling,
  checkBridge: checkCrossAccountBridge,
  checkAccess: preflightSupportBillingAccess,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE"],
});

export async function handler(event = {}) {
  if (event?.notificationHealthcheck === true) {
    return { ok: true, task: "support-billing", notification: await sendSupportBillingNotificationHealthcheck() };
  }
  return scheduledHandler(event);
}
