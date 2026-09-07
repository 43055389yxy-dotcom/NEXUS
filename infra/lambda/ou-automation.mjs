import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AttachPolicyCommand, CreateOrganizationalUnitCommand, CreatePolicyCommand, DescribeOrganizationCommand, DescribePolicyCommand, DetachPolicyCommand, EnablePolicyTypeCommand, ListAccountsCommand, ListOrganizationalUnitsForParentCommand, ListParentsCommand, ListPoliciesCommand, ListPoliciesForTargetCommand, ListRootsCommand, MoveAccountCommand, OrganizationsClient, UpdatePolicyCommand } from "@aws-sdk/client-organizations";

const dynamodb = new DynamoDBClient({});
const sts = new STSClient({});
const accountsTable = process.env.ACCOUNTS_TABLE;
const groupsTable = process.env.GROUPS_TABLE;
const historyTable = process.env.OU_HISTORY_TABLE || "TontianOuAutomationHistory";
const automationRole = "TontianOrganizationAutomationRole";
const pmaGroupNames = new Set(["PMA", "CMA组"]);
const targetGroupNames = new Set([...(process.env.OU_AUTOMATION_GROUP_NAMES || "PMA,CMA组,老代付组").split(",").map((name) => name.trim()).filter(Boolean), ...pmaGroupNames, "老代付组"]);
const temporaryName = "临时";
const restrictedName = "禁止 SP/RI";
const restrictedPolicyName = "NEXUS-Restricted-Guardrails";
const policyDocuments = {
  [restrictedPolicyName]: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["savingsplans:*", "ec2:PurchaseReservedInstancesOffering", "rds:PurchaseReservedDBInstancesOffering", "organizations:LeaveOrganization", "account:CloseAccount"], Resource: "*" }] },
};

function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function normalized(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN"); }
function canonicalGroupName(name) { return name === "CMA组" ? "PMA" : name; }
function itemAccountType(item, groupName) { return item.accountType?.S || (pmaGroupNames.has(groupName) ? "cma" : ""); }
function supportsOu(item, groupName) { return groupName === "老代付组" || (pmaGroupNames.has(groupName) && itemAccountType(item, groupName) === "cma"); }

async function requireAccount(accountId) {
  if (!/^\d{12}$/.test(String(accountId || ""))) fail("Invalid AWS account ID");
  const accountResult = await dynamodb.send(new GetItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, ConsistentRead: true }));
  if (!accountResult.Item) fail("Account does not exist", 404);
  const groupId = accountResult.Item.groupId?.S || "";
  const groupResult = groupId ? await dynamodb.send(new GetItemCommand({ TableName: groupsTable, Key: { groupId: { S: groupId } }, ConsistentRead: true })) : {};
  const groupName = groupResult.Item?.name?.S || "";
  if (!targetGroupNames.has(groupName) || !supportsOu(accountResult.Item, groupName)) fail("只有 CMA账号和老代付账号支持 OU 自动归位");
  const accountType = itemAccountType(accountResult.Item, groupName);
  const temporaryOuId = accountResult.Item.temporaryOuId?.S || "";
  const restrictedOuId = accountResult.Item.restrictedOuId?.S || "";
  const memberCache = (() => { try { return JSON.parse(accountResult.Item.ouMemberCache?.S || "null"); } catch { return null; } })();
  return { accountId, remark: accountResult.Item.remark?.S || accountResult.Item.name?.S || accountId, groupId, groupName: canonicalGroupName(groupName), accountType, temporaryOuId, restrictedOuId, configured: Boolean(temporaryOuId && restrictedOuId), lastRunAt: accountResult.Item.ouAutomationLastRunAt?.S || "", lastStatus: accountResult.Item.ouAutomationLastStatus?.S || "", memberCache };
}

