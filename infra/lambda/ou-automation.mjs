import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AttachPolicyCommand, CreateOrganizationalUnitCommand, CreatePolicyCommand, DeletePolicyCommand, DescribeOrganizationCommand, DescribePolicyCommand, DetachPolicyCommand, EnablePolicyTypeCommand, ListAccountsCommand, ListOrganizationalUnitsForParentCommand, ListParentsCommand, ListPoliciesCommand, ListPoliciesForTargetCommand, ListRootsCommand, ListTargetsForPolicyCommand, MoveAccountCommand, OrganizationsClient, UpdatePolicyCommand } from "@aws-sdk/client-organizations";

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
const obsoletePolicyName = "DenyLeaveAndCloseAccount";
const guardrailCacheVersion = "direct-account-v1";
const policyDocuments = {
  [restrictedPolicyName]: { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: ["savingsplans:CreateSavingsPlan", "ec2:PurchaseReservedInstancesOffering", "rds:PurchaseReservedDBInstancesOffering", "organizations:LeaveOrganization", "account:CloseAccount"], Resource: "*" }] },
};

function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function normalized(value) { return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN"); }
function canonicalGroupName(name) { return name === "CMA组" ? "PMA" : name; }
function itemAccountType(item, groupName) { return item.accountType?.S || (pmaGroupNames.has(groupName) ? "cma" : ""); }
function supportsOu(item, groupName) { return groupName === "老代付组" || (pmaGroupNames.has(groupName) && itemAccountType(item, groupName) === "cma"); }
function parseJson(value, fallback) { try { return JSON.parse(value || ""); } catch { return fallback; } }

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
  const memberCache = parseJson(accountResult.Item.guardrailMemberCache?.S || accountResult.Item.ouMemberCache?.S, null);
  const restrictionExemptions = parseJson(accountResult.Item.guardrailExemptions?.S || accountResult.Item.cloudSweepRestrictionExemptions?.S, {});
  return { accountId, remark: accountResult.Item.remark?.S || accountResult.Item.name?.S || accountId, groupId, groupName: canonicalGroupName(groupName), accountType, temporaryOuId, restrictedOuId, configured: Boolean(temporaryOuId && restrictedOuId), lastRunAt: accountResult.Item.ouAutomationLastRunAt?.S || "", lastStatus: accountResult.Item.ouAutomationLastStatus?.S || "", memberCache, restrictionExemptions, cloudSweepRestrictionExemptions: restrictionExemptions };
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
  const parents = [{ id: rootId, path: "" }];
  for (let index = 0; index < parents.length; index += 1) {
    const parent = parents[index];
    let NextToken;
    do {
      const page = await client.send(new ListOrganizationalUnitsForParentCommand({ ParentId: parent.id, NextToken }));
      for (const ou of page.OrganizationalUnits || []) {
        if (!ou.Id || !ou.Name) continue;
        const path = parent.path ? `${parent.path} / ${ou.Name}` : ou.Name;
        result.push({ id: ou.Id, name: ou.Name, parentId: parent.id, path });
        parents.push({ id: ou.Id, path });
      }
      NextToken = page.NextToken;
    } while (NextToken);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, "zh-CN") || a.id.localeCompare(b.id));
}

async function inspect(accountId) {
  const account = await requireAccount(accountId);
  const organization = await context(account);
  const ous = await rootOus(organization.client, organization.rootId);
  const temporaryMatches = ous.filter((ou) => normalized(ou.name) === normalized(temporaryName));
  const restrictedMatches = ous.filter((ou) => normalized(ou.name) === normalized(restrictedName));
  const temporaryOu = ous.find((ou) => ou.id === account.temporaryOuId) || (temporaryMatches.length === 1 ? temporaryMatches[0] : null);
  const restrictedOu = ous.find((ou) => ou.id === account.restrictedOuId) || (restrictedMatches.length === 1 ? restrictedMatches[0] : null);
  return { ...organization, account, ous, temporaryOu, restrictedOu, temporaryOuId: temporaryOu?.id || "", restrictedOuId: restrictedOu?.id || "" };
}

