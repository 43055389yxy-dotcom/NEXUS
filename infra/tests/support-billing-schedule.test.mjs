import assert from "node:assert/strict";
import test from "node:test";
import { dailySupportSyncNotificationContent, executedSupportBillingResults, scheduledSupportPeriods, supportBillingRange, supportBillingScheduleDecision, supportDataWarnings, supportScanSummaryContent } from "../lambda/support-billing.mjs";

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

test("retries an incomplete automatic scan later on the same Beijing date", () => {
  const now = new Date("2026-10-15T06:15:00+08:00");
  const decision = supportBillingScheduleDecision(payer({
    lastAutoSyncAt: "2026-10-15T02:15:00+08:00",
    lastScanAt: "2026-10-15T02:15:00+08:00",
    lastStatus: "partial",
  }), now);
  assert.equal(decision.due, true);
  assert.equal(decision.reason, "same-day-retry");
});

test("runs when no automatic scan has been recorded", () => {
  const decision = supportBillingScheduleDecision(payer(), new Date("2026-09-11T02:15:00+08:00"));
  assert.equal(decision.due, true);
  assert.equal(decision.reason, "first-automatic-scan");
});

test("uses a closed one-month range when updating the previous billing period", () => {
  assert.deepEqual(supportBillingRange("2026-09"), {
    InclusiveStartBillingPeriod: "2026-09",
    ExclusiveEndBillingPeriod: "2026-10",
  });
});

test("runs daily and syncs both periods during the first ten days", () => {
  const now = new Date("2026-10-08T02:15:00+08:00");
  const decision = supportBillingScheduleDecision(payer({ lastAutoSyncAt: "2026-10-07T02:15:00+08:00" }), now);
  assert.equal(decision.due, true);
  assert.equal(decision.reason, "previous-month-closeout");
  assert.deepEqual(scheduledSupportPeriods(now), ["previous", "current"]);
  assert.deepEqual(scheduledSupportPeriods(new Date("2026-10-11T02:15:00+08:00")), ["current"]);
});

test("does not confuse skipped member counts with a skipped payer run", () => {
  const results = [
    { payerName: "已跳过", skipped: true },
    { payerName: "已执行", skipped: 140, updated: 2 },
  ];
  assert.deepEqual(executedSupportBillingResults(results), [results[1]]);
});

test("scheduled notification shows changes and summarizes unavailable billing views", () => {
  const content = dailySupportSyncNotificationContent([{
    payerName: "PMA1",
    failed: 0,
    repaired: 0,
    synced: 1,
    changes: [{ periodKey: "previous", accountName: "zm", previousAmount: "$33.25", nextAmount: "$34.93" }],
    warnings: ["PMA1：3 个账单视图暂无数据，后续自动重试"],
    scan: { refreshed: false },
  }], new Date("2026-10-08T16:15:00+08:00"));
  assert.equal(content, [
    "**Support+ 费用更新｜10/08 16:15**",
    "上月 · PMA1 · zm：$33.25 → $34.93",
    "PMA1：3 个账单视图暂无数据，后续自动重试",
  ].join("\n"));
});

test("unavailable billing data is labeled as an automatic retry", () => {
  const content = dailySupportSyncNotificationContent([{
    payerName: "PMA1",
    failed: 0,
    repaired: 0,
    synced: 0,
    changes: [],
    warnings: ["PMA1：3 个账单视图暂无数据，后续自动重试"],
    scan: { refreshed: false },
  }], new Date("2026-10-08T16:13:00+08:00"));
  assert.equal(content, [
    "**Support+ 自动重试｜10/08 16:13**",
    "PMA1：3 个账单视图暂无数据，后续自动重试",
  ].join("\n"));
});

test("warning summary excludes duplicate discovery text and unavailable previous views", () => {
  const value = supportDataWarnings({ accountId: "851725571764", remark: "PMA1" }, {
    diagnostics: { viewWarnings: [
      { period: "current", sourceAccountId: "332896938827", error: "DataUnavailableException" },
      { period: "current", sourceAccountId: "119623944537", error: "DataUnavailableException" },
      { period: "previous", sourceAccountId: "396288591536", error: "DataUnavailableException" },
      { period: "previous", sourceAccountId: "119004747073", error: "当前账期没有可用账单视图" },
      { period: "previous", sourceAccountId: "917914001026", error: "当前账期没有可用账单视图" },
      { period: "current", sourceAccountId: "851725571764", error: "部分账单视图查询失败，成员账号名单未完整刷新" },
    ] },
  });
  assert.deepEqual(value, ["PMA1：3 个账单视图暂无数据，后续自动重试"]);
});

test("manual scan summary stays concise and reports actionable totals", () => {
  const content = supportScanSummaryContent([
    { remark: "PMA1", lastStatus: "partial", snapshot: { accounts: [{ name: "zm", current: { status: "update", synced: 29, aws: 33.25 } }], diagnostics: { viewWarnings: Array.from({ length: 6 }, (_, index) => ({ sourceAccountId: String(index) })) } } },
    { remark: "北跳", lastStatus: "success", snapshot: { accounts: [{ name: "Lucas", current: { status: "normal", synced: 7.07, aws: 7.07 } }], diagnostics: { viewWarnings: [] } } },
  ], new Date("2026-10-08T09:30:00+08:00"));
  assert.equal(content, [
    "**Support+ 扫描完成｜10/08 09:30**",
    "PMA1 · zm：USD 29.00 → USD 33.25",
    "PMA1：6 个账单视图暂无数据，后续自动重试",
  ].join("\n"));
});
