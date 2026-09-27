import { isOuAutomationScheduledEvent, runScheduledOuAutomation } from "./ou-automation.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "ou-automation",
  matches: isOuAutomationScheduledEvent,
  run: runScheduledOuAutomation,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE"],
});
