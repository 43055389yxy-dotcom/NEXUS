import { isSupportBillingScheduledEvent, runScheduledSupportBilling } from "./support-billing.mjs";
import { checkCrossAccountBridge } from "./cross-account.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "support-billing",
  matches: isSupportBillingScheduledEvent,
  run: runScheduledSupportBilling,
  checkBridge: checkCrossAccountBridge,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE"],
});