function publicAccount(account) { const value = { ...account }; delete value.memberCache; delete value.restrictionExemptions; delete value.cloudSweepRestrictionExemptions; return value; }
function publicDiscovery(value) { return { account: publicAccount(value.account), ous: value.ous || [], temporaryOu: value.temporaryOu || null, restrictedOu: value.restrictedOu || null, temporaryOuId: value.temporaryOuId, restrictedOuId: value.restrictedOuId }; }

async function resolveOu(value, selectedId, name, allowCreate) {
  if (selectedId) {
    const selected = value.ous.find((ou) => ou.id === selectedId);
    if (!selected) fail(`选择的“${name}”OU 不存在，请重新扫描`);
    return selected;
  }
  const matches = value.ous.filter((ou) => normalized(ou.name) === normalized(name));
  if (matches.length > 1) fail(`检测到多个“${name}”OU，请按 OU ID 明确选择`);
  if (matches.length === 1) return matches[0];
  if (!allowCreate) fail(`没有找到“${name}”OU，请明确选择是否创建`);
  const created = (await value.client.send(new CreateOrganizationalUnitCommand({ ParentId: value.rootId, Name: name }))).OrganizationalUnit;
  return { id: created.Id, name: created.Name, match: "created" };
}


async function readScps(client) {
  const result = [];
  let NextToken;
  do { const page = await client.send(new ListPoliciesCommand({ Filter: "SERVICE_CONTROL_POLICY", NextToken })); result.push(...(page.Policies || [])); NextToken = page.NextToken; } while (NextToken);
  return result;
}

