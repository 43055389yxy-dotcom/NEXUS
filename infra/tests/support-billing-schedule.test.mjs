import assert from "node:assert/strict";
import test from "node:test";
import { supportBillingScheduleDecision, supportScanSummaryContent } from "../lambda/support-billing.mjs";

function payer(overrides = {}) {
  return { snapshot: { accounts: [] }, lastScanAt: "", lastStatus: "", lastAutoSyncAt: "", ...overrides };
}

test("runs every three Beijing calendar days outside month end", () => {
  const now = new Date("2026-09-27T02:15:00+08:00");
  assert.deepEqual(supportBillingScheduleDecision(payer({ lastAutoSyncAt: "2026-09-24T02:15:00+08:00" }), now), {
    due: true,
    reason: "three-day-cadence",
    monthEndDaily: false,
    elapsedDays: 3,
  });
  assert.equal(supportBillingScheduleDecision(payer({ lastAutoSyncAt: "2026-09-25T02:15:00+08:00" }), now).due, false);
});

test("runs daily during the final three days of 28, 29, 30 and 31 day months", () => {
  for (const value of ["2027-02-26", "2028-02-27", "2026-09-28", "2026-10-29"]) {
    const decision = supportBillingScheduleDecision(payer({ lastAutoSyncAt: `${value}T01:00:00+08:00` }), new Date(`${value}T02:15:00+08:00`));
    assert.equal(decision.due, true, value);
    assert.equal(decision.reason, "month-end-daily", value);
  }
});

test("skips any duplicate after a successful scan on the same Beijing date", () => {
  const now = new Date("2026-09-30T02:15:00+08:00");
  const decision = supportBillingScheduleDecision(payer({
    lastAutoSyncAt: "2026-09-29T02:15:00+08:00",
    lastScanAt: "2026-09-30T00:30:00+08:00",
    lastStatus: "success",
  }), now);
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "already-successful-today");
});

test("runs when no automatic scan has been recorded", () => {
  const decision = supportBillingScheduleDecision(payer(), new Date("2026-09-10T02:15:00+08:00"));
  assert.equal(decision.due, true);
  assert.equal(decision.reason, "first-automatic-scan");
});

test("manual scan summary stays concise and reports actionable totals", () => {
  const content = supportScanSummaryContent([
    { remark: "PMA1", lastStatus: "partial", snapshot: { accounts: [{ name: "zm", current: { status: "update", synced: 29, aws: 33.25 } }], diagnostics: { viewWarnings: Array.from({ length: 6 }, (_, index) => ({ sourceAccountId: String(index) })) } } },
    { remark: "北跳", lastStatus: "success", snapshot: { accounts: [{ name: "Lucas", current: { status: "normal", synced: 7.07, aws: 7.07 } }], diagnostics: { viewWarnings: [] } } },
  ], new Date("2026-10-08T09:30:00+08:00"));
  assert.equal(content, [
    "**Support+ 扫描完成｜10/08 09:30**",
    "PMA1 · zm：USD 29.00 → USD 33.25",
    "PMA1：6 个账单视图数据待更新",
  ].join("\n"));
});
