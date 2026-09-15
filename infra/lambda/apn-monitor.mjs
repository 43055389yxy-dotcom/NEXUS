import { BatchWriteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { GetAwsOpportunitySummaryCommand, GetOpportunityCommand, ListOpportunitiesCommand, PartnerCentralSellingClient } from "@aws-sdk/client-partnercentral-selling";
import { GetBenefitApplicationCommand, ListBenefitAllocationsCommand, ListBenefitApplicationsCommand, PartnerCentralBenefitsClient } from "@aws-sdk/client-partnercentral-benefits";

const REGION = process.env.AWS_REGION || "us-east-1";
const PARTNER_REGION = process.env.APN_PARTNER_REGION || "us-east-1";
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE || "TontianAwsAccessAccounts";
const GROUPS_TABLE = process.env.GROUPS_TABLE || "TontianAwsAccessGroups";
const MONITOR_TABLE = process.env.APN_MONITOR_TABLE || "TontianApnMonitor";
const APN_ACCOUNT_ID = process.env.APN_ACCOUNT_ID || "";
const WEBHOOK_URL = process.env.WECOM_APN_WEBHOOK_URL || process.env.WECOM_SUPPORT_WEBHOOK_URL || "";
const db = new DynamoDBClient({ region: REGION });
const sts = new STSClient({ region: REGION });

export const APN_MONITOR_TEMPLATES = [
  { id: "all", label: "全部", resourceTypes: [] },
  { id: "opportunity", label: "商机", resourceTypes: ["opportunity"] },
  { id: "benefit", label: "券申请", resourceTypes: ["benefit_application"] },
];

export const DEFAULT_MONITOR_RULES = [
  { id: "opportunity.awsStage", label: "商机 AWS 阶段变化", resourceType: "opportunity", field: "awsStage", enabled: true },
  { id: "benefit.stage", label: "券申请阶段变化", resourceType: "benefit_application", field: "stage", enabled: true },
  { id: "benefit.status", label: "券审批状态变化", resourceType: "benefit_application", field: "status", enabled: true },
  { id: "allocation.status", label: "资金分配状态变化", resourceType: "benefit_allocation", field: "status", enabled: true },
  { id: "po.status", label: "PO 状态变化", resourceType: "purchase_order", field: "status", enabled: true },
];

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

function safeJson(value, max = 120000) {
  const result = JSON.stringify(value ?? null);
  return result.length <= max ? result : `${result.slice(0, max)}...`;
}

function iso(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
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

async function findApnAccounts() {
  const accounts = (await scanAll(ACCOUNTS_TABLE)).map(simpleItem);
  if (/^\d{12}$/.test(APN_ACCOUNT_ID)) {
    const account = accounts.find((item) => item.accountId === APN_ACCOUNT_ID);
    return [{ accountId: APN_ACCOUNT_ID, name: account?.remark || account?.name || "APN", region: account?.region || PARTNER_REGION }];
  }
  const groups = (await scanAll(GROUPS_TABLE)).map(simpleItem);
  const groupIds = new Set(groups.filter((group) => String(group.name).trim().toUpperCase() === "APN").map((group) => group.groupId));
  return accounts.filter((account) => /^\d{12}$/.test(account.accountId || "") && groupIds.has(account.groupId)).map((account) => ({
    accountId: account.accountId,
    name: account.remark || account.name || "APN",
    region: account.region || PARTNER_REGION,
  }));
}

async function partnerClients(accountId) {
  const result = await sts.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/TontianOperationsRole`,
    RoleSessionName: "nexus-apn-monitor",
    DurationSeconds: 3600,
  }));
  const credentials = result.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) throw new Error("无法取得 APN 运维角色凭证");
  const config = { region: PARTNER_REGION, credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } };
  return { selling: new PartnerCentralSellingClient(config), benefits: new PartnerCentralBenefitsClient(config) };
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

async function listAll(client, Command, key, input = {}) {
  const items = [];
  let NextToken;
  do {
    const result = await client.send(new Command({ Catalog: "AWS", MaxResults: 100, ...input, NextToken }));
    items.push(...(result[key] || []));
    NextToken = result.NextToken;
  } while (NextToken);
  return items;
}

function deepValue(value, pattern) {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    if (pattern.test(key) && (typeof child === "string" || typeof child === "number")) return String(child);
    const nested = deepValue(child, pattern);
    if (nested) return nested;
  }
  return "";
}

function businessType(value) {
  const source = safeJson(value, 20000).toLowerCase();
  if (/well[- ]?architected|wafr|\bwa\b/.test(source)) return "wa";
  if (/migration acceleration|\bmap\b/.test(source)) return "map";
  if (/proof of concept|\bpoc\b/.test(source)) return "poc";
  if (/market development|\bmdf\b/.test(source)) return "mdf";
  return "general";
}

function relatedOpportunity(resources) {
  for (const resource of resources || []) {
    const match = String(resource).match(/O\d{1,19}/i);
    if (match) return match[0].toUpperCase();
  }
  return "";
}

function resource(input) {
  return {
    status: "", stage: "", businessType: "general", fields: {}, relations: [], raw: {},
    projectId: `${input.resourceType}:${input.externalId}`,
    ...input,
  };
}

async function collectResources(account) {
  const { selling, benefits } = await partnerClients(account.accountId);
  const [opportunitySummaries, applicationSummaries, allocationSummaries] = await Promise.all([
    listAll(selling, ListOpportunitiesCommand, "OpportunitySummaries"),
    listAll(benefits, ListBenefitApplicationsCommand, "BenefitApplicationSummaries"),
    listAll(benefits, ListBenefitAllocationsCommand, "BenefitAllocationSummaries"),
  ]);

  const opportunities = (await mapLimited(opportunitySummaries, 5, async (summary) => {
    if (!summary.Id) return null;
    const [detailResult, awsResult] = await Promise.allSettled([
      selling.send(new GetOpportunityCommand({ Catalog: "AWS", Identifier: summary.Id })),
      selling.send(new GetAwsOpportunitySummaryCommand({ Catalog: "AWS", RelatedOpportunityIdentifier: summary.Id })),
    ]);
    const detail = detailResult.status === "fulfilled" ? detailResult.value : summary;
    const aws = awsResult.status === "fulfilled" ? awsResult.value : {};
    const customerName = detail.Customer?.Account?.CompanyName || summary.Customer?.Account?.CompanyName || "";
    const title = detail.Project?.Title || detail.Project?.ProjectTitle || customerName || summary.Id;
    return resource({
      accountId: account.accountId, resourceType: "opportunity", externalId: summary.Id, title,
      businessType: businessType({ summary, detail }), projectId: `opportunity:${summary.Id}`,
      status: detail.LifeCycle?.ReviewStatus || summary.LifeCycle?.ReviewStatus || "",
      stage: aws.LifeCycle?.Stage || summary.LifeCycle?.Stage || "",
      sourceUrl: `https://console.aws.amazon.com/partnercentral/opportunities?region=${PARTNER_REGION}`,
      fields: {
        awsStage: aws.LifeCycle?.Stage || "",
        partnerStage: detail.LifeCycle?.Stage || summary.LifeCycle?.Stage || "",
        reviewStatus: detail.LifeCycle?.ReviewStatus || summary.LifeCycle?.ReviewStatus || "",
        reviewComments: detail.LifeCycle?.ReviewComments || summary.LifeCycle?.ReviewComments || "",
        awsNextSteps: aws.LifeCycle?.NextSteps || aws.Insights?.NextBestActions || "",
        targetCloseDate: aws.LifeCycle?.TargetCloseDate || detail.LifeCycle?.TargetCloseDate || "",
        customerName,
        updatedAt: iso(summary.LastModifiedDate),
      },
      raw: { summary, detail, aws },
    });
  })).filter(Boolean);

  const applications = (await mapLimited(applicationSummaries, 5, async (summary) => {
    if (!summary.Id) return null;
    let detail = summary;
    try { detail = await benefits.send(new GetBenefitApplicationCommand({ Catalog: "AWS", Identifier: summary.Id })); } catch {}
    const relations = detail.AssociatedResources || summary.AssociatedResources || [];
    const opportunityId = relatedOpportunity(relations);
    return resource({
      accountId: account.accountId, resourceType: "benefit_application", externalId: summary.Id,
      title: detail.Name || summary.Name || summary.Id, businessType: businessType({ summary, detail }),
      projectId: opportunityId ? `opportunity:${opportunityId}` : `benefit:${summary.Id}`,
      status: detail.Status || summary.Status || "", stage: detail.Stage || summary.Stage || "",
      sourceUrl: `https://console.aws.amazon.com/partnercentral/funding?region=${PARTNER_REGION}`,
      fields: {
        status: detail.Status || summary.Status || "", stage: detail.Stage || summary.Stage || "",
        statusReason: detail.StatusReason || "", statusReasonCodes: detail.StatusReasonCodes || [],
        benefitId: detail.BenefitId || summary.BenefitId || "", programs: detail.Programs || summary.Programs || [],
        fulfillmentTypes: detail.FulfillmentTypes || summary.FulfillmentTypes || [], opportunityId,
        amount: deepValue(detail.BenefitApplicationDetails, /(^|_)(amount|requested.?amount|funding.?amount)($|_)/i),
        poNumber: deepValue(detail.BenefitApplicationDetails, /(^|_)(purchase.?order|po)(.?number|.?id)?($|_)/i),
        updatedAt: iso(detail.UpdatedAt || summary.UpdatedAt),
      },
      relations, raw: { summary, detail },
    });
  })).filter(Boolean);

  const applicationsById = new Map(applications.map((item) => [item.externalId, item]));
  const allocations = allocationSummaries.filter((summary) => summary.Id).map((summary) => {
    const parent = applicationsById.get(summary.BenefitApplicationId);
    return resource({
      accountId: account.accountId, resourceType: "benefit_allocation", externalId: summary.Id,
      title: summary.Name || summary.Id, businessType: parent?.businessType || businessType(summary),
      projectId: parent?.projectId || `allocation:${summary.Id}`, status: summary.Status || "",
      sourceUrl: `https://console.aws.amazon.com/partnercentral/funding?region=${PARTNER_REGION}`,
      fields: { status: summary.Status || "", statusReason: summary.StatusReason || "", benefitApplicationId: summary.BenefitApplicationId || "", fulfillmentTypes: summary.FulfillmentTypes || [], createdAt: iso(summary.CreatedAt), expiresAt: iso(summary.ExpiresAt) },
      relations: summary.BenefitApplicationId ? [summary.BenefitApplicationId] : [], raw: summary,
    });
  });

  const purchaseOrders = applications.flatMap((application) => {
    const poNumber = application.fields.poNumber;
    if (!poNumber) return [];
    const status = deepValue(application.raw, /(^|_)(po.?status|purchase.?order.?status)($|_)/i);
    return [resource({
      accountId: account.accountId, resourceType: "purchase_order", externalId: poNumber, title: `PO ${poNumber}`,
      businessType: application.businessType, projectId: application.projectId, status, sourceUrl: application.sourceUrl,
      fields: { status, benefitApplicationId: application.externalId }, relations: [application.externalId], raw: application.raw,
    })];
  });

  const waOpportunities = new Set(applications.filter((item) => item.businessType === "wa").map((item) => item.fields.opportunityId).filter(Boolean));
  for (const opportunity of opportunities) if (waOpportunities.has(opportunity.externalId)) opportunity.businessType = "wa";
  return [...opportunities, ...applications, ...allocations, ...purchaseOrders];
}