async function listScps(client, rootId) {
  let result = [];
  try { result = await readScps(client); }
  catch (error) { if (error?.name !== "PolicyTypeNotEnabledException") throw error; }
  if (result.some((policy) => policy.Name === "FullAWSAccess")) return result;

  try { await client.send(new EnablePolicyTypeCommand({ RootId: rootId, PolicyType: "SERVICE_CONTROL_POLICY" })); }
  catch (error) {
    if (error?.name !== "DuplicatePolicyTypeAttachmentException") {
      if (String(error?.message || "").includes("cannot enable the specified policy type")) fail("该 Organization 未开启“所有功能”，AWS 不允许使用 SCP");
      throw error;
    }
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    try { result = await readScps(client); }
    catch (error) { if (error?.name !== "PolicyTypeNotEnabledException") throw error; }
    if (result.some((policy) => policy.Name === "FullAWSAccess")) return result;
  }
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

async function policyTargets(client, policyId) {
  const targets = [];
  let NextToken;
  do { const page = await client.send(new ListTargetsForPolicyCommand({ PolicyId: policyId, NextToken })); targets.push(...(page.Targets || [])); NextToken = page.NextToken; } while (NextToken);
  return targets;
}

async function detachFromEverywhereExcept(client, policyId, keepTargetId = "") {
  for (const target of await policyTargets(client, policyId)) if (target.TargetId && target.TargetId !== keepTargetId) await client.send(new DetachPolicyCommand({ PolicyId: policyId, TargetId: target.TargetId }));
}

async function removeObsoletePolicies(client, policies) {
  for (const policy of policies.filter((item) => item.Name === obsoletePolicyName && !item.AwsManaged && item.Id)) {
    await detachFromEverywhereExcept(client, policy.Id);
    await client.send(new DeletePolicyCommand({ PolicyId: policy.Id }));
  }
}

async function configureFromInspection(value, mapping = {}) {
  const temporaryOu = await resolveOu(value, String(mapping.temporaryOuId || ""), temporaryName, mapping.createTemporary === true);
  const restrictedOu = await resolveOu(value, String(mapping.restrictedOuId || ""), restrictedName, mapping.createRestricted === true);
  if (temporaryOu.id === restrictedOu.id) fail("临时和禁止 SP/RI 必须对应两个不同的 OU");
  const policies = await listScps(value.client, value.rootId);
  const fullAccessId = policies.find((policy) => policy.Name === "FullAWSAccess")?.Id;
  if (!fullAccessId) fail("无法读取 AWS 托管策略 FullAWSAccess");
  const restrictedPolicyId = await ensureScp(value.client, policies, restrictedPolicyName, policyDocuments[restrictedPolicyName]);
  await attach(value.client, temporaryOu.id, fullAccessId);
  await attach(value.client, restrictedOu.id, fullAccessId);
  if (!restrictedPolicyId) fail("无法读取客户限制策略");
  await removeObsoletePolicies(value.client, policies);
  const updatedAt = new Date().toISOString();
  await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: value.account.accountId } }, UpdateExpression: "SET temporaryOuId=:temporary, restrictedOuId=:restricted, ouAutomationUpdatedAt=:updated", ExpressionAttributeValues: { ":temporary": { S: temporaryOu.id }, ":restricted": { S: restrictedOu.id }, ":updated": { S: updatedAt } } }));
  return { accountId: value.account.accountId, temporaryOu, restrictedOu, configured: true, updatedAt };
}
async function initialize(body) {
  const value = await inspect(String(body.accountId || ""));
  const configuration = await configureFromInspection(value, body);
  value.account.temporaryOuId = configuration.temporaryOu.id;
  value.account.restrictedOuId = configuration.restrictedOu.id;
  value.account.configured = true;
  value.temporaryOu = configuration.temporaryOu;
  value.restrictedOu = configuration.restrictedOu;
  value.temporaryOuId = configuration.temporaryOu.id;
  value.restrictedOuId = configuration.restrictedOu.id;
  return { configuration, discovery: publicDiscovery(value), members: value.account.memberCache?.members || [] };
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

async function movementHistory(accountId = "") {
  const availableAccounts = await listAccounts();
  const accounts = accountId ? availableAccounts.filter((account) => account.accountId === accountId) : availableAccounts;
  if (accountId && accounts.length === 0) fail("该账号不支持 OU 自动归位", 404);
  const remarks = new Map(accounts.map((account) => [account.accountId, account.remark]));
  const items = [];
  for (const account of accounts) {
    let ExclusiveStartKey;
    do {
      const page = await dynamodb.send(new QueryCommand({ TableName: historyTable, KeyConditionExpression: "payerAccountId = :payer", ExpressionAttributeValues: { ":payer": { S: account.accountId } }, ScanIndexForward: false, ExclusiveStartKey }));
      items.push(...(page.Items || []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  const cutoff = Date.now() - (2 * 24 * 60 * 60 * 1000);
  return items.filter((item) => new Date(item.occurredAt?.S || 0).getTime() >= cutoff).map((item) => ({
    payerAccountId: item.payerAccountId?.S || "",
    payerRemark: item.payerRemark?.S || remarks.get(item.payerAccountId?.S || "") || item.payerAccountId?.S || "未知代付",
    occurredAt: item.occurredAt?.S || "",
    mode: item.mode?.S || "automatic",
    status: item.status?.S || "success",
    checked: Number(item.checked?.N || 0),
    moved: Number(item.moved?.N || 0),
    skipped: Number(item.skipped?.N || 0),
    message: item.message?.S || "",
    movedAccounts: (() => { try { return JSON.parse(item.movedAccountsJson?.S || "[]"); } catch { return []; } })(),
  })).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 500);
}
async function saveMemberCache(account, members) {
  const cachedAt = new Date().toISOString();
  const payload = JSON.stringify({ version: guardrailCacheVersion, cachedAt, members });
  if (Buffer.byteLength(payload, "utf8") > 350000) return false;
  await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: account.accountId } }, UpdateExpression: "SET guardrailMemberCache=:cache, guardrailMemberCacheAt=:cachedAt", ExpressionAttributeValues: { ":cache": { S: payload }, ":cachedAt": { S: cachedAt } } }));
  account.memberCache = { version: guardrailCacheVersion, cachedAt, members };
  return true;
}

