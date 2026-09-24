import { BillingClient, GetCreditsCommand } from "@aws-sdk/client-billing";
import { BatchWriteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

const REGION = process.env.AWS_REGION || "us-east-1";
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE || "TontianAwsAccessAccounts";
const GROUPS_TABLE = process.env.GROUPS_TABLE || "TontianAwsAccessGroups";
const MONITOR_TABLE = process.env.CREDIT_MONITOR_TABLE || "TontianCreditMonitor";
const BILLING_READ_ROLE = "TontianOperationsRole";
const WEBHOOK_URL = process.env.WECOM_CREDIT_WEBHOOK_URL || process.env.WECOM_SUPPORT_WEBHOOK_URL || "";
const WEBHOOK_SECRET_ID = process.env.WECOM_CREDIT_WEBHOOK_SECRET_ID || process.env.WECOM_APN_WEBHOOK_SECRET_ID || "";
const LEGACY_GROUP_NAMES = new Set(["老代付组"]);
const CMA_GROUP_NAMES = new Set(["PMA", "CMA组"]);
const EXPIRY_THRESHOLDS = [30, 7, 1];

const db = new DynamoDBClient({ region: REGION, maxAttempts: 5 });
const sts = new STSClient({ region: REGION, maxAttempts: 5 });
const secrets = new SecretsManagerClient({ region: REGION, maxAttempts: 5 });
let webhookUrlPromise;

function attributeText(value) {
  if (!value) return "";
  if (typeof value.S === "string") return value.S;
  if (typeof value.N === "string") return value.N;
  return "";
}

function simpleItem(item) {
  return Object.fromEntries(Object.entries(item || {}).map(([key, value]) => [key, attributeText(value)]));
}

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function safeJson(value, max = 300000) {
  const output = JSON.stringify(value ?? null);
  if (output.length > max) throw new Error("代金券监控快照过大");
  return output;
}

function iso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function amount(value, fallbackCurrency = "USD") {
  return {
    currencyCode: String(value?.currencyCode || fallbackCurrency || "USD"),
    currencyAmount: number(value?.currencyAmount),
  };
}

function sameAmount(left, right) {
  return left?.currencyCode === right?.currencyCode && number(left?.currencyAmount) === number(right?.currencyAmount);
}

function daysUntil(value, from = new Date()) {
  if (!value) return null;
  const end = new Date(value);
  if (Number.isNaN(end.getTime())) return null;
  return Math.ceil((end.getTime() - from.getTime()) / 86400000);
}

function creditState(item, now = new Date()) {
  if (String(item.creditStatus || "").toUpperCase() === "DISABLED") return "disabled";
  const remaining = number(item.estimatedAmount?.currencyAmount ?? item.remainingAmount?.currencyAmount);
  if (item.exhaustDate || remaining <= 0) return "exhausted";
  const remainingDays = daysUntil(item.endDate, now);
  if (remainingDays !== null && remainingDays < 0) return "expired";
  return "active";
}

export function normalizeCredit(item, observedAt = new Date().toISOString()) {
  const initialAmount = amount(item.initialAmount);
  const remainingAmount = amount(item.remainingAmount, initialAmount.currencyCode);
  const estimatedAmount = amount(item.estimatedAmount || item.remainingAmount, initialAmount.currencyCode);
  return {
    creditId: String(item.creditId || ""),
    ownerAccountId: String(item.accountId || ""),
    creditType: String(item.creditType || ""),
    description: String(item.description || item.creditId || "").slice(0, 500),
    initialAmount,
    remainingAmount,
    estimatedAmount,
    usedAmount: { currencyCode: initialAmount.currencyCode, currencyAmount: number(initialAmount.currencyAmount - remainingAmount.currencyAmount) },
    estimatedUsedAmount: { currencyCode: initialAmount.currencyCode, currencyAmount: number(initialAmount.currencyAmount - estimatedAmount.currencyAmount) },
    applicableProductNames: Array.isArray(item.applicableProductNames) ? item.applicableProductNames.map(String).slice(0, 100) : [],
    startDate: iso(item.startDate),
    endDate: iso(item.endDate),
    exhaustDate: iso(item.exhaustDate),
    creditStatus: String(item.creditStatus || ""),
    state: creditState(item, new Date(observedAt)),
    sharingType: String(item.creditSharingType || ""),
    sharingEnabled: item.accountHasCreditSharingEnabled === true,
    observedAt,
  };
}

function moneyText(value) {
  return `${value?.currencyCode || "USD"} ${number(value?.currencyAmount).toFixed(2)}`;
}

export function creditChanges(before, after, baselineExists = true) {
  if (!before) return baselineExists ? [{ type: "new", field: "credit", before: null, after }] : [];
  const changes = [];
  if (!sameAmount(before.remainingAmount, after.remainingAmount)) changes.push({ type: "balance", field: "remainingAmount", before: before.remainingAmount, after: after.remainingAmount });
  if (!sameAmount(before.estimatedAmount, after.estimatedAmount)) changes.push({ type: "balance", field: "estimatedAmount", before: before.estimatedAmount, after: after.estimatedAmount });
  if (before.state !== after.state) changes.push({ type: after.state === "exhausted" ? "exhausted" : "status", field: "state", before: before.state, after: after.state });
  if (before.endDate !== after.endDate) changes.push({ type: "expiry_changed", field: "endDate", before: before.endDate, after: after.endDate });
  const previousDays = daysUntil(after.endDate, new Date(before.observedAt || after.observedAt));
  const currentDays = daysUntil(after.endDate, new Date(after.observedAt));
  const crossed = EXPIRY_THRESHOLDS.filter((threshold) => previousDays !== null && currentDays !== null && previousDays > threshold && currentDays <= threshold).sort((left, right) => left - right)[0];
  if (crossed) changes.push({ type: "expiring", field: "endDate", before: previousDays, after: currentDays, threshold: crossed });
  return changes;
}

async function scanAll(TableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await db.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function listCreditMonitorAccounts() {
  const [groups, accounts] = await Promise.all([scanAll(GROUPS_TABLE), scanAll(ACCOUNTS_TABLE)]);
  const groupNames = new Map(groups.map(simpleItem).filter((item) => item.groupId && item.name).map((item) => [item.groupId, item.name]));
  return accounts.map(simpleItem).flatMap((account) => {
    const groupName = groupNames.get(account.groupId) || "";
    const legacy = LEGACY_GROUP_NAMES.has(groupName);
    const cma = CMA_GROUP_NAMES.has(groupName) && account.accountType === "cma";
    if (!/^\d{12}$/.test(account.accountId || "") || (!legacy && !cma)) return [];
    return [{
      accountId: account.accountId,
      name: account.remark || account.name || account.accountId,
      architecture: cma ? "cma" : "legacy_payer",
      groupName: cma ? "CMA" : "老代付",
    }];
  }).sort((left, right) => left.architecture.localeCompare(right.architecture) || left.name.localeCompare(right.name, "zh-CN"));
}

async function queryPartition(accountId) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await db.send(new QueryCommand({
      TableName: MONITOR_TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: `ACCOUNT#${accountId}` } },
      ExclusiveStartKey,
    }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.map(simpleItem);
}

async function batchWrite(requests) {
  for (let offset = 0; offset < requests.length; offset += 25) {
    let pending = requests.slice(offset, offset + 25);
    for (let attempt = 0; pending.length && attempt < 5; attempt += 1) {
      const result = await db.send(new BatchWriteItemCommand({ RequestItems: { [MONITOR_TABLE]: pending } }));
      pending = result.UnprocessedItems?.[MONITOR_TABLE] || [];
      if (pending.length) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    if (pending.length) throw new Error("代金券监控数据未能完整写入");
  }
}

async function billingClient(accountId) {
  const result = await sts.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/${BILLING_READ_ROLE}`,
    RoleSessionName: "nexus-credit-monitor",
    DurationSeconds: 900,
  }));
  const value = result.Credentials;
  if (!value?.AccessKeyId || !value.SecretAccessKey || !value.SessionToken) throw new Error("无法取得代付账号临时权限");
  return new BillingClient({
    region: "us-east-1",
    maxAttempts: 5,
    credentials: { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken },
  });
}

async function readCredits(account) {
  const client = await billingClient(account.accountId);
  const now = new Date();
  const startDate = new Date(now.getTime() - 364 * 86400000);
  const result = await client.send(new GetCreditsCommand({ accountId: account.accountId, startDate, payerAccountFlag: true }));
  const observedAt = now.toISOString();
  return (result.credits || []).filter((item) => item.creditId).map((item) => normalizeCredit(item, observedAt)).sort((left, right) => left.endDate.localeCompare(right.endDate) || left.creditId.localeCompare(right.creditId));
}

function creditItem(account, credit) {
  return {
    pk: { S: `ACCOUNT#${account.accountId}` },
    sk: { S: `CREDIT#${credit.creditId}` },
    accountId: { S: account.accountId },
    accountName: { S: account.name },
    architecture: { S: account.architecture },
    creditId: { S: credit.creditId },
    stateJson: { S: safeJson(credit) },
    observedAt: { S: credit.observedAt },
  };
}

function historyItem(account, credit, changes) {
  return {
    pk: { S: `ACCOUNT#${account.accountId}` },
    sk: { S: `HISTORY#${credit.observedAt}#${credit.creditId}` },
    accountId: { S: account.accountId },
    accountName: { S: account.name },
    architecture: { S: account.architecture },
    creditId: { S: credit.creditId },
    description: { S: credit.description },
    changesJson: { S: safeJson(changes, 50000) },
    observedAt: { S: credit.observedAt },
  };
}

function metaItem(account, observedAt, credits, status = "ok", error = "") {
  const active = credits.filter((credit) => credit.state === "active").length;
  return {
    pk: { S: `ACCOUNT#${account.accountId}` },
    sk: { S: "META" },
    accountId: { S: account.accountId },
    accountName: { S: account.name },
    architecture: { S: account.architecture },
    groupName: { S: account.groupName },
    lastRunAt: { S: observedAt },
    creditCount: { N: String(credits.length) },
    activeCreditCount: { N: String(active) },
    status: { S: status },
    error: { S: String(error || "").slice(0, 500) },
  };
}

async function refreshAccount(account) {
  const previousItems = await queryPartition(account.accountId);
  const previousMeta = previousItems.find((item) => item.sk === "META");
  const baselineExists = previousMeta?.status === "ok";
  const previousCredits = new Map(previousItems.filter((item) => item.sk.startsWith("CREDIT#")).map((item) => [item.creditId, parseJson(item.stateJson)]));
  const credits = await readCredits(account);
  const changes = credits.flatMap((credit) => {
    const items = creditChanges(previousCredits.get(credit.creditId), credit, baselineExists);
    return items.length ? [{ account, credit, changes: items }] : [];
  });
  const seen = new Set(credits.map((credit) => credit.creditId));
  const requests = [
    ...credits.map((credit) => ({ PutRequest: { Item: creditItem(account, credit) } })),
    ...changes.map((change) => ({ PutRequest: { Item: historyItem(account, change.credit, change.changes) } })),
    ...[...previousCredits.keys()].filter((creditId) => !seen.has(creditId)).map((creditId) => ({ DeleteRequest: { Key: { pk: { S: `ACCOUNT#${account.accountId}` }, sk: { S: `CREDIT#${creditId}` } } } })),
    { PutRequest: { Item: metaItem(account, credits[0]?.observedAt || new Date().toISOString(), credits) } },
  ];
  await batchWrite(requests);
  return { account, credits, changes, baselineCreated: !baselineExists };
}

async function saveFailure(account, error) {
  const previousItems = await queryPartition(account.accountId).catch(() => []);
  const credits = previousItems.filter((item) => item.sk.startsWith("CREDIT#")).map((item) => parseJson(item.stateJson));
  await db.send(new PutItemCommand({ TableName: MONITOR_TABLE, Item: metaItem(account, new Date().toISOString(), credits, "error", error) }));
}

async function mapLimited(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }));
  return output;
}

