import { DynamoDBClient, GetItemCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AttachPolicyCommand, CreateOrganizationalUnitCommand, CreatePolicyCommand, DescribeOrganizationCommand, DescribePolicyCommand, EnablePolicyTypeCommand, ListAccountsCommand, ListOrganizationalUnitsForParentCommand, ListParentsCommand, ListPoliciesCommand, ListPoliciesForTargetCommand, ListRootsCommand, MoveAccountCommand, OrganizationsClient, UpdatePolicyCommand } from "@aws-sdk/client-organizations";

const dynamodb = new DynamoDBClient({});
const sts = new STSClient({});
const accountsTable = process.env.ACCOUNTS_TABLE;
const groupsTable = process.env.GROUPS_TABLE;
const automationRole = "TontianOrganizationAutomationRole";
const targetGroupNames = new Set((process.env.OU_AUTOMATION_GROUP_NAMES || "CMA架构,老代付架构").split(",").map((name) => name.trim()).filter(Boolean));
const temporaryName = "临时";
const restrictedName = "禁止 SP/RI";
const policyDocuments = {
  "SP/RI-Deny": { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["savingsplans:*", "ec2:PurchaseReservedInstancesOffering", "rds:PurchaseReservedDBInstancesOffering"], Resource: "*" }] },
  Organizations: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["organizations:LeaveOrganization"], Resource: "*" }] },
};

function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function normalized(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN"); }

async function requireAccount(accountId) {
  if (!/^\d{12}$/.test(String(accountId || ""))) fail("Invalid AWS account ID");
  const accountResult = await dynamodb.send(new GetItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, ConsistentRead: true }));
  if (!accountResult.Item) fail("Account does not exist", 404);
  const groupId = accountResult.Item.groupId?.S || "";
  const groupResult = groupId ? await dynamodb.send(new GetItemCommand({ TableName: groupsTable, Key: { groupId: { S: groupId } }, ConsistentRead: true })) : {};
  const groupName = groupResult.Item?.name?.S || "";
  if (!targetGroupNames.has(groupName)) fail("Only CMA架构 and 老代付架构 accounts support OU automation");
  return { accountId, remark: accountResult.Item.remark?.S || accountResult.Item.name?.S || accountId, groupId, groupName, temporaryOuId: accountResult.Item.temporaryOuId?.S || "", restrictedOuId: accountResult.Item.restrictedOuId?.S || "", lastRunAt: accountResult.Item.ouAutomationLastRunAt?.S || "", lastStatus: accountResult.Item.ouAutomationLastStatus?.S || "" };
}

async function listAccounts() {
  const [groups, accounts] = await Promise.all([dynamodb.send(new ScanCommand({ TableName: groupsTable })), dynamodb.send(new ScanCommand({ TableName: accountsTable }))]);
  const targetGroups = new Map((groups.Items || []).filter((item) => item.name?.S && targetGroupNames.has(item.name.S)).map((item) => [item.groupId.S, item.name.S]));
  return (accounts.Items || []).filter((item) => targetGroups.has(item.groupId?.S || "")).map((item) => ({ accountId: item.accountId.S, remark: item.remark?.S || item.name?.S || item.accountId.S, groupName: targetGroups.get(item.groupId?.S || ""), temporaryOuId: item.temporaryOuId?.S || "", restrictedOuId: item.restrictedOuId?.S || "", configured: Boolean(item.temporaryOuId?.S && item.restrictedOuId?.S), lastRunAt: item.ouAutomationLastRunAt?.S || "", lastStatus: item.ouAutomationLastStatus?.S || "" })).sort((a, b) => a.groupName.localeCompare(b.groupName, "zh-CN") || a.remark.localeCompare(b.remark, "zh-CN"));
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
  const ids = new Set(ous.map((ou) => ou.id));
  const exact = (name) => ous.find((ou) => normalized(ou.name) === normalized(name))?.id || "";
  return { ...organization, account, ous, temporaryOuId: (ids.has(account.temporaryOuId) ? account.temporaryOuId : "") || exact(temporaryName), restrictedOuId: (ids.has(account.restrictedOuId) ? account.restrictedOuId : "") || exact(restrictedName) };
}

function publicDiscovery(value) { return { account: value.account, ous: value.ous, temporaryOuId: value.temporaryOuId, restrictedOuId: value.restrictedOuId }; }

async function resolveOu(client, rootId, ous, selectedId, name) {
  if (selectedId) return ous.find((ou) => ou.id === selectedId) || fail(`选择的 ${name} OU 不存在或不在 Root 下`);
  const exact = ous.find((ou) => normalized(ou.name) === normalized(name));
  if (exact) return exact;
  const created = (await client.send(new CreateOrganizationalUnitCommand({ ParentId: rootId, Name: name }))).OrganizationalUnit;
  return { id: created.Id, name: created.Name };
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
  else if (canonical((await client.send(new DescribePolicyCommand({ PolicyId: summary.Id }))).Policy?.Content) !== canonical(content)) await client.send(new UpdatePolicyCommand({ PolicyId: summary.Id, Content: content, Description: `Managed by NEXUS: ${name}`, Name: name }));
  if (!summary?.Id) fail(`无法创建或读取 SCP：${name}`);
  return summary.Id;
}

async function attach(client, targetId, policyId) {
  const policies = [];
  let NextToken;
  do { const page = await client.send(new ListPoliciesForTargetCommand({ TargetId: targetId, Filter: "SERVICE_CONTROL_POLICY", NextToken })); policies.push(...(page.Policies || [])); NextToken = page.NextToken; } while (NextToken);
  if (!policies.some((policy) => policy.Id === policyId)) await client.send(new AttachPolicyCommand({ PolicyId: policyId, TargetId: targetId }));
}