async function organizationMembers(client, managementAccountId) {
  const result = [];
  let NextToken;
  do {
    const page = await client.send(new ListAccountsCommand({ NextToken }));
    for (const member of page.Accounts || []) {
      if (!member.Id || member.Id === managementAccountId || member.Status === "SUSPENDED" || member.State === "SUSPENDED") continue;
      result.push(member);
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return result.sort((left, right) => String(left.Name || left.Id).localeCompare(String(right.Name || right.Id), "zh-CN") || left.Id.localeCompare(right.Id));
}

function publicGuardrailMember(member, directTargetIds, exemptions) {
  const exempt = Boolean(exemptions?.[member.Id]);
  const restricted = directTargetIds.has(member.Id) && !exempt;
  return {
    accountId: member.Id,
    name: member.Name || member.Id,
    email: member.Email || "",
    restrictionStatus: exempt ? "exempt" : restricted ? "restricted" : "missing",
    restricted,
    exempt,
  };
}

async function guardrailDiscovery(account, { force = false } = {}) {
  if (!force && account.memberCache?.version === guardrailCacheVersion && Array.isArray(account.memberCache.members)) {
    return { discovery: { account: publicAccount(account), policyName: restrictedPolicyName }, members: account.memberCache.members, cached: true, cachedAt: account.memberCache.cachedAt || "" };
  }
  const organization = await context(account);
  let policies = [];
  try { policies = await readScps(organization.client); }
  catch (error) { if (error?.name !== "PolicyTypeNotEnabledException") throw error; }
  const policy = policies.find((item) => item.Name === restrictedPolicyName && !item.AwsManaged);
  const targets = policy?.Id ? await policyTargets(organization.client, policy.Id) : [];
  const directTargetIds = new Set(targets.filter((target) => target.Type === "ACCOUNT" && target.TargetId).map((target) => target.TargetId));
  const members = (await organizationMembers(organization.client, organization.managementAccountId)).map((member) => publicGuardrailMember(member, directTargetIds, account.restrictionExemptions));
  await saveMemberCache(account, members);
  return { discovery: { account: publicAccount(account), policyName: restrictedPolicyName, policyId: policy?.Id || "" }, members, cached: false, cachedAt: account.memberCache?.cachedAt || "" };
}

async function discoverAccount(accountId, options = {}) {
  const account = await requireAccount(accountId);
  return guardrailDiscovery(account, options);
}

async function recordRun(accountId, status, message) { await dynamodb.send(new UpdateItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, UpdateExpression: "SET ouAutomationLastRunAt=:runAt, ouAutomationLastStatus=:status, ouAutomationLastMessage=:message", ExpressionAttributeValues: { ":runAt": { S: new Date().toISOString() }, ":status": { S: status }, ":message": { S: String(message || "").slice(0, 500) } } })); }