async function loadWebhookUrl() {
  if (WEBHOOK_URL) return WEBHOOK_URL;
  if (!WEBHOOK_SECRET_ID) return "";
  if (!webhookUrlPromise) {
    webhookUrlPromise = secrets.send(new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ID })).then((result) => String(result.SecretString || "").trim()).catch((error) => {
      webhookUrlPromise = undefined;
      throw error;
    });
  }
  return webhookUrlPromise;
}

function changeText(change) {
  const { account, credit, changes } = change;
  const types = new Set(changes.map((item) => item.type));
  let detail = "状态已更新";
  const balance = changes.find((item) => item.field === "estimatedAmount") || changes.find((item) => item.field === "remainingAmount");
  const expiring = changes.find((item) => item.type === "expiring");
  if (types.has("new")) detail = `新增代金券，金额 ${moneyText(credit.initialAmount)}`;
  else if (types.has("exhausted")) detail = "代金券已耗尽";
  else if (expiring) detail = `距离到期仅剩 ${expiring.after} 天`;
  else if (balance) detail = `预计剩余 ${moneyText(balance.before)} → ${moneyText(balance.after)}`;
  else if (types.has("expiry_changed")) detail = `到期日变更为 ${credit.endDate.slice(0, 10) || "无"}`;
  return `> **${account.groupName} · ${account.name}**\n> ${credit.description}\n> ${detail}`;
}

