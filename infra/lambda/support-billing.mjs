import { BillingClient, ListBillingViewsCommand } from "@aws-sdk/client-billing";
import { BillingconductorClient, CreateCustomLineItemCommand, DeleteCustomLineItemCommand, ListAccountAssociationsCommand, ListBillingGroupsCommand, ListCustomLineItemsCommand, ListCustomLineItemVersionsCommand, UpdateCustomLineItemCommand } from "@aws-sdk/client-billingconductor";
import { CostExplorerClient, GetCostAndUsageCommand, GetDimensionValuesCommand } from "@aws-sdk/client-cost-explorer";
import { DynamoDBClient, GetItemCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { ListAccountsCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { gzipSync, gunzipSync } from "node:zlib";

const dynamodb = new DynamoDBClient({ maxAttempts: 6 });
const sts = new STSClient({ maxAttempts: 5 });
const accountsTable = process.env.ACCOUNTS_TABLE;
const groupsTable = process.env.GROUPS_TABLE;
const automationRole = "TontianOrganizationAutomationRole";
const pmaGroupNames = new Set(["PMA", "CMA组"]);
const targetGroupNames = new Set([...pmaGroupNames, "老代付组"]);
const prefix = "AWSBusinessSupportPlus_";
const tolerance = 0.01;
const supportWebhookUrl = process.env.WECOM_SUPPORT_WEBHOOK_URL || "";
const historyCachePrefix = "supportBillingHistory_";
const historyScans = new Map();

function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function parseJson(value, fallback) { try { return JSON.parse(value || ""); } catch { return fallback; } }
function cents(value) { return value === null || value === undefined ? null : Math.round(Number(value) * 100) / 100; }
function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function transientCostError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();
  return ["DataUnavailableException", "LimitExceededException", "ThrottlingException", "TooManyRequestsException"].includes(name)
    || message.includes("data is not available")
    || message.includes("too many requests")
    || message.includes("throttl");
}
async function sendCostRequest(client, command, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await client.send(command); }
    catch (error) {
      lastError = error;
      if (!transientCostError(error) || attempt === attempts - 1) throw error;
      await wait(750 * (attempt + 1));
    }
  }
  throw lastError;
}
function itemValue(item, name) { return item?.[name]?.S || ""; }
function canonicalGroupName(name) { return name === "CMA组" ? "PMA" : name; }
function supportsBilling(item, groupName) { return groupName === "老代付组" || (pmaGroupNames.has(groupName) && item.accountType?.S === "pma"); }

function zeroMappingCanPass(item) {
  return item?.status === "mapping_error" && item.aws !== null && Math.abs(Number(item.aws)) <= tolerance && (item.synced === null || item.synced === undefined || Math.abs(Number(item.synced)) <= tolerance);
}

function normalizeMappingStatuses(snapshot) {
  if (!Array.isArray(snapshot?.accounts)) return snapshot;
  for (const account of snapshot.accounts) {
    for (const key of ["current", "previous", "historical"]) {
      const item = account?.[key];
      if (!zeroMappingCanPass(item)) continue;
      item.status = "mapping_ignored";
      item.suggestion = "无费用，映射异常已忽略";
    }
  }
  return snapshot;
}

async function scanTable(TableName) {
  const items = []; let ExclusiveStartKey;
  do {
    const page = await dynamodb.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function listPayers() {
  const [groups, accounts] = await Promise.all([scanTable(groupsTable), scanTable(accountsTable)]);
  const targetGroups = new Map(groups.filter((item) => item.name?.S && targetGroupNames.has(item.name.S)).map((item) => [item.groupId.S, item.name.S]));
  return accounts.filter((item) => { const groupName = targetGroups.get(item.groupId?.S || ""); return groupName && supportsBilling(item, groupName); }).map((item) => payerFromItem(item, targetGroups.get(item.groupId?.S || ""))).sort((left, right) => left.groupName.localeCompare(right.groupName, "zh-CN") || left.remark.localeCompare(right.remark, "zh-CN"));
}

function payerFromItem(item, groupName) {
  const architecture = pmaGroupNames.has(groupName) ? "pma" : "legacy_payer";
  const autoSyncOverrides = normalizeAutoSyncOverrides(parseJson(itemValue(item, "supportBillingAutoSyncOverrides"), {}));
  const snapshot = decorateAutoSync({ architecture, autoSyncOverrides }, normalizeMappingStatuses(parseJson(itemValue(item, "supportBillingSnapshot"), null)));
  return {
    accountId: item.accountId.S,
    remark: item.remark?.S || item.name?.S || item.accountId.S,
    region: item.region?.S || "us-east-1",
    groupId: item.groupId?.S || "",
    groupName: canonicalGroupName(groupName),
    architecture,
    autoSyncOverrides,
    lastScanAt: itemValue(item, "supportBillingLastScanAt"),
    lastAutoSyncAt: itemValue(item, "supportBillingLastAutoSyncAt"),
    lastStatus: itemValue(item, "supportBillingLastStatus"),
    lastMessage: itemValue(item, "supportBillingLastMessage"),
    snapshot,
    historyCache: Object.fromEntries(Object.entries(item).filter(([name, value]) => /^supportBillingHistory_\d{6}$/.test(name) && value.B).map(([name, value]) => [name, value.B])),
    suppressions: new Set(parseJson(itemValue(item, "supportBillingSuppressions"), [])),
    accountCount: snapshot?.accounts?.length || 0,
    pendingCount: (snapshot?.accounts || []).filter((account) => ["create", "update", "period_range_error"].includes(account.current?.status)).length,
    blockedCount: (snapshot?.accounts || []).filter((account) => ["query_error", "zero_risk", "mapping_error", "duplicate_cli"].includes(account.current?.status)).length,
  };
}

function publicPayer(payer) {
  return { accountId: payer.accountId, remark: payer.remark, groupName: payer.groupName, architecture: payer.architecture, autoSyncOverrides: payer.autoSyncOverrides, lastScanAt: payer.lastScanAt, lastStatus: payer.lastStatus, lastMessage: payer.lastMessage, accountCount: payer.accountCount, pendingCount: payer.pendingCount, blockedCount: payer.blockedCount };
}

function normalizeAutoSyncOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([accountId, enabled]) => /^\d{12}$/.test(accountId) && typeof enabled === "boolean"));
}

function accountAutoSyncEnabled(payer, accountId) {
  return Object.hasOwn(payer.autoSyncOverrides || {}, accountId) ? payer.autoSyncOverrides[accountId] : payer.architecture === "pma";
}

function decorateAutoSync(payer, snapshot) {
  if (!snapshot?.accounts) return snapshot;
  for (const account of snapshot.accounts) account.autoSyncEnabled = accountAutoSyncEnabled(payer, account.id);
  return snapshot;
}

