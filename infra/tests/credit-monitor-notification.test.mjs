import assert from "node:assert/strict";
import test from "node:test";
import { creditAlertKind, creditNotificationContent } from "../lambda/credit-monitor.mjs";

function expiringChange({ accountId = "848545826963", description = "AWS Free Tier", remaining = 10, state = "active" } = {}) {
  return {
    account: { accountId, name: "北跳", groupName: "老代付" },
    credit: {
      description,
      state,
      endDate: "2026-09-27T00:00:00.000Z",
      estimatedAmount: { currencyCode: "USD", currencyAmount: remaining },
    },
    changes: [{ type: "expiring", field: "endDate", before: 2, after: 1, threshold: 1 }],
  };
}

test("does not alert an exhausted zero-balance credit as expiring", () => {
  assert.equal(creditAlertKind(expiringChange({ remaining: 0, state: "exhausted" })), "");
});

test("keeps an expiring alert for an active credit with balance", () => {
  assert.equal(creditAlertKind(expiringChange()), "expiring");
});

test("summarizes the fact first and groups same-account same-date credits", () => {
  const first = expiringChange();
  const second = expiringChange({ description: "Explore AWS: Launch an instance using EC2", remaining: 20 });
  const alerts = [first, second].map((change) => ({ change, kind: creditAlertKind(change) }));
  const content = creditNotificationContent(alerts, "2026/9/26 15:31:22");
  assert.equal(content, `**【代金券提醒】2 张明天到期**

> **北跳（848545826963）｜老代付**
> 明天到期（2026-09-27）
> - AWS Free Tier｜余额 USD 10.00
> - Explore AWS: Launch an instance using EC2｜余额 USD 20.00

检查：2026/9/26 15:31`);
});