async function notify(changes) {
  if (!changes.length) return { sent: false, reason: "no_changes" };
  const webhookUrl = await loadWebhookUrl();
  if (!webhookUrl) return { sent: false, reason: "not_configured" };
  const webhook = new URL(webhookUrl);
  if (webhook.protocol !== "https:" || webhook.hostname !== "qyapi.weixin.qq.com" || webhook.pathname !== "/cgi-bin/webhook/send" || !webhook.searchParams.get("key")) throw new Error("企业微信机器人地址不正确");
  const lines = changes.slice(0, 20).map(changeText);
  if (changes.length > lines.length) lines.push(`> 另有 ${changes.length - lines.length} 项变化，请在 NEXUS 查看`);
  const checkedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const content = [`**【代金券监控】发现 ${changes.length} 项变化**`, ...lines, `检查时间：${checkedAt}`].join("\n\n");
  const response = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msgtype: "markdown", markdown: { content } }), signal: AbortSignal.timeout(8000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.errcode) !== 0) throw new Error(payload?.errmsg || `企业微信通知失败：HTTP ${response.status}`);
  return { sent: true };
}

export async function refreshCreditMonitor(accountId = "") {
  const allAccounts = await listCreditMonitorAccounts();
  const accounts = accountId ? allAccounts.filter((item) => item.accountId === accountId) : allAccounts;
  if (accountId && !accounts.length) throw new Error("该账号不在代金券监控范围内");
  const results = await mapLimited(accounts, 4, async (account) => {
    try { return { ok: true, result: await refreshAccount(account) }; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await saveFailure(account, message).catch((persistError) => console.error("Credit monitor failure status persistence failed", persistError));
      return { ok: false, account, error: message };
    }
  });
  const successful = results.filter((item) => item.ok).map((item) => item.result);
  const errors = results.filter((item) => !item.ok).map((item) => ({ accountId: item.account.accountId, name: item.account.name, error: item.error }));
  const changes = successful.flatMap((item) => item.changes);
  let notification = { sent: false, reason: "no_changes" };
  try { notification = await notify(changes); }
  catch (error) {
    notification = { sent: false, reason: error instanceof Error ? error.message : String(error) };
    console.error("Credit monitor WeCom notification failed", error);
  }
  return {
    ok: errors.length === 0,
    accounts: successful.length,
    credits: successful.reduce((sum, item) => sum + item.credits.length, 0),
    changes: changes.length,
    baselines: successful.filter((item) => item.baselineCreated).length,
    errors,
    notification,
  };
}