async function syncDirectGuardrails(account) {
  const organization = await context(account);
  const policies = await listScps(organization.client, organization.rootId);
  const policyId = await ensureScp(organization.client, policies, restrictedPolicyName, policyDocuments[restrictedPolicyName]);
  const members = await organizationMembers(organization.client, organization.managementAccountId);
  const targets = await policyTargets(organization.client, policyId);
  const directTargetIds = new Set(targets.filter((target) => target.Type === "ACCOUNT" && target.TargetId).map((target) => target.TargetId));
  const changedAccounts = [];
  let added = 0;
  let removed = 0;
  let already = 0;
  let exempt = 0;

  for (const member of members) {
    const isExempt = Boolean(account.restrictionExemptions?.[member.Id]);
    const isAttached = directTargetIds.has(member.Id);
    if (isExempt) {
      exempt += 1;
      if (isAttached) {
        await organization.client.send(new DetachPolicyCommand({ PolicyId: policyId, TargetId: member.Id }));
        directTargetIds.delete(member.Id);
        removed += 1;
        changedAccounts.push({ accountId: member.Id, name: member.Name || member.Id, email: member.Email || "", sourceParentName: "已限制", destinationParentName: "已取消" });
      }
      continue;
    }
    if (isAttached) { already += 1; continue; }
    try { await organization.client.send(new AttachPolicyCommand({ PolicyId: policyId, TargetId: member.Id })); }
    catch (error) { if (error?.name !== "DuplicatePolicyAttachmentException") throw error; }
    directTargetIds.add(member.Id);
    added += 1;
    changedAccounts.push({ accountId: member.Id, name: member.Name || member.Id, email: member.Email || "", sourceParentName: "未限制", destinationParentName: "已限制" });
  }

  for (const target of targets) {
    if (!target.TargetId || target.Type === "ACCOUNT") continue;
    await organization.client.send(new DetachPolicyCommand({ PolicyId: policyId, TargetId: target.TargetId }));
  }
  await removeObsoletePolicies(organization.client, policies);

  const directory = members.map((member) => publicGuardrailMember(member, directTargetIds, account.restrictionExemptions));
  await saveMemberCache(account, directory);
  return { accountId: account.accountId, checked: members.length, added, removed, already, exempt, moved: added + removed, skipped: already + exempt, members: directory, changedAccounts, policyId };
}

async function reconcile(accountId, { mode = "automatic" } = {}) {
  const account = await requireAccount(accountId);
  try {
    const result = await syncDirectGuardrails(account);
    const message = `检查 ${result.checked} 个客户，新增限制 ${result.added} 个，已限制 ${result.already} 个，已取消 ${result.exempt} 个`;
    await recordRun(accountId, "success", message);
    await recordOperation({ account, mode, status: "success", checked: result.checked, moved: result.moved, skipped: result.skipped, message, movedAccounts: result.changedAccounts });
    return { ...result, message };
  } catch (error) {
    const message = error.message || "客户限制同步失败";
    await recordRun(accountId, "failed", message);
    await recordOperation({ account, mode, status: "failed", checked: 0, moved: 0, skipped: 0, message, movedAccounts: [] });
    throw error;
  }
}

async function setMemberRestriction(body) {
  if (body.confirmed !== true) fail("必须明确确认后才能修改客户限制");
  const accountId = String(body.accountId || "");
  const memberAccountId = String(body.memberAccountId || "");
  const enabled = body.enabled === true;
  if (!/^\d{12}$/.test(memberAccountId)) fail("客户账号 ID 必须是 12 位数字");
  const account = await requireAccount(accountId);
  const organization = await context(account);
  if (memberAccountId === organization.managementAccountId) fail("不能修改 Organization 管理账号");
  const member = await organizationMember(organization.client, memberAccountId);
  if (!member || member.Status === "SUSPENDED" || member.State === "SUSPENDED") fail("客户账号不存在或已停用", 404);

  const previousExemptions = { ...(account.restrictionExemptions || {}) };
  const nextExemptions = { ...previousExemptions };
  if (enabled) delete nextExemptions[memberAccountId];
  else nextExemptions[memberAccountId] = {
    createdAt: previousExemptions[memberAccountId]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reason: "Manual guardrail exemption",
  };
  await saveCloudSweepExemptions(account, nextExemptions);

  try {
    const result = await syncDirectGuardrails(account);
    const current = result.members.find((item) => item.accountId === memberAccountId);
    if (!current) fail("同步后未找到该客户账号", 404);
    const message = enabled ? `已给 ${memberAccountId} 添加 5 项限制` : `已取消 ${memberAccountId} 的 5 项限制`;
    await recordRun(accountId, "success", message);
    await recordOperation({
      account,
      mode: "manual",
      status: "success",
      checked: result.checked,
      moved: 1,
      skipped: result.skipped,
      message,
      movedAccounts: [{ accountId: memberAccountId, name: member.Name || memberAccountId, email: member.Email || "", sourceParentName: enabled ? "已取消" : "已限制", destinationParentName: enabled ? "已限制" : "已取消" }],
    });
    return { result: { ...result, message }, discovery: { account: publicAccount(account), policyName: restrictedPolicyName, policyId: result.policyId }, members: result.members, member: current };
  } catch (error) {
    await saveCloudSweepExemptions(account, previousExemptions).catch((rollbackError) => console.error("Failed to rollback guardrail exemption", rollbackError));
    throw error;
  }
}