async function collectWatchedResources(account, watchlist) {
  const { selling, benefits } = await partnerClients(account.accountId);
  const opportunityDetails = await mapLimited(watchlist, 5, async (opportunityId) => {
    const [detailResult, awsResult] = await Promise.allSettled([
      selling.send(new GetOpportunityCommand({ Catalog: "AWS", Identifier: opportunityId })),
      selling.send(new GetAwsOpportunitySummaryCommand({ Catalog: "AWS", RelatedOpportunityIdentifier: opportunityId })),
    ]);
    if (detailResult.status === "rejected") {
      return { opportunityId, error: detailResult.reason?.message || "无法读取商机" };
    }
    return { opportunityId, detail: detailResult.value, aws: awsResult.status === "fulfilled" ? awsResult.value : {} };
  });

  const opportunities = opportunityDetails.map(({ opportunityId, detail, aws, error }) => {
    if (!detail) return resource({
      accountId: account.accountId, resourceType: "opportunity", externalId: opportunityId, title: opportunityId,
      projectId: `opportunity:${opportunityId}`, status: "读取失败", stage: "",
      sourceUrl: `https://console.aws.amazon.com/partnercentral/opportunities?region=${PARTNER_REGION}`,
      fields: { awsStage: "", error: error || "无法读取商机" }, raw: { error },
    });
    const customerName = detail.Customer?.Account?.CompanyName || "";
    const title = detail.Project?.Title || detail.Project?.ProjectTitle || customerName || opportunityId;
    return resource({
      accountId: account.accountId, resourceType: "opportunity", externalId: opportunityId, title,
      businessType: businessType(detail), projectId: `opportunity:${opportunityId}`,
      status: "", stage: aws.LifeCycle?.Stage || "",
      sourceUrl: `https://console.aws.amazon.com/partnercentral/opportunities?region=${PARTNER_REGION}`,
      fields: { awsStage: aws.LifeCycle?.Stage || "", updatedAt: iso(detail.LastModifiedDate), customerName },
      raw: { detail, aws },
    });
  });

  const applicationMap = new Map();
  for (const opportunity of opportunityDetails) {
    if (!opportunity.detail?.Arn) continue;
    const summaries = await listAll(benefits, ListBenefitApplicationsCommand, "BenefitApplicationSummaries", { AssociatedResourceArns: [opportunity.detail.Arn] });
    for (const summary of summaries) if (summary.Id) applicationMap.set(summary.Id, { summary, opportunityId: opportunity.opportunityId });
  }

  const applications = (await mapLimited([...applicationMap.values()], 5, async ({ summary, opportunityId }) => {
    let detail = summary;
    try { detail = await benefits.send(new GetBenefitApplicationCommand({ Catalog: "AWS", Identifier: summary.Id })); } catch {}
    return resource({
      accountId: account.accountId, resourceType: "benefit_application", externalId: summary.Id,
      title: detail.Name || summary.Name || summary.Id, businessType: businessType({ summary, detail }),
      projectId: `opportunity:${opportunityId}`, status: detail.Status || summary.Status || "", stage: detail.Stage || summary.Stage || "",
      sourceUrl: `https://console.aws.amazon.com/partnercentral/funding?region=${PARTNER_REGION}`,
      fields: {
        status: detail.Status || summary.Status || "", stage: detail.Stage || summary.Stage || "",
        statusReason: detail.StatusReason || "", statusReasonCodes: detail.StatusReasonCodes || [],
        opportunityId, updatedAt: iso(detail.UpdatedAt || summary.UpdatedAt),
      },
      relations: detail.AssociatedResources || summary.AssociatedResources || [], raw: { summary, detail },
    });
  })).filter(Boolean);

  return [...opportunities, ...applications];
}