async function listAccounts() {
  const [groups, accounts] = await Promise.all([dynamodb.send(new ScanCommand({ TableName: groupsTable })), dynamodb.send(new ScanCommand({ TableName: accountsTable }))]);
  const targetGroups = new Map((groups.Items || []).filter((item) => item.name?.S && targetGroupNames.has(item.name.S)).map((item) => [item.groupId.S, item.name.S]));
  return (accounts.Items || []).filter((item) => { const groupName = targetGroups.get(item.groupId?.S || ""); return groupName && supportsOu(item, groupName); }).map((item) => { const groupName = targetGroups.get(item.groupId?.S || ""); return { accountId: item.accountId.S, remark: item.remark?.S || item.name?.S || item.accountId.S, groupName: canonicalGroupName(groupName), accountType: itemAccountType(item, groupName), temporaryOuId: item.temporaryOuId?.S || "", restrictedOuId: item.restrictedOuId?.S || "", configured: Boolean(item.temporaryOuId?.S && item.restrictedOuId?.S), lastRunAt: item.ouAutomationLastRunAt?.S || "", lastStatus: item.ouAutomationLastStatus?.S || "" }; }).sort((a, b) => a.groupName.localeCompare(b.groupName, "zh-CN") || a.remark.localeCompare(b.remark, "zh-CN"));
}