async function requirePayer(accountId) {
  if (!/^\d{12}$/.test(String(accountId || ""))) fail("代付账号 ID 不正确");
  const result = await dynamodb.send(new GetItemCommand({ TableName: accountsTable, Key: { accountId: { S: String(accountId) } }, ConsistentRead: true }));
  if (!result.Item) fail("代付账号不存在", 404);
  const groupId = result.Item.groupId?.S || "";
  const group = groupId ? await dynamodb.send(new GetItemCommand({ TableName: groupsTable, Key: { groupId: { S: groupId } }, ConsistentRead: true })) : {};
  const groupName = group.Item?.name?.S || "";
  if (!targetGroupNames.has(groupName) || !supportsBilling(result.Item, groupName)) fail("只有 PMA账号和老代付账号支持 Support 对账");
  return payerFromItem(result.Item, groupName);
}

async function clientsFor(payer) {
  const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${payer.accountId}:role/${automationRole}`, RoleSessionName: `nexus-support-${Date.now()}`, DurationSeconds: 900 }));
  const value = assumed.Credentials;
  if (!value?.AccessKeyId || !value.SecretAccessKey || !value.SessionToken) fail("无法获取代付账号临时权限");
  const credentials = { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken };
  return {
    billing: new BillingClient({ region: "us-east-1", credentials, maxAttempts: 5 }),
    conductor: new BillingconductorClient({ region: "us-east-1", credentials, maxAttempts: 5 }),
    cost: new CostExplorerClient({ region: "us-east-1", credentials, maxAttempts: 5 }),
    organizations: new OrganizationsClient({ region: "us-east-1", credentials, maxAttempts: 5 }),
  };
}

function chinaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(value.year), month: Number(value.month), day: Number(value.day) };
}
function dateString(date) { return date.toISOString().slice(0, 10); }
function monthString(date) { return date.toISOString().slice(0, 7); }
function monthAfter(period) { const [year, month] = period.split("-").map(Number); return monthString(new Date(Date.UTC(year, month, 1))); }
function billingRange(period) { return { InclusiveStartBillingPeriod: period, ExclusiveEndBillingPeriod: monthAfter(period) }; }
function periodDefinitions(selected = ["current", "previous"]) {
  const now = chinaDateParts();
  const today = new Date(Date.UTC(now.year, now.month - 1, now.day));
  const currentStart = new Date(Date.UTC(now.year, now.month - 1, 1));
  const previousStart = new Date(Date.UTC(now.year, now.month - 2, 1));
  const currentEnd = now.day === 1 ? new Date(today.getTime() + 86400000) : today;
  const values = [
    { key: "current", billingPeriod: monthString(currentStart), start: dateString(currentStart), end: dateString(currentEnd) },
    { key: "previous", billingPeriod: monthString(previousStart), start: dateString(previousStart), end: dateString(currentStart) },
  ];
  return values.filter((item) => selected.includes(item.key));
}

function historicalPeriods() {
  const now = chinaDateParts();
  return Array.from({ length: 5 }, (_, index) => {
    const start = new Date(Date.UTC(now.year, now.month - 3 - index, 1));
    const end = new Date(Date.UTC(now.year, now.month - 2 - index, 1));
    return { key: "historical", billingPeriod: monthString(start), start: dateString(start), end: dateString(end) };
  });
}

function requestedPeriod(value = "current") {
  if (value === "current" || value === "previous") return value;
  if (historicalPeriods().some((period) => period.billingPeriod === value)) return value;
  fail("账期不正确，请选择本月或过去6个月");
}

function historicalCacheName(month) { return `${historyCachePrefix}${month.replace("-", "")}`; }

function readHistoricalSnapshot(payer, month) {
  const data = payer.historyCache?.[historicalCacheName(month)];
  if (!data) return null;
  try {
    const snapshot = JSON.parse(gunzipSync(data, { maxOutputLength: 4_000_000 }).toString("utf8"));
    return snapshot?.historyMonth === month && Array.isArray(snapshot.accounts) ? decorateAutoSync(payer, normalizeMappingStatuses(snapshot)) : null;
  } catch { return null; }
}

async function saveHistoricalSnapshot(payer, snapshot) {
  const name = historicalCacheName(snapshot.historyMonth);
  const compressed = gzipSync(JSON.stringify(snapshot));
  // Five bounded history entries leave room for the existing 350 KB live snapshot.
  if (compressed.byteLength > 8000) {
    console.warn("Support history snapshot exceeds database cache budget", payer.accountId, snapshot.historyMonth);
    return;
  }
  const retained = new Set(historicalPeriods().map((period) => historicalCacheName(period.billingPeriod)));
  const expired = Object.keys(payer.historyCache || {}).filter((key) => !retained.has(key));
  const names = { "#history": name };
  const remove = expired.map((key, index) => { names[`#old${index}`] = key; return `#old${index}`; });
  await dynamodb.send(new UpdateItemCommand({
    TableName: accountsTable,
    Key: { accountId: { S: payer.accountId } },
    ConditionExpression: "attribute_exists(accountId)",
    UpdateExpression: `SET #history=:history${remove.length ? ` REMOVE ${remove.join(", ")}` : ""}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ":history": { B: compressed } },
  }));
  payer.historyCache = { ...payer.historyCache, [name]: compressed };
}

async function scanHistoricalAction(payer, month, persist = saveHistoricalSnapshot) {
  const definition = historicalPeriods().find((period) => period.billingPeriod === month);
  if (!definition) fail("该月份不在可查询的过去6个月内");
  const key = `${payer.accountId}:${payer.architecture}:${month}`;
  if (historyScans.has(key)) return historyScans.get(key);
  const task = Promise.resolve().then(async () => {
    const clients = await clientsFor(payer);
    const result = payer.architecture === "pma" ? await scanPma(payer, clients, [definition]) : await scanLegacy(payer, clients, [definition]);
    for (const account of result.accounts) {
      account.current = blankPeriod();
      account.previous = blankPeriod();
      const item = account.historical;
      if (payer.suppressions.has(`${account.id}:${month}`) && !item.customLineItemArn) {
        item.status = "manual_deleted";
        item.suggestion = "该账期已人工删除";
      }
    }
    const snapshot = { lastScanAt: new Date().toISOString(), months: Object.fromEntries(periodDefinitions().map((period) => [period.key, period.billingPeriod])), historyMonth: month, accounts: result.accounts, diagnostics: result.diagnostics };
    await persist(payer, snapshot);
    return snapshot;
  }).finally(() => historyScans.delete(key));
  historyScans.set(key, task);
  return task;
}

async function listBillingViews(client, period) {
  const result = []; let nextToken;
  const activeTimeRange = {
    activeAfterInclusive: new Date(`${period.start}T00:00:00.000Z`),
    activeBeforeInclusive: new Date(Date.parse(`${period.end}T00:00:00.000Z`) - 1),
  };
  do { const page = await client.send(new ListBillingViewsCommand({ activeTimeRange, billingViewTypes: ["BILLING_TRANSFER"], maxResults: 100, nextToken })); result.push(...(page.billingViews || [])); nextToken = page.nextToken; } while (nextToken);
  return result;
}
async function listBillingGroups(client, billingPeriod) {
  const result = []; let NextToken;
  do { const page = await client.send(new ListBillingGroupsCommand({ BillingPeriod: billingPeriod, MaxResults: 100, NextToken })); result.push(...(page.BillingGroups || [])); NextToken = page.NextToken; } while (NextToken);
  return result;
}
async function listCustomLineItems(client, billingPeriod) {
  const result = []; let NextToken;
  do { const page = await client.send(new ListCustomLineItemsCommand({ BillingPeriod: billingPeriod, MaxResults: 100, NextToken })); result.push(...(page.CustomLineItems || [])); NextToken = page.NextToken; } while (NextToken);
  return result;
}
async function listAssociations(client, billingPeriod) {
  const result = []; let NextToken;
  do { const page = await client.send(new ListAccountAssociationsCommand({ BillingPeriod: billingPeriod, MaxResults: 100, NextToken })); result.push(...(page.LinkedAccounts || [])); NextToken = page.NextToken; } while (NextToken);
  return result;
}
async function listOrganizationAccounts(client) {
  const result = []; let NextToken;
  do { const page = await client.send(new ListAccountsCommand({ NextToken })); result.push(...(page.Accounts || [])); NextToken = page.NextToken; } while (NextToken);
  return result;
}

async function costPeriod(client, period, view = null, includeAccounts = true) {
  const result = { sourceAccountId: view?.sourceAccountId || null, viewName: view?.name || null, period: period.key, accounts: {}, support: {}, error: null };
  const viewInput = view ? { BillingViewArn: view.arn } : {};
  try {
    if (includeAccounts) {
      let NextPageToken;
      do {
        const page = await sendCostRequest(client, new GetDimensionValuesCommand({ TimePeriod: { Start: period.start, End: period.end }, Dimension: "LINKED_ACCOUNT", ...viewInput, NextPageToken }));
        for (const item of page.DimensionValues || []) result.accounts[item.Value] = item.Attributes?.description || item.Value;
        NextPageToken = page.NextPageToken;
      } while (NextPageToken);
    }
    let NextPageToken;
    do {
      const page = await sendCostRequest(client, new GetCostAndUsageCommand({ TimePeriod: { Start: period.start, End: period.end }, Granularity: "MONTHLY", Metrics: ["UnblendedCost"], Filter: { Dimensions: { Key: "RECORD_TYPE", Values: ["Support"] } }, GroupBy: [{ Type: "DIMENSION", Key: "LINKED_ACCOUNT" }], ...viewInput, NextPageToken }));
      for (const block of page.ResultsByTime || []) for (const group of block.Groups || []) { const accountId = group.Keys?.[0]; if (!accountId) continue; result.support[accountId] = (result.support[accountId] || 0) + Number(group.Metrics?.UnblendedCost?.Amount || 0); result.accounts[accountId] ||= accountId; }
      NextPageToken = page.NextPageToken;
    } while (NextPageToken);
  } catch (error) { result.error = `${error?.name || "Error"}: ${error?.message || error}`; }
  return result;
}

function canonicalPeriod(item, accountId) {
  const match = String(item.Name || "").match(new RegExp(`^${prefix}${accountId}_(\\d{6})$`));
  if (!match) return null;
  const year = Number(match[1].slice(0, 4)); const month = Number(match[1].slice(4));
  return year >= 2000 && month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}` : null;
}
function managedCli(item, accountId) { return canonicalPeriod(item, accountId) !== null && item.AccountId === accountId && item.ChargeDetails?.Type === "FEE"; }
function cliCandidate(item, accountId, period) { const name = String(item.Name || ""); const yyyymm = period.replace("-", ""); return item.AccountId === accountId && (name === `${prefix}${accountId}_${yyyymm}` || (name.toLowerCase().includes("support") && name.includes(yyyymm) && item.ChargeDetails?.Type === "FEE")); }
function cliAmount(item) { const value = item.ChargeDetails?.Flat?.ChargeValue; return value === undefined || value === null ? null : Number(value); }
function status(aws, synced, queryError, mappingError, duplicate) {
  if (queryError) return ["query_error", "AWS 查询异常"];
  if (duplicate) return ["duplicate_cli", "发现重复 Support 账单项"];
  if (mappingError && aws !== null && Math.abs(Number(aws)) <= tolerance && (synced === null || Math.abs(Number(synced)) <= tolerance)) return ["mapping_ignored", "无费用，映射异常已忽略"];
  if (mappingError) return ["mapping_error", "账单组映射不明确"];
  if (aws === 0 && synced !== null && synced !== 0) return ["zero_risk", "疑似清零，已停止写入"];
  if (synced === null) return aws === 0 ? ["normal", "无 Support 费用"] : ["create", "建议创建"];
  if (Math.abs(aws - synced) <= tolerance) return ["normal", "金额一致"];
  return ["update", "建议更新"];
}
function periodItem(accountId, aws, candidates, activeItems, period, queryError, mappingError, groupArn, member) {
  const activeManaged = activeItems.filter((item) => managedCli(item, accountId));
  const chargedManaged = activeManaged.filter((item) => Math.abs(cliAmount(item) || 0) > tolerance);
  const carryovers = chargedManaged.filter((item) => canonicalPeriod(item, accountId) !== period);
  const duplicate = candidates.length > 1 || chargedManaged.length > 1;
  const visible = [...new Map([...activeManaged, ...candidates].map((item) => [item.Arn || item.Name, item])).values()];
  const values = visible.map(cliAmount);
  const synced = visible.length && values.every((value) => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
  let state; let suggestion;
  if (!member && !queryError && !mappingError) [state, suggestion] = ["native_visible", "未加入 Billing Group，无需同步"];
  else if (carryovers.length) [state, suggestion] = ["period_range_error", "历史账单项跨月，需先修正周期"];
  else [state, suggestion] = status(aws, synced, queryError, mappingError, duplicate);
  const exact = candidates.length === 1 && !duplicate && !carryovers.length ? candidates[0] : null;
  return { aws: cents(aws), synced: cents(synced), status: state, suggestion, billingGroupMember: member, billingGroupArn: groupArn, customLineItemArn: exact?.Arn || null, customLineItemName: exact?.Name || null, managedCustomLineItems: activeManaged.map((item) => ({ arn: item.Arn, name: item.Name, accountId: item.AccountId, chargeValue: cents(cliAmount(item)), originalPeriod: canonicalPeriod(item, accountId), activePeriod: period })) };
}
function accountShell(id, name, payer) { return { id, name, cma: "未识别 CMA", sourceAccountId: payer.accountId, architecture: payer.architecture, autoSyncEnabled: accountAutoSyncEnabled(payer, id), current: null, previous: null, history: [] }; }

async function conductorData(clients, periods) {
  const groups = {}; const items = {};
  await Promise.all(periods.map(async (period) => { [groups[period.key], items[period.key]] = await Promise.all([listBillingGroups(clients.conductor, period.billingPeriod), listCustomLineItems(clients.conductor, period.billingPeriod)]); }));
  return { groups, items };
}

async function scanPma(payer, clients, periods) {
  const viewsByPeriod = Object.fromEntries(await Promise.all(periods.map(async (period) => [period.key, await listBillingViews(clients.billing, period)])));
  const views = [...new Map(Object.values(viewsByPeriod).flat().map((view) => [view.arn, view])).values()];
  const healthyByPeriod = Object.fromEntries(periods.map((period) => [period.key, (viewsByPeriod[period.key] || []).filter((view) => view.healthStatus?.statusCode === "HEALTHY")]));
  const healthy = [...new Map(Object.values(healthyByPeriod).flat().map((view) => [view.arn, view])).values()];
  const { groups, items } = await conductorData(clients, periods);
  const results = await Promise.all(periods.flatMap((period) => healthyByPeriod[period.key].map((view) => costPeriod(clients.cost, period, view, true))));
  const viewWarnings = [...new Map(results.filter((result) => result.error).map((result) => [`${result.period}:${result.sourceAccountId}`, { period: result.period, sourceAccountId: result.sourceAccountId, viewName: result.viewName, error: result.error }])).values()];
  const usableResults = results.filter((result) => !result.error);
  const accountIds = new Set(usableResults.flatMap((result) => [...Object.keys(result.accounts), ...Object.keys(result.support)]));
  for (const values of Object.values(items)) for (const item of values) if (item.AccountId) accountIds.add(item.AccountId);
  const accounts = [];
  for (const accountId of [...accountIds].sort()) {
    const inferred = usableResults.filter((result) => result.accounts[accountId] || Object.hasOwn(result.support, accountId));
    const sourceIds = [...new Set(inferred.map((result) => result.sourceAccountId).filter(Boolean))].sort();
    const name = inferred.map((result) => result.accounts[accountId]).find(Boolean) || accountId;
    const account = accountShell(accountId, name, payer);
    for (const period of periods) {
      const periodViews = healthyByPeriod[period.key] || [];
      const direct = usableResults.filter((result) => result.period === period.key && (result.accounts[accountId] || Object.hasOwn(result.support, accountId)));
      const ids = [...new Set(direct.map((result) => result.sourceAccountId).filter(Boolean))].sort();
      const relevantIds = ids.length ? ids : sourceIds;
      const relevant = usableResults.filter((result) => result.period === period.key && relevantIds.includes(result.sourceAccountId));
      const matches = groups[period.key].filter((group) => relevantIds.includes(group.PrimaryAccountId));
      const mappingError = relevantIds.length !== 1 || matches.length !== 1 || relevantIds.some((id) => periodViews.filter((view) => view.sourceAccountId === id).length !== 1);
      const group = matches.length === 1 ? matches[0] : null;
      if (period.key === "current" || account.cma === "未识别 CMA") account.cma = group?.Name || group?.PrimaryAccountId || (relevantIds.length === 1 ? `CMA ${relevantIds[0]}` : "未识别 CMA");
      const failed = relevant.length === 0;
      if (failed) {
        for (const sourceAccountId of relevantIds) viewWarnings.push({ period: period.key, sourceAccountId, viewName: `CMA ${sourceAccountId}`, error: "当前账期没有可用账单视图" });
      }
      const aws = failed ? null : relevant.reduce((sum, result) => sum + Number(result.support[accountId] || 0), 0);
      const candidates = items[period.key].filter((item) => cliCandidate(item, accountId, period.billingPeriod));
      account[period.key] = periodItem(accountId, aws, candidates, items[period.key], period.billingPeriod, failed, mappingError, group?.Arn || null, true);
    }
    accounts.push(account);
  }
  return { accounts, diagnostics: { billingViews: views.length, healthyBillingViews: healthy.length, viewWarnings: [...new Map(viewWarnings.map((warning) => [`${warning.period}:${warning.sourceAccountId}`, warning])).values()] } };
}

async function scanLegacy(payer, clients, periods) {
  const { groups, items } = await conductorData(clients, periods);
  const associations = {};
  await Promise.all(periods.map(async (period) => { associations[period.key] = await listAssociations(clients.conductor, period.billingPeriod); }));
  const names = {};
  try { for (const item of await listOrganizationAccounts(clients.organizations)) if (item.Id) names[item.Id] = item.Name || item.Id; } catch {}
  const costs = {};
  await Promise.all(periods.map(async (period) => { costs[period.key] = await costPeriod(clients.cost, period, null, Object.keys(names).length === 0); }));
  const viewWarnings = Object.values(costs).filter((result) => result.error).map((result) => ({ period: result.period, sourceAccountId: payer.accountId, viewName: payer.remark, error: result.error }));
  const accountIds = new Set([...Object.keys(names), payer.accountId]);
  for (const result of Object.values(costs)) { Object.keys(result.accounts).forEach((id) => accountIds.add(id)); Object.keys(result.support).forEach((id) => accountIds.add(id)); }
  for (const values of Object.values(associations)) for (const item of values) if (item.AccountId) accountIds.add(item.AccountId);
  const accounts = [];
  for (const accountId of [...accountIds].sort()) {
    const name = names[accountId] || Object.values(costs).map((result) => result.accounts[accountId]).find(Boolean) || accountId;
    const account = accountShell(accountId, name, payer); account.cma = payer.remark;
    for (const period of periods) {
      const matches = associations[period.key].filter((item) => item.AccountId === accountId);
      const primary = groups[period.key].filter((group) => group.PrimaryAccountId === accountId);
      const arns = new Set([...matches.map((item) => item.BillingGroupArn), ...primary.map((group) => group.Arn)].filter(Boolean));
      const member = arns.size > 0;
      const mappingError = arns.size > 1 || [...arns].some((arn) => !groups[period.key].some((group) => group.Arn === arn));
      const result = costs[period.key];
      const aws = result.error ? null : Number(result.support[accountId] || 0);
      const candidates = items[period.key].filter((item) => cliCandidate(item, accountId, period.billingPeriod));
      account[period.key] = periodItem(accountId, aws, candidates, items[period.key], period.billingPeriod, Boolean(result.error), mappingError, arns.size === 1 ? [...arns][0] : null, member);
    }
    accounts.push(account);
  }
  return { accounts, diagnostics: { organizationAccounts: Object.keys(names).length, billingGroups: Object.fromEntries(periods.map((period) => [period.key, groups[period.key].length])), viewWarnings } };
}

function blankPeriod() { return { aws: null, synced: null, status: "query_error", suggestion: "尚未扫描", billingGroupMember: false, billingGroupArn: null, customLineItemArn: null, customLineItemName: null, managedCustomLineItems: [] }; }
async function scanWithClients(payer, clients, selected = ["current", "previous"], previous = payer.snapshot) {
  const periods = periodDefinitions(selected);
  const result = payer.architecture === "pma" ? await scanPma(payer, clients, periods) : await scanLegacy(payer, clients, periods);
  const old = new Map((previous?.accounts || []).map((account) => [account.id, account]));
  const warnings = result.diagnostics?.viewWarnings || [];
  const affectedByWarning = (account) => warnings.some((warning) => warning.sourceAccountId && (account?.sourceAccountId === warning.sourceAccountId || String(account?.cma || "").includes(warning.sourceAccountId)));
  const pendingPeriod = (item) => ({ ...(item || blankPeriod()), status: "data_pending", suggestion: "AWS 账单数据待更新" });
  for (const account of result.accounts) {
    const prior = old.get(account.id);
    account.history = prior?.history || [];
    if (affectedByWarning(account) || affectedByWarning(prior)) {
      for (const period of periods) {
        if (account[period.key]?.status !== "query_error") continue;
        const priorPeriod = prior?.[period.key];
        account[period.key] = priorPeriod && !["query_error", "data_pending"].includes(priorPeriod.status) ? priorPeriod : pendingPeriod(account[period.key]);
      }
    }
    for (const key of ["current", "previous"]) if (!account[key]) account[key] = prior?.[key] || blankPeriod();
    for (const period of periodDefinitions()) {
      const item = account[period.key];
      if (payer.suppressions.has(`${account.id}:${period.billingPeriod}`) && !item.customLineItemArn) { item.status = "manual_deleted"; item.suggestion = "已人工删除，本月不自动重建"; }
    }
  }
  const scannedIds = new Set(result.accounts.map((account) => account.id));
  if (warnings.length) {
    for (const prior of previous?.accounts || []) {
      if (scannedIds.has(prior.id) || !affectedByWarning(prior)) continue;
      const carried = { ...prior, history: prior.history || [] };
      for (const period of periods) if (carried[period.key]?.status === "query_error") carried[period.key] = pendingPeriod(carried[period.key]);
      result.accounts.push(carried);
    }
    result.accounts.sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)));
  }
  const definitions = periodDefinitions();
  return { lastScanAt: new Date().toISOString(), months: Object.fromEntries(definitions.map((item) => [item.key, item.billingPeriod])), accounts: result.accounts, diagnostics: result.diagnostics };
}

async function saveSnapshot(payer, snapshot, status, message, automatic = false) {
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > 350000) fail("扫描结果过大，已停止保存，请拆分账单主体");
  const values = { ":snapshot": { S: serialized }, ":scan": { S: snapshot.lastScanAt }, ":status": { S: status }, ":message": { S: String(message || "").slice(0, 500) }, ":suppressions": { S: JSON.stringify([...payer.suppressions]) } };
  let expression = "SET supportBillingSnapshot=:snapshot, supportBillingLastScanAt=:scan, supportBillingLastStatus=:status, supportBillingLastMessage=:message, supportBillingSuppressions=:suppressions";
  if (automatic) { expression += ", supportBillingLastAutoSyncAt=:automatic"; values[":automatic"] = { S: new Date().toISOString() }; }
  await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: payer.accountId } }, UpdateExpression: expression, ExpressionAttributeValues: values }));
  payer.snapshot = snapshot; payer.lastScanAt = snapshot.lastScanAt;
  return snapshot;
}

