import { isApnMonitorScheduledEvent, runScheduledApnMonitor } from "./apn-monitor.mjs";
import { createScheduledHandler } from "./scheduled-handler.mjs";

export const handler = createScheduledHandler({
  task: "apn-monitor",
  matches: isApnMonitorScheduledEvent,
  run: runScheduledApnMonitor,
  requiredEnvironment: ["ACCOUNTS_TABLE", "GROUPS_TABLE", "APN_MONITOR_TABLE"],
});