async function context(account) {
  const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${account.accountId}:role/${automationRole}`, RoleSessionName: `nexus-ou-${Date.now()}`, DurationSeconds: 900 }));
  const credentials = assumed.Credentials;
  const client = new OrganizationsClient({ region: "us-east-1", credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken } });
  const organization = (await client.send(new DescribeOrganizationCommand({}))).Organization;
  const managementAccountId = organization?.ManagementAccountId || organization?.MasterAccountId;
  if (managementAccountId !== account.accountId) fail("该代付账号不是当前 AWS Organization 的管理账号");
  const rootId = (await client.send(new ListRootsCommand({}))).Roots?.[0]?.Id;
  if (!rootId) fail("AWS Organization Root 不存在");
  return { client, rootId, managementAccountId };
}

async function rootOus(client, rootId) {
  const result = [];
  let NextToken;
  do { const page = await client.send(new ListOrganizationalUnitsForParentCommand({ ParentId: rootId, NextToken })); result.push(...(page.OrganizationalUnits || []).map((ou) => ({ id: ou.Id, name: ou.Name }))); NextToken = page.NextToken; } while (NextToken);
  return result.filter((ou) => ou.id && ou.name).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function inspect(accountId) {
  const account = await requireAccount(accountId);
  const organization = await context(account);
  const ous = await rootOus(organization.client, organization.rootId);
  const temporaryOu = ous.find((ou) => normalized(ou.name) === normalized(temporaryName)) || null;
  const restrictedOu = ous.find((ou) => normalized(ou.name) === normalized(restrictedName)) || null;
  return { ...organization, account, ous, temporaryOu, restrictedOu, temporaryOuId: temporaryOu?.id || "", restrictedOuId: restrictedOu?.id || "" };
}

function publicAccount(account) { const { memberCache, ...value } = account; return value; }
function publicDiscovery(value) { return { account: publicAccount(value.account), temporaryOu: value.temporaryOu || null, restrictedOu: value.restrictedOu || null, temporaryOuId: value.temporaryOuId, restrictedOuId: value.restrictedOuId }; }

async function resolveOu(client, rootId, detected, name) {
  if (detected) return detected;
  const created = (await client.send(new CreateOrganizationalUnitCommand({ ParentId: rootId, Name: name }))).OrganizationalUnit;
  return { id: created.Id, name: created.Name, match: "created" };
}


async function listScps(client, rootId) {
  const result = [];
  let NextToken;
  try { do { const page = await client.send(new ListPoliciesCommand({ Filter: "SERVICE_CONTROL_POLICY", NextToken })); result.push(...(page.Policies || [])); NextToken = page.NextToken; } while (NextToken); }
  catch (error) { if (error?.name !== "PolicyTypeNotEnabledException") throw error; await client.send(new EnablePolicyTypeCommand({ RootId: rootId, PolicyType: "SERVICE_CONTROL_POLICY" })); return listScps(client, rootId); }
  return result;
}

function canonical(content) { try { return JSON.stringify(JSON.parse(content)); } catch {} try { return JSON.stringify(JSON.parse(decodeURIComponent(content))); } catch {} return String(content || ""); }


async function ensureScp(client, policies, name, document) {
  const content = JSON.stringify(document);
  let summary = policies.find((policy) => policy.Name === name && !policy.AwsManaged);
  if (!summary) summary = (await client.send(new CreatePolicyCommand({ Content: content, Description: `Managed by NEXUS: ${name}`, Name: name, Type: "SERVICE_CONTROL_POLICY" }))).Policy?.PolicySummary;
  else if (canonical((await client.send(new DescribePolicyCommand({ PolicyId: summary.Id }))).Policy?.Content) !== canonical(content)) {
    if (!String(summary.Description || "").startsWith("Managed by NEXUS:")) fail(`检测到非 NEXUS 管理的同名 SCP：${name}，请先人工确认`);
    await client.send(new UpdatePolicyCommand({ PolicyId: summary.Id, Content: content, Description: `Managed by NEXUS: ${name}`, Name: name }));
  }
  if (!summary?.Id) fail(`无法创建或读取 SCP：${name}`);
  return summary.Id;
}

async function attachedScps(client, targetId) {
  const policies = [];
  let NextToken;
  do { const page = await client.send(new ListPoliciesForTargetCommand({ TargetId: targetId, Filter: "SERVICE_CONTROL_POLICY", NextToken })); policies.push(...(page.Policies || [])); NextToken = page.NextToken; } while (NextToken);
  return policies;
}

async function attach(client, targetId, policyId) {
  const policies = await attachedScps(client, targetId);
  if (!policies.some((policy) => policy.Id === policyId)) await client.send(new AttachPolicyCommand({ PolicyId: policyId, TargetId: targetId }));
}

async function keepOnlyDirectPolicies(client, targetId, keepPolicyIds) {
  const policies = await attachedScps(client, targetId);
  for (const policy of policies) {
    if (!policy.AwsManaged && policy.Id && !keepPolicyIds.has(policy.Id)) await client.send(new DetachPolicyCommand({ PolicyId: policy.Id, TargetId: targetId }));
  }
}

async function configureFromInspection(value) {
  const temporaryOu = await resolveOu(value.client, value.rootId, value.temporaryOu, temporaryName);
  const restrictedOu = await resolveOu(value.client, value.rootId, value.restrictedOu, restrictedName);
  if (temporaryOu.id === restrictedOu.id) fail("临时和禁止 SP/RI 必须对应两个不同的 OU");
  const policies = await listScps(value.client, value.rootId);
  const fullAccessId = policies.find((policy) => policy.Name === "FullAWSAccess")?.Id;
  if (!fullAccessId) fail("无法读取 AWS 托管策略 FullAWSAccess");
  const restrictedPolicyId = await ensureScp(value.client, policies, restrictedPolicyName, policyDocuments[restrictedPolicyName]);
  await attach(value.client, temporaryOu.id, fullAccessId);
  await attach(value.client, restrictedOu.id, fullAccessId);
  await attach(value.client, restrictedOu.id, restrictedPolicyId);
  await keepOnlyDirectPolicies(value.client, temporaryOu.id, new Set());
  await keepOnlyDirectPolicies(value.client, restrictedOu.id, new Set([restrictedPolicyId]));
  const updatedAt = new Date().toISOString();
  await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: value.account.accountId } }, UpdateExpression: "SET temporaryOuId=:temporary, restrictedOuId=:restricted, ouAutomationUpdatedAt=:updated", ExpressionAttributeValues: { ":temporary": { S: temporaryOu.id }, ":restricted": { S: restrictedOu.id }, ":updated": { S: updatedAt } } }));
  return { accountId: value.account.accountId, temporaryOu, restrictedOu, configured: true, updatedAt };
}
async function initialize(accountId) {
  const value = await inspect(accountId);
  const configuration = await configureFromInspection(value);
  const result = await reconcile(accountId);
  return { configuration, result };
}

async function organizationAccounts(client) { const result = []; let NextToken; do { const page = await client.send(new ListAccountsCommand({ NextToken })); result.push(...(page.Accounts || [])); NextToken = page.NextToken; } while (NextToken); return result; }
function parentName(value, parentId) {
  if (parentId === value.rootId) return "未分组";
  if (parentId === value.temporaryOuId) return temporaryName;
  if (parentId === value.restrictedOuId) return restrictedName;
  return value.ous.find((ou) => ou.id === parentId)?.name || "其他 OU";
}

async function recordOperation({ account, mode, status, checked, moved, skipped, message, movedAccounts = [] }) {
  const occurredAt = new Date().toISOString();
  const occurredAtId = `${occurredAt}#${mode}`;
  const expiresAt = Math.floor(Date.now() / 1000) + (2 * 24 * 60 * 60);
  try {
    await dynamodb.send(new PutItemCommand({ TableName: historyTable, Item: {
      payerAccountId: { S: account.accountId },
      occurredAtId: { S: occurredAtId },
      occurredAt: { S: occurredAt },
      payerRemark: { S: account.remark },
      mode: { S: mode },
      status: { S: status },
      checked: { N: String(checked || 0) },
      moved: { N: String(moved || 0) },
      skipped: { N: String(skipped || 0) },
      message: { S: String(message || "").slice(0, 500) },
      movedAccountsJson: { S: JSON.stringify(movedAccounts).slice(0, 300000) },
      expiresAt: { N: String(expiresAt) },
    } }));
    return true;
  } catch (error) {
    console.error("Failed to record OU operation", { payerAccountId: account.accountId, mode, error: error?.message || error });
    return false;
  }
}

