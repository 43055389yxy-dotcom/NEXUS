import { isOuAutomationScheduledEvent, preflightOuAutomationAccess, runOuAutomationEvent } from "./ou-automation.mjs";
import { checkCrossAccountBridge } from "./cross-account.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "ou-automation",
  matches: isOuAutomationScheduledEvent,
  run: runOuAutomationEvent,
  checkBridge: checkCrossAccountBridge,
  checkAccess: preflightOuAutomationAccess,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE"],
});
