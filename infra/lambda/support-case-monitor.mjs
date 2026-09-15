import crypto from "node:crypto";
import { BatchWriteItemCommand, DeleteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DeleteRoleCommand, DeleteRolePolicyCommand, DetachRolePolicyCommand, IAMClient, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand } from "@aws-sdk/client-iam";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { DescribeCasesCommand, SupportClient } from "@aws-sdk/client-support";

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE_NAME = process.env.APN_MONITOR_TABLE || "TontianApnMonitor";
const ROLE_NAME = process.env.SUPPORT_CASE_ROLE_NAME || "TontianSupportRole";
const TRUSTED_ROLE_ARN = process.env.SUPPORT_CASE_TRUSTED_ROLE_ARN || "arn:aws:iam::590184009438:role/TontianConsoleBrokerRole";
const WEBHOOK_URL = process.env.WECOM_SUPPORT_CASE_WEBHOOK_URL || "";
const ddb = new DynamoDBClient({ region: REGION });
const sts = new STSClient({ region: REGION });
const text = (item, key) => item?.[key]?.S || "";
const accountPk = (accountId) => `SUPPORT_ACCOUNT#${accountId}`;
const statusLabel = (status) => ({ opened: "处理中", "pending-customer-action": "等待客户回复", resolved: "已解决", closed: "已关闭" }[String(status || "").toLowerCase()] || status || "未知");
const compact = (value, length = 240) => String(value || "").replace(/\s+/g, " ").trim().slice(0, length);

async function scanItems() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.filter((item) => text(item, "pk").startsWith("SUPPORT_ACCOUNT#"));
}

async function queryAccount(accountId) {
  const result = await ddb.send(new QueryCommand({ TableName: TABLE_NAME, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: accountPk(accountId) } } }));
  return result.Items || [];
}

async function getData() {
  const items = await scanItems();
  const accounts = new Map();
  for (const item of items) {
    if (text(item, "sk") !== "META") continue;
    const accountId = text(item, "accountId");
    accounts.set(accountId, { accountId, remark: text(item, "remark"), lastCheckedAt: text(item, "lastCheckedAt"), cases: [] });
  }
  for (const item of items) {
    if (!text(item, "sk").startsWith("CASE#")) continue;
    const account = accounts.get(text(item, "accountId"));
    if (!account) continue;
    const status = text(item, "status");
    account.cases.push({ caseId: text(item, "caseId"), displayId: text(item, "displayId"), subject: text(item, "subject"), statusLabel: statusLabel(status), submittedBy: text(item, "submittedBy"), latestAt: text(item, "latestAt"), latestBody: text(item, "latestBody") });
  }
  const list = [...accounts.values()].sort((a, b) => a.remark.localeCompare(b.remark, "zh-CN"));
  for (const account of list) account.cases.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  return { accounts: list, lastCheckedAt: list.map((item) => item.lastCheckedAt).sort().at(-1) || "" };
}

async function accountMeta(accountId) {
  const meta = (await queryAccount(accountId)).find((item) => text(item, "sk") === "META");
  if (!meta) throw new Error("该客户账号尚未完成授权");
  return meta;
}

async function assumeCredentials(accountId, externalId) {
  const result = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${accountId}:role/${ROLE_NAME}`, RoleSessionName: "TontianSupportMonitor", ExternalId: externalId, DurationSeconds: 3600 }));
  if (!result.Credentials) throw new Error("无法取得客户账号授权");
  return { accessKeyId: result.Credentials.AccessKeyId, secretAccessKey: result.Credentials.SecretAccessKey, sessionToken: result.Credentials.SessionToken };
}

async function clientFor(accountId, externalId) {
  return new SupportClient({ region: "us-east-1", credentials: await assumeCredentials(accountId, externalId) });
}

function latestCommunication(caseData) {
  return [...(caseData?.recentCommunications?.communications || [])].sort((a, b) => String(b.timeCreated || "").localeCompare(String(a.timeCreated || "")))[0] || {};
}

async function listCases(client) {
  const cases = [];
  let nextToken;
  do {
    const result = await client.send(new DescribeCasesCommand({ includeResolvedCases: true, includeCommunications: true, language: "zh", maxResults: 100, nextToken }));
    cases.push(...(result.cases || []));
    nextToken = result.nextToken;
  } while (nextToken);
  return cases;
}

async function saveAccount({ accountId, remark, externalId, lastCheckedAt = "" }) {
  const now = new Date().toISOString();
  await ddb.send(new PutItemCommand({ TableName: TABLE_NAME, Item: {
    pk: { S: accountPk(accountId) }, sk: { S: "META" }, accountId: { S: accountId }, remark: { S: remark || accountId }, roleName: { S: ROLE_NAME }, externalId: { S: externalId }, createdAt: { S: now }, lastCheckedAt: { S: lastCheckedAt }, updatedAt: { S: now },
  } }));
}

async function saveCase(accountId, caseData) {
  const communication = latestCommunication(caseData);
  const latestBody = String(communication.body || "").slice(0, 50000);
  const latestAt = String(communication.timeCreated || caseData.timeCreated || "");
  await ddb.send(new PutItemCommand({ TableName: TABLE_NAME, Item: {
    pk: { S: accountPk(accountId) }, sk: { S: `CASE#${caseData.caseId}` }, accountId: { S: accountId }, caseId: { S: String(caseData.caseId || "") }, displayId: { S: String(caseData.displayId || caseData.caseId || "") }, subject: { S: String(caseData.subject || "") }, status: { S: String(caseData.status || "") }, submittedBy: { S: String(communication.submittedBy || caseData.submittedBy || "") }, latestAt: { S: latestAt }, latestBody: { S: latestBody }, latestHash: { S: crypto.createHash("sha256").update(`${latestAt}|${latestBody}`).digest("hex") }, updatedAt: { S: new Date().toISOString() },
  } }));
}