async function findMember(body) {
  const memberAccountId = String(body.memberAccountId || "");
  if (!/^\d{12}$/.test(memberAccountId)) fail("请输入 12 位客户账号 ID");
  const located = await locateCloudSweepMemberInternal(memberAccountId);
  if (!located.member) fail(`未在已接入的 ${located.searchedPayers} 个代付 Organization 中找到客户账号 ${memberAccountId}`, 404);
  const result = await discoverAccount(located.payer.accountId, { force: true });
  return { ...result, selectedAccountId: located.payer.accountId, memberAccountId };
}

async function organizationMember(client, memberAccountId) {
  let NextToken;
  do {
    const page = await client.send(new ListAccountsCommand({ NextToken }));
    const member = (page.Accounts || []).find((item) => item.Id === memberAccountId);
    if (member) return member;
    NextToken = page.NextToken;
  } while (NextToken);
  return null;
}

async function locateMemberInPayer(payer, memberAccountId) {
  const organization = await context(payer);
  if (memberAccountId === organization.managementAccountId) return null;
  const member = await organizationMember(organization.client, memberAccountId);
  if (!member) return null;
  const parent = (await organization.client.send(new ListParentsCommand({ ChildId: memberAccountId }))).Parents?.[0];
  if (!parent?.Id) fail(`找不到子账号 ${memberAccountId} 当前所在的 Root/OU`);
  const placement = parent.Id === payer.temporaryOuId ? "temporary" : parent.Id === payer.restrictedOuId ? "restricted" : "other";
  const parentName = placement === "temporary" ? temporaryName : placement === "restricted" ? restrictedName : parent.Type === "ROOT" ? "Root" : parent.Id;
  return { payer, organization, member, parentId: parent.Id, parentName, placement };
}

async function locateCloudSweepMemberInternal(memberAccountId) {
  if (!/^\d{12}$/.test(String(memberAccountId || ""))) fail("子账号 ID 必须是 12 位数字");
  const directory = await listAccounts();
  const payers = [];
  for (const entry of directory) {
    try { payers.push(await requireAccount(entry.accountId)); }
    catch { /* 目录可能在扫描期间被删除，继续检查其他代付 */ }
  }
  payers.sort((left, right) => {
    const leftCached = Array.isArray(left.memberCache?.members) && left.memberCache.members.some((item) => item.accountId === memberAccountId);
    const rightCached = Array.isArray(right.memberCache?.members) && right.memberCache.members.some((item) => item.accountId === memberAccountId);
    return Number(rightCached) - Number(leftCached);
  });

  let lookupFailures = 0;
  for (let offset = 0; offset < payers.length; offset += 4) {
    const batch = await Promise.all(payers.slice(offset, offset + 4).map(async (payer) => {
      try { return await locateMemberInPayer(payer, memberAccountId); }
      catch (error) { lookupFailures += 1; console.error("CloudSweep member lookup failed", { payerAccountId: payer.accountId, memberAccountId, error: error?.message || error }); return null; }
    }));
    const matches = batch.filter(Boolean);
    if (matches.length > 1) fail(`子账号 ${memberAccountId} 匹配到多个代付 Organization，已停止自动操作`);
    if (matches.length === 1) return { ...matches[0], searchedPayers: Math.min(offset + 4, payers.length), lookupFailures };
  }
  return { member: null, searchedPayers: payers.length, lookupFailures };
}