function publicCredit(item) {
  return { accountId: item.accountId, accountName: item.accountName, architecture: item.architecture, ...parseJson(item.stateJson) };
}

export async function getCreditMonitorData() {
  const accounts = await listCreditMonitorAccounts();
  const partitions = await mapLimited(accounts, 6, async (account) => ({ account, items: await queryPartition(account.accountId) }));
  const credits = [];
  const history = [];
  const accountStates = [];
  for (const { account, items } of partitions) {
    const meta = items.find((item) => item.sk === "META");
    credits.push(...items.filter((item) => item.sk.startsWith("CREDIT#")).map(publicCredit));
    history.push(...items.filter((item) => item.sk.startsWith("HISTORY#")).map((item) => ({
      accountId: item.accountId,
      accountName: item.accountName,
      architecture: item.architecture,
      creditId: item.creditId,
      description: item.description,
      changes: parseJson(item.changesJson, []),
      observedAt: item.observedAt,
    })));
    accountStates.push({
      ...account,
      lastRunAt: meta?.lastRunAt || "",
      status: meta?.status || "not_scanned",
      error: meta?.error || "",
      creditCount: Number(meta?.creditCount || 0),
      activeCreditCount: Number(meta?.activeCreditCount || 0),
    });
  }
  credits.sort((left, right) => left.accountName.localeCompare(right.accountName, "zh-CN") || left.state.localeCompare(right.state) || left.endDate.localeCompare(right.endDate));
  history.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  return { accounts: accountStates, credits, history: history.slice(0, 200) };
}

export function isCreditMonitorScheduledEvent(event) {
  return event?.source === "nexus.credit-monitor" || event?.["detail-type"] === "Credit Monitor";
}

export async function runScheduledCreditMonitor() {
  return refreshCreditMonitor();
}

export async function handleCreditMonitorRequest({ method, body }) {
  if (method === "GET") return getCreditMonitorData();
  if (method === "POST") return refreshCreditMonitor(String(body?.accountId || ""));
  throw new Error("不支持的请求方法");
}