async function queryPartition(pk) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await db.send(new QueryCommand({ TableName: MONITOR_TABLE, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: pk } }, ExclusiveStartKey }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.map(simpleItem);
}

async function loadRules() {
  const config = (await queryPartition("CONFIG")).find((item) => item.sk === "RULES");
  const saved = new Map(parseJson(config?.rulesJson, []).map((rule) => [rule.id, rule]));
  return DEFAULT_MONITOR_RULES.map((rule) => ({ ...rule, enabled: saved.has(rule.id) ? saved.get(rule.id).enabled !== false : rule.enabled }));
}

async function loadWatchlist() {
  const config = (await queryPartition("CONFIG")).find((item) => item.sk === "WATCHLIST");
  return parseJson(config?.watchlistJson, []).filter((value) => /^O\d{1,19}$/i.test(String(value))).map((value) => String(value).toUpperCase());
}

async function saveWatchlist(values) {
  const watchlist = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim().toUpperCase()).filter((value) => /^O\d{1,19}$/.test(value)))].slice(0, 100);
  await db.send(new PutItemCommand({ TableName: MONITOR_TABLE, Item: { pk: { S: "CONFIG" }, sk: { S: "WATCHLIST" }, watchlistJson: { S: JSON.stringify(watchlist) }, updatedAt: { S: new Date().toISOString() } } }));
  return watchlist;
}