async function saveAutoSyncPreference(payer) {
  await dynamodb.send(new UpdateItemCommand({
    TableName: accountsTable,
    Key: { accountId: { S: payer.accountId } },
    ConditionExpression: "attribute_exists(accountId)",
    UpdateExpression: "SET supportBillingAutoSyncOverrides=:overrides",
    ExpressionAttributeValues: { ":overrides": { S: JSON.stringify(payer.autoSyncOverrides) } },
  }));
}

async function setAutoSyncAction(payer, targetAccountId, enabled, persist = saveAutoSyncPreference) {
  const accountId = String(targetAccountId || "");
  if (!/^\d{12}$/.test(accountId)) fail("成员账号 ID 不正确");
  if (typeof enabled !== "boolean") fail("自动同步开关状态不正确");
  payer.autoSyncOverrides = { ...(payer.autoSyncOverrides || {}), [accountId]: enabled };
  decorateAutoSync(payer, payer.snapshot);
  await persist(payer);
  return { payer: publicPayer(payer), snapshot: payer.snapshot };
}

async function markFailure(payer, message) {
  await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: payer.accountId } }, UpdateExpression: "SET supportBillingLastStatus=:status, supportBillingLastMessage=:message", ExpressionAttributeValues: { ":status": { S: "failed" }, ":message": { S: String(message || "").slice(0, 500) } } }));
}