async function movementHistory(accountId) {
  const account = await requireAccount(accountId);
  const page = await dynamodb.send(new QueryCommand({ TableName: historyTable, KeyConditionExpression: "payerAccountId = :payer", ExpressionAttributeValues: { ":payer": { S: accountId } }, ScanIndexForward: false, Limit: 300 }));
  const cutoff = Date.now() - (2 * 24 * 60 * 60 * 1000);
  return (page.Items || []).filter((item) => new Date(item.occurredAt?.S || 0).getTime() >= cutoff).map((item) => ({
    payerAccountId: item.payerAccountId?.S || accountId,
    payerRemark: item.payerRemark?.S || account.remark,
    occurredAt: item.occurredAt?.S || "",
    mode: item.mode?.S || "automatic",
    status: item.status?.S || "success",
    checked: Number(item.checked?.N || 0),
    moved: Number(item.moved?.N || 0),
    skipped: Number(item.skipped?.N || 0),
    message: item.message?.S || "",
    movedAccounts: (() => { try { return JSON.parse(item.movedAccountsJson?.S || "[]"); } catch { return []; } })(),
  }));
}
async function memberDirectory(value) {
  const ouNames = new Map(value.ous.map((ou) => [ou.id, ou.name]));
  const members = (await organizationAccounts(value.client)).filter((member) => member.Id && member.Id !== value.managementAccountId && member.Status !== "SUSPENDED" && member.State !== "SUSPENDED");
  const result = [];
  for (const member of members) {
    const parent = (await value.client.send(new ListParentsCommand({ ChildId: member.Id }))).Parents?.[0];
    const parentId = parent?.Id || "";
    result.push(memberDirectoryEntry(value, member, parentId, ouNames));
  }
  return result.sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId.localeCompare(right.accountId));
}

