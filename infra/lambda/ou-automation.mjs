import { DynamoDBClient, GetItemCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AttachPolicyCommand, CreateOrganizationalUnitCommand, CreatePolicyCommand, DescribeOrganizationCommand, DescribePolicyCommand, EnablePolicyTypeCommand, ListAccountsCommand, ListOrganizationalUnitsForParentCommand, ListParentsCommand, ListPoliciesCommand, ListPoliciesForTargetCommand, ListRootsCommand, MoveAccountCommand, OrganizationsClient, UpdatePolicyCommand } from "@aws-sdk/client-organizations";

const dynamodb = new DynamoDBClient({});
const sts = new STSClient({});
const accountsTable = process.env.ACCOUNTS_TABLE;
const groupsTable = process.env.GROUPS_TABLE;
const automationRole = "TontianOrganizationAutomationRole";
const targetGroupNames = new Set((process.env.OU_AUTOMATION_GROUP_NAMES || "CMA组,老代付组").split(",").map((name) => name.trim()).filter(Boolean));
const temporaryName = "临时";
const restrictedName = "禁止 SP/RI";
const policyDocuments = {
  "SP/RI-Deny": { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["savingsplans:*", "ec2:PurchaseReservedInstancesOffering", "rds:PurchaseReservedDBInstancesOffering"], Resource: "*" }] },
  Organizations: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["organizations:LeaveOrganization"], Resource: "*" }] },
};

function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function normalized(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN"); }
function compactName(value) { return normalized(value).replace(/[^\p{L}\p{N}]+/gu, ""); }

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function similarNameScore(value, target, kind) {
  const name = compactName(value);
  const expected = compactName(target);
  if (name === expected) return 100;
  if (name.includes(expected) || expected.includes(name)) return 90;
  if (kind === "temporary" && ["临时", "暂时", "temporary", "temp"].some((alias) => name.includes(alias))) return 75;
  if (kind === "restricted" && ((name.includes("spri") && ["禁止", "禁用", "deny", "block", "no"].some((alias) => name.includes(alias))) || ((name.includes("预留") || name.includes("节省计划")) && (name.includes("禁止") || name.includes("禁用"))))) return 75;
  const distance = editDistance(name, expected);
  return distance <= Math.max(2, Math.floor(expected.length * 0.3)) ? 60 : 0;
}

async function requireAccount(accountId) {
  if (!/^\d{12}$/.test(String(accountId || ""))) fail("Invalid AWS account ID");
  const accountResult = await dynamodb.send(new GetItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, ConsistentRead: true }));
  if (!accountResult.Item) fail("Account does not exist", 404);
  const groupId = accountResult.Item.groupId?.S || "";
  const groupResult = groupId ? await dynamodb.send(new GetItemCommand({ TableName: groupsTable, Key: { groupId: { S: groupId } }, ConsistentRead: true })) : {};
  const groupName = groupResult.Item?.name?.S || "";
  if (!targetGroupNames.has(groupName)) fail("Only CMA组 and 老代付组 accounts support OU automation");
  const temporaryOuId = accountResult.Item.temporaryOuId?.S || "";
  const restrictedOuId = accountResult.Item.restrictedOuId?.S || "";
  return { accountId, remark: accountResult.Item.remark?.S || accountResult.Item.name?.S || accountId, groupId, groupName, temporaryOuId, restrictedOuId, configured: Boolean(temporaryOuId && restrictedOuId), lastRunAt: accountResult.Item.ouAutomationLastRunAt?.S || "", lastStatus: accountResult.Item.ouAutomationLastStatus?.S || "" };
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
  const temporaryOu = await detectExistingOu(organization.client, ous, account.temporaryOuId, temporaryName, "temporary");
  const restrictedOu = await detectExistingOu(organization.client, ous, account.restrictedOuId, restrictedName, "restricted");
  return { ...organization, account, ous, temporaryOu, restrictedOu, temporaryOuId: temporaryOu?.id || "", restrictedOuId: restrictedOu?.id || "" };
}