function authorizationCommand(accountId, externalId) {
  const trust = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: TRUSTED_ROLE_ARN }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": externalId } } }] });
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [
    { Sid: "ManageAwsSupportCases", Effect: "Allow", Action: "support:*", Resource: "*" },
    { Sid: "AllowRoleCleanup", Effect: "Allow", Action: ["iam:ListRolePolicies", "iam:DeleteRolePolicy", "iam:ListAttachedRolePolicies", "iam:DetachRolePolicy", "iam:DeleteRole"], Resource: `arn:aws:iam::${accountId}:role/${ROLE_NAME}` },
  ] });
  const script = `set -e\nROLE_NAME='${ROLE_NAME}'\nTRUST='${trust}'\nPOLICY='${policy}'\naws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 || aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST" --description 'Tontian AWS Support case monitoring' >/dev/null\naws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST"\naws iam put-role-policy --role-name "$ROLE_NAME" --policy-name TontianSupportCaseAccess --policy-document "$POLICY"\necho '授权完成'\naws sts get-caller-identity --query Account --output text`;
  return `printf '%s' '${Buffer.from(script).toString("base64")}' | base64 -d | bash`;
}

async function sendNotification(lines) {
  if (!WEBHOOK_URL || !lines.length) return;
  const response = await fetch(WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msgtype: "markdown", markdown: { content: ["## AWS 工单有更新", ...lines].join("\n").slice(0, 3800) } }) });
  if (!response.ok) throw new Error("企业微信通知发送失败");
}

async function refreshAccount(meta) {
  const accountId = text(meta, "accountId");
  const externalId = text(meta, "externalId");
  const tracked = (await queryAccount(accountId)).filter((item) => text(item, "sk").startsWith("CASE#"));
  if (!tracked.length) {
    await saveAccount({ accountId, remark: text(meta, "remark"), externalId, lastCheckedAt: new Date().toISOString() });
    return { checkedCases: 0, changedCases: 0, notifications: [] };
  }
  const result = await (await clientFor(accountId, externalId)).send(new DescribeCasesCommand({ caseIdList: tracked.map((item) => text(item, "caseId")), includeResolvedCases: true, includeCommunications: true, language: "zh" }));
  let changedCases = 0;
  const notifications = [];
  for (const caseData of result.cases || []) {
    const previous = tracked.find((item) => text(item, "caseId") === caseData.caseId);
    const communication = latestCommunication(caseData);
    const latestBody = String(communication.body || "").slice(0, 50000);
    const latestAt = String(communication.timeCreated || caseData.timeCreated || "");
    const hash = crypto.createHash("sha256").update(`${latestAt}|${latestBody}`).digest("hex");
    const replyChanged = hash !== text(previous, "latestHash");
    const stateChanged = String(caseData.status || "") !== text(previous, "status");
    if (replyChanged || stateChanged) {
      changedCases += 1;
      notifications.push(`> **${text(meta, "remark") || accountId} · ${caseData.subject || caseData.displayId}**\n> 工单号：${caseData.displayId}\n> 状态：${statusLabel(caseData.status)}${replyChanged ? `\n> 最新回复：${compact(latestBody) || "有新内容"}` : ""}`);
    }
    await saveCase(accountId, caseData);
  }
  await saveAccount({ accountId, remark: text(meta, "remark"), externalId, lastCheckedAt: new Date().toISOString() });
  return { checkedCases: tracked.length, changedCases, notifications };
}

async function refreshAll() {
  const metas = (await scanItems()).filter((item) => text(item, "sk") === "META");
  const totals = { checkedAccounts: 0, checkedCases: 0, changedCases: 0 };
  const notifications = [];
  for (const meta of metas) {
    try {
      const result = await refreshAccount(meta);
      totals.checkedAccounts += 1;
      totals.checkedCases += result.checkedCases;
      totals.changedCases += result.changedCases;
      notifications.push(...result.notifications);
    } catch (error) {
      console.error("Support case refresh failed", text(meta, "accountId"), error);
    }
  }
  await sendNotification(notifications);
  return totals;
}