function memberDirectoryEntry(value, member, parentId, ouNames = new Map((value.ous || []).map((ou) => [ou.id, ou.name]))) {
  const placement = parentId === value.temporaryOuId ? "temporary" : parentId === value.restrictedOuId ? "restricted" : parentId === value.rootId ? "ungrouped" : "other";
  return { accountId: member.Id, name: member.Name || member.Id, email: member.Email || "", parentId, parentName: placement === "temporary" ? temporaryName : placement === "restricted" ? restrictedName : placement === "ungrouped" ? "未分组" : ouNames.get(parentId) || "其他 OU", placement };
}

async function saveMemberCache(account, members) {
  const cachedAt = new Date().toISOString();
  const payload = JSON.stringify({ cachedAt, members });
  if (Buffer.byteLength(payload, "utf8") > 350000) return false;
  await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: account.accountId } }, UpdateExpression: "SET ouMemberCache=:cache, ouMemberCacheAt=:cachedAt", ExpressionAttributeValues: { ":cache": { S: payload }, ":cachedAt": { S: cachedAt } } }));
  account.memberCache = { cachedAt, members };
  return true;
}

async function discoverAccount(accountId) {
  const account = await requireAccount(accountId);
  if (account.configured && Array.isArray(account.memberCache?.members)) {
    return { discovery: { account: publicAccount(account), temporaryOu: { id: account.temporaryOuId, name: temporaryName }, restrictedOu: { id: account.restrictedOuId, name: restrictedName }, temporaryOuId: account.temporaryOuId, restrictedOuId: account.restrictedOuId }, members: account.memberCache.members, cached: true, cachedAt: account.memberCache.cachedAt || "" };
  }
  const value = await inspect(accountId);
  const members = await memberDirectory(value);
  await saveMemberCache(value.account, members);
  return { discovery: publicDiscovery(value), members, cached: false, cachedAt: value.account.memberCache?.cachedAt || "" };
}

async function moveMember(body) {
  const value = await inspect(String(body.accountId || ""));
  const memberAccountId = String(body.memberAccountId || "");
  if (!/^\d{12}$/.test(memberAccountId)) fail("成员账号 ID 不正确");
  const destination = String(body.destination || "");
  const destinationParentId = destination === "temporary" ? value.temporaryOuId : destination === "restricted" ? value.restrictedOuId : destination === "ungrouped" ? value.rootId : "";
  if (!destinationParentId) fail("目标 OU 尚未初始化");
  const member = (await organizationAccounts(value.client)).find((item) => item.Id === memberAccountId && item.Id !== value.managementAccountId);
  if (!member) fail("成员账号不属于当前 Organization", 404);
  const sourceParentId = (await value.client.send(new ListParentsCommand({ ChildId: memberAccountId }))).Parents?.[0]?.Id;
  if (!sourceParentId) fail("无法读取成员账号当前 OU");
  let historyRecorded = false;
  if (sourceParentId !== destinationParentId) {
    await value.client.send(new MoveAccountCommand({ AccountId: memberAccountId, SourceParentId: sourceParentId, DestinationParentId: destinationParentId }));
    historyRecorded = await recordOperation({ account: value.account, mode: "manual", status: "success", checked: 1, moved: 1, skipped: 0, message: `手动移动 ${member.Name || member.Id}`, movedAccounts: [{ accountId: member.Id, name: member.Name || member.Id, email: member.Email || "", sourceParentName: parentName(value, sourceParentId), destinationParentName: parentName(value, destinationParentId) }] });
  }
  if (Array.isArray(value.account.memberCache?.members)) {
    const members = value.account.memberCache.members.map((item) => item.accountId === memberAccountId ? memberDirectoryEntry(value, member, destinationParentId) : item);
    await saveMemberCache(value.account, members);
  }
  return { accountId: memberAccountId, destination, moved: sourceParentId !== destinationParentId, historyRecorded };
}
async function recordRun(accountId, status, message) { await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, UpdateExpression: "SET ouAutomationLastRunAt=:runAt, ouAutomationLastStatus=:status, ouAutomationLastMessage=:message", ExpressionAttributeValues: { ":runAt": { S: new Date().toISOString() }, ":status": { S: status }, ":message": { S: String(message || "").slice(0, 500) } } })); }