function normalizeTargets(targets) { return new Set((Array.isArray(targets) ? targets : []).map(String).filter((value) => /^\d{12}$/.test(value)).slice(0, 500)); }
function addHistory(account, action, amount) { account.history = [{ date: new Date().toISOString(), action, amount: moneyString(amount) }, ...(account.history || [])].slice(0, 10); }
function moneyString(value) { return value === null || value === undefined ? "—" : `$${cents(value).toFixed(2)}`; }

async function listVersions(client, arn) {
  const result = []; let NextToken;
  do { const page = await client.send(new ListCustomLineItemVersionsCommand({ Arn: arn, MaxResults: 100, NextToken })); result.push(...(page.CustomLineItemVersions || [])); NextToken = page.NextToken; } while (NextToken);
  return result;
}

async function repairRanges(clients, snapshot, periodKey, targets) {
  let failed = 0; const seen = new Set(); const requested = [];
  for (const account of snapshot.accounts) {
    if (targets && !targets.has(account.id)) continue;
    const item = account[periodKey];
    if (item.status !== "period_range_error") continue;
    for (const managed of item.managedCustomLineItems || []) {
      if (!managed.arn || !managed.originalPeriod || managed.originalPeriod === managed.activePeriod || Math.abs(managed.chargeValue || 0) <= tolerance || seen.has(managed.arn)) continue;
      seen.add(managed.arn);
      const expectedName = `${prefix}${account.id}_${managed.originalPeriod.replace("-", "")}`;
      if (managed.name !== expectedName || managed.accountId !== account.id || !/^arn:aws[a-z-]*:billingconductor::\d{12}:customlineitem\/[A-Za-z0-9]+$/.test(managed.arn)) { failed += 1; continue; }
      try {
        const versions = await listVersions(clients.conductor, managed.arn);
        const valid = versions.some((version) => version.AccountId === account.id && version.Name === expectedName && version.StartBillingPeriod === managed.originalPeriod && (!version.EndBillingPeriod || version.EndBillingPeriod > managed.activePeriod));
        if (!valid) {
          failed += 1;
          item.status = "period_range_error";
          item.suggestion = "周期修正失败：账单项版本校验未通过";
          continue;
        }
      await clients.conductor.send(new DeleteCustomLineItemCommand({
        Arn: managed.arn,
        BillingPeriodRange: {
          InclusiveStartBillingPeriod: managed.activePeriod,
        },
      }));
        requested.push({ arn: managed.arn, accountId: account.id, activePeriod: managed.activePeriod, item });
      } catch (error) {
        failed += 1;
        item.status = "period_range_error";
        item.suggestion = `周期修正失败：${String(error?.message || error).slice(0, 180)}`;
      }
    }
  }
  if (!requested.length) return { repaired: 0, failed };
  const unresolved = await waitForRemovedCarryovers(clients.conductor, requested);
  for (const repair of requested) {
    if (!unresolved.has(repair.arn)) continue;
    failed += 1;
    repair.item.status = "period_range_error";
    repair.item.suggestion = "周期修正待确认：AWS 已接收删除，但旧费用暂未移除";
  }
  return { repaired: requested.length - unresolved.size, failed };
}