async function saveRules(rules) {
  const allowed = new Set(DEFAULT_MONITOR_RULES.map((rule) => rule.id));
  const normalized = (Array.isArray(rules) ? rules : []).filter((rule) => allowed.has(rule?.id)).map((rule) => ({ id: rule.id, enabled: rule.enabled !== false }));
  await db.send(new PutItemCommand({ TableName: MONITOR_TABLE, Item: { pk: { S: "CONFIG" }, sk: { S: "RULES" }, rulesJson: { S: JSON.stringify(normalized) }, updatedAt: { S: new Date().toISOString() } } }));
  return loadRules();
}

function tracked(resourceItem) {
  return { title: resourceItem.title, status: resourceItem.status, stage: resourceItem.stage, businessType: resourceItem.businessType, ...resourceItem.fields };
}

function differences(before, after) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].flatMap((field) => JSON.stringify(before?.[field] ?? "") === JSON.stringify(after?.[field] ?? "") ? [] : [{ field, before: before?.[field] ?? "", after: after?.[field] ?? "" }]);
}

function dbResource(item, observedAt) {
  return {
    pk: { S: `ACCOUNT#${item.accountId}` }, sk: { S: `RESOURCE#${item.resourceType}#${item.externalId}` },
    accountId: { S: item.accountId }, resourceType: { S: item.resourceType }, externalId: { S: item.externalId },
    title: { S: item.title }, businessType: { S: item.businessType }, projectId: { S: item.projectId },
    status: { S: item.status }, stage: { S: item.stage }, sourceUrl: { S: item.sourceUrl },
    fieldsJson: { S: safeJson(item.fields) }, relationsJson: { S: safeJson(item.relations) }, rawJson: { S: safeJson(item.raw) },
    trackedJson: { S: safeJson(tracked(item)) }, observedAt: { S: observedAt },
  };
}