function confirmationItems(value) {
  return [
    { kind: "temporary", targetName: temporaryName, detected: value.temporaryOu },
    { kind: "restricted", targetName: restrictedName, detected: value.restrictedOu },
  ].flatMap((item) => {
    if (!item.detected) return [{ kind: item.kind, action: "create", targetName: item.targetName }];
    if (item.detected.match === "compatible") return [{ kind: item.kind, action: "reuse", targetName: item.targetName, candidate: item.detected }];
    return [];
  });
}

function publicDiscovery(value) { return { account: value.account, temporaryOu: value.temporaryOu || null, restrictedOu: value.restrictedOu || null, temporaryOuId: value.temporaryOuId, restrictedOuId: value.restrictedOuId, confirmations: confirmationItems(value) }; }

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

function policyDocument(content) {
  try { return JSON.parse(content); } catch {}
  try { return JSON.parse(decodeURIComponent(content)); } catch {}
  return null;
}

function sameSet(left, right) { return left.size === right.size && [...left].every((value) => right.has(value)); }

async function ouPolicyProfile(client, targetId) {
  const attached = [];
  let NextToken;
  do { const page = await client.send(new ListPoliciesForTargetCommand({ TargetId: targetId, Filter: "SERVICE_CONTROL_POLICY", NextToken })); attached.push(...(page.Policies || [])); NextToken = page.NextToken; } while (NextToken);
  const denyActions = new Set();
  let compatible = true;
  let customPolicies = 0;
  for (const policy of attached) {
    if (policy.AwsManaged && policy.Name === "FullAWSAccess") continue;
    customPolicies += 1;
    const document = policy.Id ? policyDocument((await client.send(new DescribePolicyCommand({ PolicyId: policy.Id }))).Policy?.Content) : null;
    const statements = Array.isArray(document?.Statement) ? document.Statement : document?.Statement ? [document.Statement] : [];
    if (!statements.length) { compatible = false; continue; }
    for (const statement of statements) {
      const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (statement.Effect !== "Deny" || statement.NotAction || statement.Condition || resources.length !== 1 || resources[0] !== "*" || actions.some((action) => typeof action !== "string")) { compatible = false; continue; }
      for (const action of actions) denyActions.add(action.toLocaleLowerCase("en-US"));
    }
  }
  return { fullAccess: attached.some((policy) => policy.AwsManaged && policy.Name === "FullAWSAccess"), customPolicies, compatible, denyActions };
}

async function detectExistingOu(client, ous, storedId, targetName, kind) {
  const stored = storedId ? ous.find((ou) => ou.id === storedId) : null;
  if (stored) return { ...stored, match: "saved" };
  const exact = ous.find((ou) => normalized(ou.name) === normalized(targetName));
  if (exact) return { ...exact, match: "exact" };
  const requiredActions = new Set(kind === "restricted"
    ? ["savingsplans:*", "ec2:purchasereservedinstancesoffering", "rds:purchasereserveddbinstancesoffering", "organizations:leaveorganization"]
    : []);
  const candidates = [];
  for (const ou of ous) {
    const score = similarNameScore(ou.name, targetName, kind);
    if (!score) continue;
    const profile = await ouPolicyProfile(client, ou.id);
    const samePermissions = kind === "temporary"
      ? profile.fullAccess && profile.customPolicies === 0
      : profile.fullAccess && profile.compatible && sameSet(profile.denyActions, requiredActions);
    if (samePermissions) candidates.push({ ...ou, match: "compatible", score });
  }
  candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "zh-CN"));
  if (!candidates[0] || (candidates[1] && candidates[0].score === candidates[1].score)) return null;
  return { id: candidates[0].id, name: candidates[0].name, match: candidates[0].match };
}

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