async function waitForRemovedCarryovers(client, repairs) {
  let unresolved = new Set(repairs.map((item) => item.arn));
  const periods = [...new Set(repairs.map((item) => item.activePeriod))];
  for (let attempt = 0; attempt < 5 && unresolved.size; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
    try {
      const items = (await Promise.all(periods.map((period) => listCustomLineItems(client, period)))).flat();
      const byArn = new Map(items.map((item) => [item.Arn, item]));
      unresolved = new Set([...unresolved].filter((arn) => {
        const item = byArn.get(arn);
        return item && Math.abs(cliAmount(item) || 0) > tolerance;
      }));
    } catch {
      // A transient verification failure is retried; unresolved items fail closed.
    }
  }
  return unresolved;
}

async function writeSync(payer, clients, snapshot, periodKey, targets, automatic = false, repaired = 0, repairFailed = 0, persist = saveSnapshot) {
  const period = snapshot.months[periodKey];
  const summary = { created: 0, updated: 0, repaired, deleted: 0, failed: repairFailed, skipped: 0, syncedAmount: 0 };
  for (const account of snapshot.accounts) {
    if (targets && !targets.has(account.id)) continue;
    const item = account[periodKey];
    if (!["create", "update"].includes(item.status) || item.aws === null || item.aws <= 0 || item.billingGroupMember === false || !item.billingGroupArn || (item.status === "update" && !item.customLineItemArn)) { summary.skipped += 1; continue; }
    const amount = cents(item.aws); const name = `${prefix}${account.id}_${period.replace("-", "")}`; const description = `AWS Business Support+ fee (${period})`;
    const action = item.status;
    try {
      if (item.status === "create") {
        const response = await clients.conductor.send(new CreateCustomLineItemCommand({ ClientToken: `nexus-support-${payer.accountId}-${account.id}-${period.replace("-", "")}`, Name: name, Description: description, BillingGroupArn: item.billingGroupArn, BillingPeriodRange: billingRange(period), ChargeDetails: { Flat: { ChargeValue: amount }, Type: "FEE" }, AccountId: account.id, ComputationRule: "CONSOLIDATED" }));
        item.customLineItemArn = response.Arn; summary.created += 1;
      } else {
        try {
          await clients.conductor.send(new UpdateCustomLineItemCommand({
            Arn: item.customLineItemArn,
            Name: name,
            Description: description,
            ChargeDetails: { Flat: { ChargeValue: amount } },
            ...(periodKey === "previous" ? { BillingPeriodRange: { InclusiveStartBillingPeriod: period } } : {}),
          }));
        } catch (error) {
          if (!/invalid custom line item billing period range/i.test(String(error?.message || error))) throw error;
          const staleArn = item.customLineItemArn;
          const versions = await listVersions(clients.conductor, staleArn);
          const valid = versions.some((version) => version.AccountId === account.id && version.Name === name && version.StartBillingPeriod === period);
          if (!valid) throw new Error("账单项安全校验未通过，未执行重建");
          await clients.conductor.send(new DeleteCustomLineItemCommand({
            Arn: staleArn,
            ...(periodKey === "previous" ? { BillingPeriodRange: { InclusiveStartBillingPeriod: period } } : {}),
          }));
          const unresolved = await waitForRemovedCarryovers(clients.conductor, [{ arn: staleArn, activePeriod: period }]);
          if (unresolved.has(staleArn)) throw new Error("AWS 已接收删除，但异常账单项暂未移除");
          const response = await clients.conductor.send(new CreateCustomLineItemCommand({
            ClientToken: `nexus-repair-${payer.accountId}-${account.id}-${period.replace("-", "")}-${staleArn.split("/").pop()}`.slice(0, 64),
            Name: name,
            Description: description,
            BillingGroupArn: item.billingGroupArn,
            BillingPeriodRange: billingRange(period),
            ChargeDetails: { Flat: { ChargeValue: amount }, Type: "FEE" },
            AccountId: account.id,
            ComputationRule: "CONSOLIDATED",
          }));
          item.customLineItemArn = response.Arn;
          summary.repaired += 1;
        }
        summary.updated += 1;
      }
      summary.syncedAmount = cents(summary.syncedAmount + amount);
      item.customLineItemName = name; item.synced = amount; item.status = "normal"; item.suggestion = "金额一致"; addHistory(account, automatic ? "自动同步" : action === "create" ? "创建" : "更新", amount);
    } catch (error) { summary.failed += 1; item.status = "query_error"; item.suggestion = `同步失败：${error?.message || error}`; }
  }
  const warningCount = new Set((snapshot.diagnostics?.viewWarnings || []).map((warning) => warning.sourceAccountId || warning.viewName)).size;
  const message = `创建 ${summary.created}，更新 ${summary.updated}，修正 ${summary.repaired}，失败 ${summary.failed}${warningCount ? `，${warningCount} 个账单视图数据待更新` : ""}`;
  await persist(payer, snapshot, summary.failed || warningCount ? "partial" : "success", message, automatic);
  return { summary, snapshot };
}