async function deleteAccount(accountId) {
  const meta = await accountMeta(accountId);
  let roleDeleted = false;
  try {
    const iam = new IAMClient({ region: REGION, credentials: await assumeCredentials(accountId, text(meta, "externalId")) });
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: ROLE_NAME }));
    for (const policy of attached.AttachedPolicies || []) if (policy.PolicyArn) await iam.send(new DetachRolePolicyCommand({ RoleName: ROLE_NAME, PolicyArn: policy.PolicyArn }));
    const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: ROLE_NAME }));
    for (const policyName of inline.PolicyNames || []) await iam.send(new DeleteRolePolicyCommand({ RoleName: ROLE_NAME, PolicyName: policyName }));
    await iam.send(new DeleteRoleCommand({ RoleName: ROLE_NAME }));
    roleDeleted = true;
  } catch (error) {
    console.warn("Unable to remove customer support role automatically", accountId, error);
  }
  const items = await queryAccount(accountId);
  for (let index = 0; index < items.length; index += 25) {
    await ddb.send(new BatchWriteItemCommand({ RequestItems: { [TABLE_NAME]: items.slice(index, index + 25).map((item) => ({ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } })) } }));
  }
  return { roleDeleted, cleanupCommand: roleDeleted ? "" : `aws iam delete-role-policy --role-name ${ROLE_NAME} --policy-name TontianSupportCaseAccess 2>/dev/null || true; aws iam delete-role --role-name ${ROLE_NAME}` };
}

async function consoleLogin(accountId, caseId) {
  const meta = await accountMeta(accountId);
  const credentials = await assumeCredentials(accountId, text(meta, "externalId"));
  const session = JSON.stringify({ sessionId: credentials.accessKeyId, sessionKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken });
  const tokenResponse = await fetch(`https://signin.aws.amazon.com/federation?Action=getSigninToken&SessionDuration=3600&Session=${encodeURIComponent(session)}`);
  if (!tokenResponse.ok) throw new Error("无法生成客户账号登录链接");
  const { SigninToken } = await tokenResponse.json();
  const item = (await queryAccount(accountId)).find((entry) => text(entry, "caseId") === caseId);
  const displayId = text(item, "displayId") || caseId;
  const destination = `https://console.aws.amazon.com/support/home?region=us-east-1#/case/?displayId=${encodeURIComponent(displayId)}&language=zh`;
  return `https://signin.aws.amazon.com/federation?Action=login&Issuer=${encodeURIComponent("https://nexus.tontian.com/support-case-monitor")}&Destination=${encodeURIComponent(destination)}&SigninToken=${encodeURIComponent(SigninToken)}`;
}

export const isSupportCaseScheduledEvent = (event) => event?.source === "nexus.support-case-monitor";
export const runSupportCaseSchedule = async () => refreshAll();

export async function handleSupportCaseMonitorRequest({ method, body = {} }) {
  if (method === "GET") return getData();
  const action = String(body.action || "");
  const accountId = String(body.accountId || "").trim();
  if (action === "prepareAccount") {
    if (!/^\d{12}$/.test(accountId)) throw new Error("AWS 账号 ID 必须是 12 位数字");
    const externalId = crypto.randomBytes(24).toString("hex");
    return { externalId, command: authorizationCommand(accountId, externalId) };
  }
  if (action === "verifyAccount") {
    const externalId = String(body.externalId || "");
    if (!externalId) throw new Error("请先生成并执行授权命令");
    const client = await clientFor(accountId, externalId);
    await client.send(new DescribeCasesCommand({ includeResolvedCases: false, maxResults: 5, language: "zh" }));
    await saveAccount({ accountId, remark: compact(body.remark, 80), externalId });
    return { success: true };
  }
  if (action === "addCases") {
    const meta = await accountMeta(accountId);
    const wanted = [...new Set(String(body.caseIds || "").split(/[\s,，]+/).map((value) => value.trim()).filter(Boolean))];
    if (!wanted.length) throw new Error("请填写工单号");
    const allCases = await listCases(await clientFor(accountId, text(meta, "externalId")));
    const matched = allCases.filter((item) => wanted.includes(String(item.caseId)) || wanted.includes(String(item.displayId)));
    if (!matched.length) throw new Error("没有找到对应工单，请检查工单号和授权账号");
    for (const caseData of matched) await saveCase(accountId, caseData);
    return { success: true, added: matched.length, missing: wanted.filter((id) => !matched.some((item) => id === item.caseId || id === item.displayId)) };
  }
  if (action === "refresh") return refreshAll();
  if (action === "deleteCase") {
    await ddb.send(new DeleteItemCommand({ TableName: TABLE_NAME, Key: { pk: { S: accountPk(accountId) }, sk: { S: `CASE#${String(body.caseId || "")}` } } }));
    return { success: true };
  }
  if (action === "deleteAccount") return deleteAccount(accountId);
  if (action === "consoleLogin") return { url: await consoleLogin(accountId, String(body.caseId || "")) };
  throw new Error("不支持的操作");
}