async function configureFromInspection(value, useCompatible = true) {
  const temporaryDetected = value.temporaryOu?.match === "compatible" && !useCompatible ? null : value.temporaryOu;
  const restrictedDetected = value.restrictedOu?.match === "compatible" && !useCompatible ? null : value.restrictedOu;
  const temporaryOu = await resolveOu(value.client, value.rootId, temporaryDetected, temporaryName);
  const restrictedOu = await resolveOu(value.client, value.rootId, restrictedDetected, restrictedName);
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

async function configure(body) { const value = await inspect(String(body.accountId || "")); return configureFromInspection(value, body.useCompatible !== false); }

async function initialize(accountId, options = {}) {
  const value = await inspect(accountId);
  const confirmations = confirmationItems(value);
  if (confirmations.length && !options.confirmed) return { confirmationRequired: true, confirmations, discovery: publicDiscovery(value) };
  return { confirmationRequired: false, configuration: await configureFromInspection(value, options.useCompatible !== false) };
}

async function organizationAccounts(client) { const result = []; let NextToken; do { const page = await client.send(new ListAccountsCommand({ NextToken })); result.push(...(page.Accounts || [])); NextToken = page.NextToken; } while (NextToken); return result; }
async function memberDirectory(value) {
  const ouNames = new Map(value.ous.map((ou) => [ou.id, ou.name]));
  const members = (await organizationAccounts(value.client)).filter((member) => member.Id && member.Id !== value.managementAccountId && member.Status !== "SUSPENDED" && member.State !== "SUSPENDED");
  const result = [];
  for (const member of members) {
    const parent = (await value.client.send(new ListParentsCommand({ ChildId: member.Id }))).Parents?.[0];
    const parentId = parent?.Id || "";
    const placement = parentId === value.temporaryOuId ? "temporary" : parentId === value.restrictedOuId ? "restricted" : parentId === value.rootId ? "ungrouped" : "other";
    result.push({ accountId: member.Id, name: member.Name || member.Id, email: member.Email || "", parentId, parentName: placement === "temporary" ? temporaryName : placement === "restricted" ? restrictedName : placement === "ungrouped" ? "未分组" : ouNames.get(parentId) || "其他 OU", placement });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.accountId.localeCompare(right.accountId));
}

async function discoverAccount(accountId) {
  const value = await inspect(accountId);
  return { discovery: publicDiscovery(value), members: await memberDirectory(value) };
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
  if (sourceParentId !== destinationParentId) await value.client.send(new MoveAccountCommand({ AccountId: memberAccountId, SourceParentId: sourceParentId, DestinationParentId: destinationParentId }));
  return { accountId: memberAccountId, destination, moved: sourceParentId !== destinationParentId };
}
async function recordRun(accountId, status, message) { await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, UpdateExpression: "SET ouAutomationLastRunAt=:runAt, ouAutomationLastStatus=:status, ouAutomationLastMessage=:message", ExpressionAttributeValues: { ":runAt": { S: new Date().toISOString() }, ":status": { S: status }, ":message": { S: String(message || "").slice(0, 500) } } })); }

async function reconcile(accountId) {
  const account = await requireAccount(accountId);
  if (!account.restrictedOuId) fail("请先完成 OU 自动初始化");
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
    try { if (!account.configured) await initialize(account.accountId); results.push(await reconcile(account.accountId)); } catch (error) { results.push({ accountId: account.accountId, error: error.message || "Reconciliation failed" }); }
  }
  return { accounts: results.length, results };
}

export function isOuAutomationScheduledEvent(event) { return event?.source === "aws.events" && event?.["detail-type"] === "Scheduled Event"; }

export async function handleOuAutomationRequest({ method, body, identity }) {
  if (identity?.role !== "super_admin" && identity?.role !== "admin") fail("Administrator permission required", 403);
  if (method === "GET") return { accounts: await listAccounts(), targetGroups: [...targetGroupNames] };
  if (method !== "POST") fail("Method not allowed", 405);
  if (body.action === "discover") return discoverAccount(String(body.accountId || ""));
  if (body.action === "initialize") return initialize(String(body.accountId || ""), { confirmed: body.confirmed === true, useCompatible: body.useCompatible !== false });
  if (body.action === "configure") return { configuration: await configure(body) };
  if (body.action === "move-member") return { result: await moveMember(body) };
  if (body.action === "run") return { result: await reconcile(String(body.accountId || "")) };
  if (body.action === "run-all") return runScheduledOuAutomation();
  fail("Invalid OU automation action");
}
