import { isApnMonitorScheduledEvent, runScheduledApnMonitor } from "./apn-monitor.mjs";
import { checkCrossAccountBridge } from "./cross-account.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "apn-monitor",
  matches: isApnMonitorScheduledEvent,
  run: runScheduledApnMonitor,
  checkBridge: checkCrossAccountBridge,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE", "APN_MONITOR_TABLE"],
});
