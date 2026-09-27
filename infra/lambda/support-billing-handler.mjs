import { isSupportBillingScheduledEvent, runScheduledSupportBilling } from "./support-billing.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "support-billing",
  matches: isSupportBillingScheduledEvent,
  run: runScheduledSupportBilling,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE"],
});