async function batchPut(items) {
  for (let offset = 0; offset < items.length; offset += 25) {
    await db.send(new BatchWriteItemCommand({ RequestItems: { [MONITOR_TABLE]: items.slice(offset, offset + 25).map((Item) => ({ PutRequest: { Item } })) } }));
  }
}

function display(value) {
  if (Array.isArray(value)) return value.join("、") || "-";
  if (value && typeof value === "object") return safeJson(value, 500);
  return String(value || "-");
}

function notifyEnabled(item, changes, rules) {
  return rules.some((rule) => rule.enabled && rule.resourceType === item.resourceType && changes.some((change) => change.field === rule.field));
}

const FIELD_NAMES = { awsStage: "AWS 阶段", stage: "审批进度", status: "审批结果" };
const STATUS_NAMES = {
  Launched: "已上线", Approved: "已通过", Active: "进行中", Pending: "等待处理",
  Submitted: "已提交", "In Progress": "处理中", ActionRequired: "需要补充资料",
  Rejected: "未通过", Cancelled: "已取消", Closed: "已结束", Qualified: "已确认",
  "Closed Lost": "已关闭", "AWS Closed Lost": "AWS 已关闭",
};
function friendly(value) { return STATUS_NAMES[String(value || "")] || display(value); }

async function notify(changes) {
  if (!changes.length || !/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=/.test(WEBHOOK_URL)) return;
  const lines = changes.map(({ item, changes: changed }) => {
    const detail = changed.map((change) => `${FIELD_NAMES[change.field] || change.field}：${friendly(change.before)} → ${friendly(change.after)}`).join("；");
    const launched = item.resourceType === "opportunity" && item.fields.awsStage === "Launched";
    return `> ${item.title}（${item.externalId}）\n> ${detail}${launched ? "\n> 已上线，现在可以提交券申请了" : ""}`;
  });
  const response = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "markdown", markdown: { content: [`**APN 状态有变化**`, `这次共有 ${changes.length} 项变化：`, ...lines].join("\n\n") } }) });
  if (!response.ok) throw new Error(`微信群通知失败 (${response.status})`);
}

async function refreshAccount(account, rules, watchlist) {
  const observedAt = new Date().toISOString();
  const previousItems = await queryPartition(`ACCOUNT#${account.accountId}`);
  const previous = new Map(previousItems.filter((item) => item.sk.startsWith("RESOURCE#")).map((item) => [`${item.resourceType}#${item.externalId}`, item]));
  const resources = await collectWatchedResources(account, watchlist);
  const history = [];
  const alertChanges = [];
  for (const item of resources) {
    const old = previous.get(`${item.resourceType}#${item.externalId}`);
    const changed = old ? differences(parseJson(old.trackedJson), tracked(item)) : [];
    if (old && changed.length) {
      history.push({ item, changes: changed });
      if (notifyEnabled(item, changed, rules)) alertChanges.push({ item, changes: changed });
    }
  }
  await batchPut([
    ...resources.map((item) => dbResource(item, observedAt)),
    ...history.map(({ item, changes }) => ({
      pk: { S: `ACCOUNT#${account.accountId}` }, sk: { S: `HISTORY#${observedAt}#${item.resourceType}#${item.externalId}` },
      accountId: { S: account.accountId }, resourceType: { S: item.resourceType }, externalId: { S: item.externalId },
      title: { S: item.title }, businessType: { S: item.businessType }, projectId: { S: item.projectId }, changesJson: { S: safeJson(changes) }, observedAt: { S: observedAt },
    })),
    { pk: { S: `ACCOUNT#${account.accountId}` }, sk: { S: "META" }, accountId: { S: account.accountId }, accountName: { S: account.name }, lastRunAt: { S: observedAt }, resourceCount: { N: String(resources.length) }, status: { S: "ok" } },
  ]);
  return { account, resourceCount: resources.length, changes: alertChanges };
}