function publicCloudSweepLocation(value, memberAccountId) {
  if (!value.member) return { found: false, memberAccountId, searchedPayers: value.searchedPayers, lookupFailures: value.lookupFailures };
  const rootRestrictions = value.rootRestrictions || [];
  const directRestrictions = value.directRestrictions || [];
  return {
    found: true,
    memberAccountId,
    memberName: value.member.Name || memberAccountId,
    payerAccountId: value.payer.accountId,
    payerRemark: value.payer.remark,
    currentParentId: value.parentId,
    currentParentName: value.parentName,
    placement: value.placement,
    rootId: value.organization.rootId,
    rootRestrictions: rootRestrictions.map((policy) => ({ id: policy.Id, name: policy.Name })),
    directRestrictions: directRestrictions.map((policy) => ({ id: policy.Id, name: policy.Name })),
    movable: rootRestrictions.length === 0,
    restrictionExempted: Boolean(value.payer.cloudSweepRestrictionExemptions?.[memberAccountId]),
    searchedPayers: value.searchedPayers,
    lookupFailures: value.lookupFailures,
  };
}

async function cloudSweepPolicyScope(value) {
  const [rootPolicies, directPolicies] = await Promise.all([
    attachedScps(value.organization.client, value.organization.rootId),
    attachedScps(value.organization.client, value.member.Id),
  ]);
  const unrestricted = (policy) => policy.Name === "FullAWSAccess";
  return {
    ...value,
    rootRestrictions: rootPolicies.filter((policy) => !unrestricted(policy)),
    directRestrictions: directPolicies.filter((policy) => !unrestricted(policy)),
  };
}

async function saveCloudSweepExemptions(payer, exemptions) {
  const payload = JSON.stringify(exemptions);
  if (Buffer.byteLength(payload, "utf8") > 300000) fail("客户限制豁免记录过大，请先整理历史记录");
  await dynamodb.send(new UpdateItemCommand({
    TableName: accountsTable,
    Key: { accountId: { S: payer.accountId } },
    UpdateExpression: "SET guardrailExemptions=:exemptions, ouAutomationUpdatedAt=:updated",
    ExpressionAttributeValues: { ":exemptions": { S: payload }, ":updated": { S: new Date().toISOString() } },
  }));
  payer.restrictionExemptions = exemptions;
  payer.cloudSweepRestrictionExemptions = exemptions;
}