async function reconcile(accountId) {
  const account = await requireAccount(accountId);
  if (!account.restrictedOuId) fail("请先完成 OU 自动初始化");
  let checked = 0;
  let moved = 0;
  let skipped = 0;
  const movedAccounts = [];
  try {
    const organization = await context(account);
    const members = (await organizationAccounts(organization.client)).filter((member) => member.Id && member.Id !== organization.managementAccountId && member.Status !== "SUSPENDED" && member.State !== "SUSPENDED");
    const movementContext = { ...organization, account, temporaryOuId: account.temporaryOuId, restrictedOuId: account.restrictedOuId, ous: await rootOus(organization.client, organization.rootId) };
    const directory = [];
    checked = members.length;
    for (const member of members) {
      const parentId = (await organization.client.send(new ListParentsCommand({ ChildId: member.Id }))).Parents?.[0]?.Id;
      if (!parentId) fail(`无法读取成员账号 ${member.Id} 的父级`);
      if (parentId === account.restrictedOuId) skipped += 1;
      else {
        await organization.client.send(new MoveAccountCommand({ AccountId: member.Id, SourceParentId: parentId, DestinationParentId: account.restrictedOuId }));
        movedAccounts.push({ accountId: member.Id, name: member.Name || member.Id, email: member.Email || "", sourceParentName: parentName(movementContext, parentId), destinationParentName: restrictedName });
        moved += 1;
      }
      directory.push(memberDirectoryEntry(movementContext, member, account.restrictedOuId));
    }
    await saveMemberCache(account, directory.sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId.localeCompare(right.accountId)));
    const message = `检查 ${members.length} 个成员账号，移动 ${moved} 个，跳过 ${skipped} 个`;
    await recordRun(accountId, "success", message);
    await recordOperation({ account, mode: "automatic", status: "success", checked, moved, skipped, message, movedAccounts });
    return { accountId, checked: members.length, moved, skipped, message };
  } catch (error) {
    const message = error.message || "归位失败";
    await recordRun(accountId, "failed", message);
    await recordOperation({ account, mode: "automatic", status: "failed", checked, moved, skipped, message, movedAccounts });
    throw error;
  }
}

export async function runScheduledOuAutomation() {
  const accounts = await listAccounts();
  const results = [];
  for (const account of accounts) {
    if (!account.configured) {
      const message = "OU 尚未初始化";
      await recordOperation({ account, mode: "automatic", status: "failed", checked: 0, moved: 0, skipped: 0, message });
      results.push({ accountId: account.accountId, skipped: true, error: message });
      continue;
    }
    try { results.push(await reconcile(account.accountId)); } catch (error) { results.push({ accountId: account.accountId, error: error.message || "Reconciliation failed" }); }
  }
  return { accounts: results.length, results };
}

export function isOuAutomationScheduledEvent(event) { return event?.source === "aws.events" && event?.["detail-type"] === "Scheduled Event"; }

export async function handleOuAutomationRequest({ method, body, identity }) {
  if (identity?.role !== "super_admin" && identity?.role !== "admin") fail("Administrator permission required", 403);
  if (method === "GET") return { accounts: await listAccounts(), targetGroups: [...targetGroupNames] };
  if (method !== "POST") fail("Method not allowed", 405);
  if (body.action === "discover") return discoverAccount(String(body.accountId || ""));
  if (body.action === "initialize") return initialize(String(body.accountId || ""));
  if (body.action === "move-member") return { result: await moveMember(body) };
  if (body.action === "history") return { history: await movementHistory(String(body.accountId || "")) };
  if (body.action === "run") return { result: await reconcile(String(body.accountId || "")) };
  if (body.action === "run-all") return runScheduledOuAutomation();
  fail("Invalid OU automation action");
}
