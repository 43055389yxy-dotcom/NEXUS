import { isOuAutomationScheduledEvent, runScheduledOuAutomation } from "./ou-automation.mjs";
import { checkCrossAccountBridge } from "./cross-account.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "ou-automation",
  matches: isOuAutomationScheduledEvent,
  run: runScheduledOuAutomation,
  checkBridge: checkCrossAccountBridge,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE"],
});