async function releaseCloudSweepMemberRestrictions(body) {
  const memberAccountId = String(body.memberAccountId || "");
  const located = await locateCloudSweepMemberInternal(memberAccountId);
  const value = located.member ? await cloudSweepPolicyScope(located) : located;
  if (!value.member) fail(`未在已接入的 ${value.searchedPayers} 个代付 Organization 中找到子账号 ${memberAccountId}`, 404);
  if (body.expectedPayerAccountId && body.expectedPayerAccountId !== value.payer.accountId) fail("子账号所属代付已变更，请重新检查");
  if (body.expectedSourceParentId && body.expectedSourceParentId !== value.parentId) fail("子账号所在 OU 已变更，请重新检查");
  if (value.rootRestrictions.length) fail(`Organization Root 上仍有共享 SCP 限制：${value.rootRestrictions.map((policy) => policy.Name || policy.Id).join("、")}。不能只对一个子账号安全解除`);

  const previousExemptions = { ...(value.payer.cloudSweepRestrictionExemptions || {}) };
  const nextExemptions = {
    ...previousExemptions,
    [memberAccountId]: {
      createdAt: previousExemptions[memberAccountId]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reason: "CloudSweep SCP scan remediation",
      taskId: String(body.taskId || "").slice(0, 100),
    },
  };
  await saveCloudSweepExemptions(value.payer, nextExemptions);

  const detachedPolicies = [];
  for (const policy of value.directRestrictions) {
    if (!policy.Id) continue;
    await value.organization.client.send(new DetachPolicyCommand({ PolicyId: policy.Id, TargetId: memberAccountId }));
    detachedPolicies.push({ id: policy.Id, name: policy.Name || policy.Id });
  }

  let moved = false;
  try {
    if (value.parentId !== value.organization.rootId) {
      await value.organization.client.send(new MoveAccountCommand({ AccountId: memberAccountId, SourceParentId: value.parentId, DestinationParentId: value.organization.rootId }));
      moved = true;
    }
  } catch (error) {
    await saveCloudSweepExemptions(value.payer, previousExemptions).catch((rollbackError) => console.error("Failed to rollback CloudSweep exemption", rollbackError));
    throw error;
  }

  if (Array.isArray(value.payer.memberCache?.members)) {
    const members = value.payer.memberCache.members.map((member) => member.accountId === memberAccountId
      ? { ...member, parentId: value.organization.rootId, parentName: "Root", placement: "ungrouped", cloudSweepExemption: true }
      : member);
    await saveMemberCache(value.payer, members);
  }
  const detachedText = detachedPolicies.length ? `，并解除 ${detachedPolicies.length} 个直接挂载的限制 SCP` : "";
  const message = moved
    ? `已将 ${memberAccountId} 从 ${value.parentName} 移动到 Organization Root${detachedText}；CloudSweep SCP 豁免已长期保留，自动归位任务不会将其移回`
    : `${memberAccountId} 已在 Organization Root${detachedText}；CloudSweep SCP 豁免已长期保留`;
  await recordOperation({
    account: value.payer,
    mode: "cloudsweep",
    status: "success",
    checked: 1,
    moved: moved ? 1 : 0,
    skipped: moved ? 0 : 1,
    message,
    movedAccounts: moved ? [{ accountId: memberAccountId, name: value.member.Name || memberAccountId, email: value.member.Email || "", sourceParentName: value.parentName, destinationParentName: "Root" }] : [],
  });
  return { ...publicCloudSweepLocation({ ...value, parentId: value.organization.rootId, parentName: "Root", placement: "other", directRestrictions: [] }, memberAccountId), moved, restrictionExempted: true, detachedPolicies, message };
}

async function locateCloudSweepMember(memberAccountId) {
  const value = await locateCloudSweepMemberInternal(memberAccountId);
  return publicCloudSweepLocation(value.member ? await cloudSweepPolicyScope(value) : value, memberAccountId);
}

export async function runScheduledOuAutomation() {
  const accounts = await listAccounts();
  const results = [];
  for (const account of accounts) {
    try { results.push(await reconcile(account.accountId)); } catch (error) { results.push({ accountId: account.accountId, error: error.message || "Reconciliation failed" }); }
  }
  return { accounts: results.length, results };
}

export function isOuAutomationScheduledEvent(event) { return event?.source === "aws.events" && event?.["detail-type"] === "Scheduled Event"; }

export async function handleOuAutomationRequest({ method, body, identity }) {
  if (identity?.role !== "super_admin" && identity?.role !== "admin") fail("Administrator permission required", 403);
  if (method === "GET") return { accounts: await listAccounts(), targetGroups: [...targetGroupNames] };
  if (method !== "POST") fail("Method not allowed", 405);
  if (body.action === "discover") return discoverAccount(String(body.accountId || ""), { force: body.force === true });
  if (body.action === "find-member") return findMember(body);
  if (body.action === "set-member-restriction") return setMemberRestriction(body);
  if (body.action === "ou-options") return { discovery: publicDiscovery(await inspect(String(body.accountId || ""))) };
  if (body.action === "initialize") return initialize(body);
  if (body.action === "history") return { history: await movementHistory(String(body.accountId || "")) };
  if (body.action === "cloudsweep-locate") return { location: await locateCloudSweepMember(String(body.memberAccountId || "")) };
  if (body.action === "cloudsweep-release-restrictions") {
    if (body.confirmed !== true) fail("必须明确确认后才能移动子账号");
    return { location: await releaseCloudSweepMemberRestrictions(body) };
  }
  if (body.action === "run") return { result: await reconcile(String(body.accountId || ""), { mode: "manual" }) };
  if (body.action === "run-all") return runScheduledOuAutomation();
  fail("Invalid OU automation action");
}
