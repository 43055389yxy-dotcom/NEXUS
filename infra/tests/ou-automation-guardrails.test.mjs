import assert from "node:assert/strict";
import test from "node:test";
import { isOuAutomationScheduledEvent, persistentRestrictionExemptions } from "../lambda/ou-automation.mjs";

test("keeps only explicit CloudSweep exemptions", () => {
  assert.deepEqual(persistentRestrictionExemptions({
    manual: { reason: "Manual guardrail exemption" },
    cloudsweep: { reason: "CloudSweep SCP scan remediation", taskId: "task-1" },
  }), {
    cloudsweep: { reason: "CloudSweep SCP scan remediation", taskId: "task-1" },
  });
});

test("accepts scheduled reconciliation and read-only legacy OU audit events", () => {
  assert.equal(isOuAutomationScheduledEvent({ source: "aws.events", "detail-type": "Scheduled Event" }), true);
  assert.equal(isOuAutomationScheduledEvent({ source: "nexus.ou-automation", "detail-type": "Legacy OU Audit", dryRun: true }), true);
  assert.equal(isOuAutomationScheduledEvent({ source: "nexus.ou-automation", "detail-type": "Legacy OU Audit", dryRun: false }), false);
});