async function scanAction(payer, persist = saveSnapshot) {
  const clients = await clientsFor(payer);
  const snapshot = await scanWithClients(payer, clients);
  const warningCount = new Set((snapshot.diagnostics?.viewWarnings || []).map((warning) => warning.sourceAccountId || warning.viewName)).size;
  await persist(payer, snapshot, warningCount ? "partial" : "success", warningCount ? `${warningCount} 个账单视图数据待更新` : `扫描 ${snapshot.accounts.length} 个账号`);
  return snapshot;
}

function notificationText(value) {
  return String(value ?? "").replace(/[<>&`\r\n]/g, " ").trim().slice(0, 80);
}

function supportSyncNotificationContents(payer, snapshot, periodKey, targets, automatic, summary, beforeSync) {
  const accounts = snapshot.accounts.filter((account) => !targets || targets.has(account.id));
  const details = accounts.flatMap((account) => {
    const before = beforeSync.get(account.id);
    const after = account[periodKey];
    if (!before || (before.synced === after.synced && !["create", "update", "period_range_error"].includes(before.status))) return [];
    const previousAmount = before.synced === null ? "未创建" : moneyString(before.synced);
    const confirmedAmount = after.synced ?? (after.aws === 0 ? 0 : null);
    const nextAmount = after.status === "normal" && confirmedAmount !== null ? moneyString(confirmedAmount) : "未完成，结果待确认";
    return [`${notificationText(account.name)}（${account.id}）：${previousAmount} → ${nextAmount}`];
  });
  const changes = [
    summary.created ? `新增 ${summary.created}` : "",
    summary.updated ? `更新 ${summary.updated}` : "",
    summary.repaired ? `周期修正 ${summary.repaired}` : "",
  ].filter(Boolean);
  const completed = summary.created + summary.updated + summary.repaired;
  const outcome = summary.failed ? (completed ? "部分失败" : "失败") : "完成";
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const header = [
    `**Support+ 同步${outcome}**`,
    `${notificationText(payer.remark)}（${payer.accountId}）｜${notificationText(snapshot.months[periodKey])}`,
    [`账号 ${accounts.length}`, ...changes, `失败 ${summary.failed}`].join("｜"),
  ];
  const footer = `同步 ${moneyString(summary.syncedAmount ?? 0)}｜${automatic ? "自动" : "人工"}｜${time}${summary.failed ? "｜失败原因请在网页查看" : ""}`;
  const pages = []; let page = [];
  for (const detail of details) {
    if (page.length && (page.length >= 8 || Buffer.byteLength([...header, ...page, detail, footer].join("\n"), "utf8") > 3500)) {
      pages.push(page); page = [];
    }
    page.push(detail);
  }
  if (page.length || !pages.length) pages.push(page);
  return pages.map((lines, index) => [
    `${header[0]}${pages.length > 1 ? `（${index + 1}/${pages.length}）` : ""}`,
    ...header.slice(1), ...lines, footer,
  ].join("\n"));
}

async function sendSupportSyncNotification(payer, snapshot, periodKey, targets, automatic, summary, beforeSync) {
  if (!supportWebhookUrl) return;
  const webhook = new URL(supportWebhookUrl);
  if (webhook.protocol !== "https:" || webhook.hostname !== "qyapi.weixin.qq.com" || webhook.pathname !== "/cgi-bin/webhook/send") throw new Error("企业微信机器人地址不正确");
  const contents = supportSyncNotificationContents(payer, snapshot, periodKey, targets, automatic, summary, beforeSync);
  for (const [index, content] of contents.entries()) {
    if (index) await new Promise((resolve) => setTimeout(resolve, 3100));
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
      signal: AbortSignal.timeout(6000),
    });
    const payload = await response.json();
    if (!response.ok || payload?.errcode !== 0) throw new Error(payload?.errmsg || `企业微信通知失败：HTTP ${response.status}`);
  }
}

async function sendDailySupportSyncNotification(results) {
  if (!supportWebhookUrl) return;
  const webhook = new URL(supportWebhookUrl);
  if (webhook.protocol !== "https:" || webhook.hostname !== "qyapi.weixin.qq.com" || webhook.pathname !== "/cgi-bin/webhook/send") throw new Error("企业微信机器人地址不正确");
  const executed = results.filter((item) => !item.skipped);
  const payerFailures = results.filter((item) => item.error);
  const totals = executed.reduce((sum, item) => ({
    accounts: sum.accounts + Number(item.accounts || 0),
    created: sum.created + Number(item.created || 0),
    updated: sum.updated + Number(item.updated || 0),
    repaired: sum.repaired + Number(item.repaired || 0),
    failed: sum.failed + Number(item.failed || 0),
    syncedAmount: sum.syncedAmount + Number(item.syncedAmount || 0),
  }), { accounts: 0, created: 0, updated: 0, repaired: 0, failed: 0, syncedAmount: 0 });
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const failureLines = payerFailures.slice(0, 10).map((item) => `${notificationText(item.payerName || item.accountId)}（${item.accountId}）：${notificationText(item.error)}`);
  if (payerFailures.length > failureLines.length) failureLines.push(`另有 ${payerFailures.length - failureLines.length} 个代付账号失败，请在网页查看`);
  const content = [
    `**Support+ 每日同步汇总**`,
    `代付账号 ${results.length}｜执行 ${executed.length}｜跳过 ${results.length - executed.length}｜整组失败 ${payerFailures.length}`,
    `成员账号 ${totals.accounts}｜新增 ${totals.created}｜更新 ${totals.updated}｜周期修正 ${totals.repaired}｜处理失败 ${totals.failed}`,
    `同步 ${moneyString(totals.syncedAmount)}｜自动｜${time}`,
    ...failureLines,
  ].join("\n");
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
    signal: AbortSignal.timeout(6000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.errcode !== 0) throw new Error(payload?.errmsg || `企业微信通知失败：HTTP ${response.status}`);
}

async function syncAction(payer, periodKey, targets, automatic = false, persist = saveSnapshot, notify = true) {
  const clients = await clientsFor(payer);
  let snapshot = await scanWithClients(payer, clients, automatic ? ["current"] : ["current", "previous"]);
  const writeTargets = automatic ? new Set(snapshot.accounts.filter((account) => accountAutoSyncEnabled(payer, account.id)).map((account) => account.id)) : targets;
  const beforeSync = new Map(snapshot.accounts.filter((account) => !writeTargets || writeTargets.has(account.id)).map((account) => [account.id, { synced: account[periodKey].synced, status: account[periodKey].status }]));
  const repair = await repairRanges(clients, snapshot, periodKey, writeTargets);
  if (repair.repaired) snapshot = await scanWithClients(payer, clients, automatic ? ["current"] : ["current", "previous"], snapshot);
  const result = await writeSync(payer, clients, snapshot, periodKey, writeTargets, automatic, repair.repaired, repair.failed, persist);
  if (notify) {
    try { await sendSupportSyncNotification(payer, result.snapshot, periodKey, writeTargets, automatic, result.summary, beforeSync); }
    catch (error) { console.error("Support billing WeCom notification failed", error); }
  }
  return result;
}

async function deleteAction(payer, periodKey, targets, persist = saveSnapshot) {
  const clients = await clientsFor(payer);
  const snapshot = await scanWithClients(payer, clients);
  const period = snapshot.months[periodKey];
  const summary = { created: 0, updated: 0, repaired: 0, deleted: 0, failed: 0, skipped: 0 };
  const requested = [];
  for (const account of snapshot.accounts) {
    if (!targets.has(account.id)) continue;
    const item = account[periodKey]; const expected = `${prefix}${account.id}_${period.replace("-", "")}`;
    if (!item.customLineItemArn || item.customLineItemName !== expected) { summary.skipped += 1; continue; }
    try {
      await clients.conductor.send(new DeleteCustomLineItemCommand({
        Arn: item.customLineItemArn,
        ...(periodKey === "previous" ? { BillingPeriodRange: { InclusiveStartBillingPeriod: period } } : {}),
      }));
      requested.push({ arn: item.customLineItemArn, activePeriod: period, account, item });
    } catch (error) { summary.failed += 1; item.status = "query_error"; item.suggestion = `删除失败：${error?.message || error}`; }
  }
  const unresolved = requested.length ? await waitForNeutralizedCarryovers(clients.conductor, requested) : new Set();
  for (const request of requested) {
    if (unresolved.has(request.arn)) {
      summary.failed += 1;
      request.item.status = "query_error";
      request.item.suggestion = "删除失败：AWS 返回成功，但账单项仍然存在";
      continue;
    }
    payer.suppressions.add(`${request.account.id}:${period}`);
    request.item.synced = null; request.item.customLineItemArn = null; request.item.customLineItemName = null;
    request.item.status = "manual_deleted"; request.item.suggestion = "已人工删除，本月不自动重建";
    addHistory(request.account, "删除", null); summary.deleted += 1;
  }
  await persist(payer, snapshot, summary.failed ? "partial" : "success", `删除 ${summary.deleted}，失败 ${summary.failed}`);
  return { summary, snapshot };
}

function automaticDue(payer) {
  if (!payer.lastAutoSyncAt) return true;
  const last = new Date(payer.lastAutoSyncAt); const elapsed = Math.floor((Date.now() - last.getTime()) / 86400000);
  return !Number.isFinite(last.getTime()) || elapsed >= 2;
}

export function isSupportBillingScheduledEvent(event) { return event?.task === "support-billing"; }

export async function runScheduledSupportBilling() {
  const payers = await listPayers(); const results = [];
  for (const payer of payers) {
    if (!automaticDue(payer)) { results.push({ accountId: payer.accountId, payerName: payer.remark, skipped: true }); continue; }
    try {
      const value = await syncAction(payer, "current", null, true, saveSnapshot, false);
      results.push({ accountId: payer.accountId, payerName: payer.remark, accounts: value.snapshot.accounts.length, ...value.summary });
    }
    catch (error) { await markFailure(payer, error?.message || "自动对账失败"); results.push({ accountId: payer.accountId, payerName: payer.remark, error: error?.message || "自动对账失败" }); }
  }
  try { await sendDailySupportSyncNotification(results); }
  catch (error) { console.error("Support billing daily summary notification failed", error); }
  return { accounts: results.length, results };
}

export async function runLocalSupportBillingAction({ payer: source, state = {}, body, persist }) {
  const autoSyncOverrides = normalizeAutoSyncOverrides(state.autoSyncOverrides || source.autoSyncOverrides || {});
  const payer = { ...source, autoSyncOverrides, snapshot: null, suppressions: new Set(state.suppressions || []), lastScanAt: state.lastScanAt || "", lastAutoSyncAt: state.lastAutoSyncAt || "" };
  payer.snapshot = decorateAutoSync(payer, normalizeMappingStatuses(state.snapshot || null));
  const saveLocal = async (target, snapshot, status, message, automatic = false) => {
    target.snapshot = snapshot;
    target.lastScanAt = snapshot.lastScanAt;
    if (automatic) target.lastAutoSyncAt = new Date().toISOString();
    await persist({ ...state, snapshot, autoSyncOverrides: target.autoSyncOverrides, suppressions: [...target.suppressions], status, message, lastScanAt: snapshot.lastScanAt, lastAutoSyncAt: target.lastAutoSyncAt || "" });
    return snapshot;
  };
  if (body.action === "set_auto_sync") return setAutoSyncAction(payer, body.targetAccountId, body.enabled, async (target) => {
    await persist({ ...state, snapshot: target.snapshot, autoSyncOverrides: target.autoSyncOverrides, suppressions: [...target.suppressions], lastScanAt: target.lastScanAt || "", lastAutoSyncAt: target.lastAutoSyncAt || "" });
  });
  const period = requestedPeriod(body.period);
  if (period !== "current" && period !== "previous") {
    if (body.action === "snapshot") return { payer: publicPayer(payer), snapshot: decorateAutoSync(payer, state.historicalSnapshots?.[period] || null) };
    if (body.action !== "scan") fail("历史账期仅支持查看，不能同步或删除");
    const snapshot = await scanHistoricalAction(payer, period, async (_payer, value) => {
      const allowed = new Set(historicalPeriods().map((item) => item.billingPeriod));
      const histories = Object.fromEntries(Object.entries(state.historicalSnapshots || {}).filter(([month]) => allowed.has(month)));
      await persist({ ...state, historicalSnapshots: { ...histories, [period]: value } });
    });
    return { payer: publicPayer(payer), snapshot };
  }
  if (body.action === "scan") return { payer: publicPayer(payer), snapshot: await scanAction(payer, saveLocal) };
  const targets = normalizeTargets(body.targets);
  if (!targets.size) fail("请选择需要处理的成员账号");
  if (body.action === "sync") return syncAction(payer, period, targets, false, saveLocal);
  if (body.action === "delete") return deleteAction(payer, period, targets, saveLocal);
  fail("Invalid local Support billing action");
}

export async function handleSupportBillingRequest({ method, body, identity }) {
  if (identity?.role !== "super_admin" && identity?.role !== "admin") fail("Administrator permission required", 403);
  if (method === "GET") return { payers: (await listPayers()).map(publicPayer) };
  if (method !== "POST") fail("Method not allowed", 405);
  const payer = await requirePayer(String(body.accountId || ""));
  if (body.action === "set_auto_sync") return setAutoSyncAction(payer, body.targetAccountId, body.enabled);
  const period = requestedPeriod(body.period);
  if (period !== "current" && period !== "previous") {
    if (body.action === "snapshot") return { payer: publicPayer(payer), snapshot: readHistoricalSnapshot(payer, period) };
    if (body.action !== "scan") fail("历史账期仅支持查看，不能同步或删除");
    return { payer: publicPayer(payer), snapshot: await scanHistoricalAction(payer, period) };
  }
  if (body.action === "snapshot") return { payer: publicPayer(payer), snapshot: payer.snapshot || { lastScanAt: "", months: Object.fromEntries(periodDefinitions().map((item) => [item.key, item.billingPeriod])), accounts: [] } };
  if (body.action === "scan") {
    try { return { payer: publicPayer(payer), snapshot: await scanAction(payer) }; }
    catch (error) {
      try { await markFailure(payer, error?.message || "扫描失败"); } catch {}
      throw error;
    }
  }
  const targets = normalizeTargets(body.targets);
  if (!targets.size) fail("请选择需要处理的成员账号");
  if (body.action === "sync") return syncAction(payer, period, targets);
  if (body.action === "delete") return deleteAction(payer, period, targets);
  fail("Invalid Support billing action");
}