export async function refreshApnMonitor() {
  const accounts = await findApnAccounts();
  if (!accounts.length) throw new Error("没有找到 APN 分组中的账号，请先把 APN 账号放入 APN 分组");
  const rules = await loadRules();
  const watchlist = await loadWatchlist();
  if (!watchlist.length) return { ok: true, accounts: accounts.length, resources: 0, changes: 0, errors: [] };
  const results = [];
  const errors = [];
  for (const account of accounts) {
    try { results.push(await refreshAccount(account, rules, watchlist)); }
    catch (error) { errors.push({ accountId: account.accountId, name: account.name, error: error instanceof Error ? error.message : String(error) }); }
  }
  const changes = results.flatMap((result) => result.changes);
  await notify(changes);
  return { ok: errors.length === 0, accounts: results.length, resources: results.reduce((sum, result) => sum + result.resourceCount, 0), changes: changes.length, errors };
}

function publicResource(item) {
  return { accountId: item.accountId, resourceType: item.resourceType, externalId: item.externalId, title: item.title, businessType: item.businessType, projectId: item.projectId, status: item.status, stage: item.stage, sourceUrl: item.sourceUrl, fields: parseJson(item.fieldsJson), relations: parseJson(item.relationsJson, []), observedAt: item.observedAt };
}

export async function getApnMonitorData() {
  const accounts = await findApnAccounts();
  const watchlist = await loadWatchlist();
  const watched = new Set(watchlist);
  const resources = [];
  const history = [];
  const accountStates = [];
  for (const account of accounts) {
    const items = await queryPartition(`ACCOUNT#${account.accountId}`);
    resources.push(...items.filter((item) => item.sk.startsWith("RESOURCE#")).map(publicResource).filter((item) => watched.has(item.externalId) || watched.has(String(item.fields.opportunityId || "")) || watched.has(String(item.projectId || "").replace(/^opportunity:/, ""))));
    history.push(...items.filter((item) => item.sk.startsWith("HISTORY#") && (watched.has(item.externalId) || watched.has(String(item.projectId || "").replace(/^opportunity:/, "")))).map((item) => ({ accountId: item.accountId, resourceType: item.resourceType, externalId: item.externalId, title: item.title, businessType: item.businessType, projectId: item.projectId, changes: parseJson(item.changesJson, []), observedAt: item.observedAt })));
    const meta = items.find((item) => item.sk === "META");
    accountStates.push({ ...account, lastRunAt: meta?.lastRunAt || "", status: meta?.status || "not_scanned", resourceCount: Number(meta?.resourceCount || 0) });
  }
  history.sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  return { accounts: accountStates, resources, history: history.slice(0, 200), rules: await loadRules(), templates: APN_MONITOR_TEMPLATES, watchlist };
}

export function isApnMonitorScheduledEvent(event) {
  return event?.source === "nexus.apn-monitor" || event?.["detail-type"] === "APN Status Monitor";
}

export async function runScheduledApnMonitor() { return refreshApnMonitor(); }

export async function handleApnMonitorRequest({ method, body }) {
  if (method === "GET") return getApnMonitorData();
  if (method === "POST" && body?.action === "saveWatchlist") return { ok: true, watchlist: await saveWatchlist(body.watchlist) };
  if (method === "POST" && body?.action === "saveRules") return { ok: true, rules: await saveRules(body.rules) };
  if (method === "POST") return refreshApnMonitor();
  throw new Error("不支持的请求方法");
}
