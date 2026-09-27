import { isCreditMonitorScheduledEvent, preflightCreditMonitorAccess, runScheduledCreditMonitor } from "./credit-monitor.mjs";
import { checkCrossAccountBridge } from "./cross-account.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "credit-monitor",
  matches: isCreditMonitorScheduledEvent,
  run: runScheduledCreditMonitor,
  checkBridge: checkCrossAccountBridge,
  checkAccess: preflightCreditMonitorAccess,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE", "CREDIT_MONITOR_TABLE"],
});