async function configureFromInspection(value, body) {
  const temporaryOu = await resolveOu(value.client, value.rootId, value.ous, String(body.temporaryOuId || ""), temporaryName);
  const ous = value.ous.some((ou) => ou.id === temporaryOu.id) ? value.ous : [...value.ous, temporaryOu];
  const restrictedOu = await resolveOu(value.client, value.rootId, ous, String(body.restrictedOuId || ""), restrictedName);
  if (temporaryOu.id === restrictedOu.id) fail("临时和禁止 SP/RI 必须对应两个不同的 OU");
  const policies = await listScps(value.client, value.rootId);
  const fullAccessId = policies.find((policy) => policy.Name === "FullAWSAccess")?.Id;
  const spRiId = await ensureScp(value.client, policies, "SP/RI-Deny", policyDocuments["SP/RI-Deny"]);
  const organizationsId = await ensureScp(value.client, policies, "Organizations", policyDocuments.Organizations);
  if (fullAccessId) { await attach(value.client, temporaryOu.id, fullAccessId); await attach(value.client, restrictedOu.id, fullAccessId); }
  await attach(value.client, restrictedOu.id, spRiId);
  await attach(value.client, restrictedOu.id, organizationsId);
  const updatedAt = new Date().toISOString();
  await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: value.account.accountId } }, UpdateExpression: "SET temporaryOuId=:temporary, restrictedOuId=:restricted, ouAutomationUpdatedAt=:updated", ExpressionAttributeValues: { ":temporary": { S: temporaryOu.id }, ":restricted": { S: restrictedOu.id }, ":updated": { S: updatedAt } } }));
  return { accountId: value.account.accountId, temporaryOu, restrictedOu, configured: true, updatedAt };
}

async function configure(body) { const value = await inspect(String(body.accountId || "")); return configureFromInspection(value, body); }

async function initialize(accountId) {
  const value = await inspect(accountId);
  const selected = new Set([value.temporaryOuId, value.restrictedOuId].filter(Boolean));
  const unmatched = value.ous.filter((ou) => !selected.has(ou.id));
  if ((!value.temporaryOuId || !value.restrictedOuId) && unmatched.length) return { mappingRequired: true, discovery: publicDiscovery(value) };
  return { mappingRequired: false, configuration: await configureFromInspection(value, { temporaryOuId: value.temporaryOuId, restrictedOuId: value.restrictedOuId }) };
}

async function organizationAccounts(client) { const result = []; let NextToken; do { const page = await client.send(new ListAccountsCommand({ NextToken })); result.push(...(page.Accounts || [])); NextToken = page.NextToken; } while (NextToken); return result; }
async function recordRun(accountId, status, message) { await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, UpdateExpression: "SET ouAutomationLastRunAt=:runAt, ouAutomationLastStatus=:status, ouAutomationLastMessage=:message", ExpressionAttributeValues: { ":runAt": { S: new Date().toISOString() }, ":status": { S: status }, ":message": { S: String(message || "").slice(0, 500) } } })); }

async function reconcile(accountId) {
  const account = await requireAccount(accountId);
  if (!account.restrictedOuId) fail("请先完成 OU 映射");
  try {
    const organization = await context(account);
    const members = (await organizationAccounts(organization.client)).filter((member) => member.Id && member.Id !== organization.managementAccountId && member.Status !== "SUSPENDED" && member.State !== "SUSPENDED");
    let moved = 0;
    let skipped = 0;
    for (const member of members) {
      const parentId = (await organization.client.send(new ListParentsCommand({ ChildId: member.Id }))).Parents?.[0]?.Id;
      if (!parentId) fail(`无法读取成员账号 ${member.Id} 的父级`);
      if (parentId === account.restrictedOuId) { skipped += 1; continue; }
      await organization.client.send(new MoveAccountCommand({ AccountId: member.Id, SourceParentId: parentId, DestinationParentId: account.restrictedOuId }));
      moved += 1;
    }
    const message = `检查 ${members.length} 个成员账号，移动 ${moved} 个，跳过 ${skipped} 个`;
    await recordRun(accountId, "success", message);
    return { accountId, checked: members.length, moved, skipped, message };
  } catch (error) { await recordRun(accountId, "failed", error.message || "归位失败"); throw error; }
}

export async function runScheduledOuAutomation() {
  const accounts = await listAccounts();
  const results = [];
  for (const account of accounts) {
    if (!account.configured) { results.push({ accountId: account.accountId, skipped: true, error: "OU mapping is not configured" }); continue; }
    try { results.push(await reconcile(account.accountId)); } catch (error) { results.push({ accountId: account.accountId, error: error.message || "Reconciliation failed" }); }
  }
  return { accounts: results.length, results };
}

export function isOuAutomationScheduledEvent(event) { return event?.source === "aws.events" && event?.["detail-type"] === "Scheduled Event"; }

export async function handleOuAutomationRequest({ method, body, identity }) {
  if (identity?.role !== "super_admin" && identity?.role !== "admin") fail("Administrator permission required", 403);
  if (method === "GET") return { accounts: await listAccounts(), targetGroups: [...targetGroupNames] };
  if (method !== "POST") fail("Method not allowed", 405);
  if (body.action === "discover") return { discovery: publicDiscovery(await inspect(String(body.accountId || ""))) };
  if (body.action === "initialize") return initialize(String(body.accountId || ""));
  if (body.action === "configure") return { configuration: await configure(body) };
  if (body.action === "run") return { result: await reconcile(String(body.accountId || "")) };
  if (body.action === "run-all") return runScheduledOuAutomation();
  fail("Invalid OU automation action");
}
