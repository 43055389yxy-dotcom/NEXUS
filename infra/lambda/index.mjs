import crypto from "node:crypto";
import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

const dynamodb = new DynamoDBClient({});
const sts = new STSClient({});
const accountsTable = process.env.ACCOUNTS_TABLE;
const groupsTable = process.env.GROUPS_TABLE;
const operationsAccountId = process.env.OPS_ACCOUNT_ID;
const ADMIN_ROLES = new Set(["super_admin", "admin"]);
const UNGROUPED = "__ungrouped";

function response(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function authorized(event) {
  const expected = process.env.INTERNAL_API_KEY || "";
  const received = event.headers?.["x-internal-key"] || "";
  if (!expected || expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(raw);
}

function requestIdentity(event) {
  const headers = event.headers || {};
  const userId = String(headers["x-auth-user-id"] || "").trim();
  const userName = String(headers["x-auth-user"] || "").trim();
  const rawRole = String(headers["x-auth-role"] || "user").trim();
  if (!userId || !userName) { const error = new Error("ITSM identity is missing"); error.statusCode = 401; throw error; }
  return { userId, userName, role: ADMIN_ROLES.has(rawRole) ? rawRole : "user", permissionId: String(headers["x-auth-permission"] || "") };
}

function requireAdmin(identity) {
  if (!ADMIN_ROLES.has(identity.role)) { const error = new Error("Administrator permission required"); error.statusCode = 403; throw error; }
}

async function rememberIdentity(identity) {
  await dynamodb.send(new PutItemCommand({
    TableName: groupsTable,
    Item: {
      groupId: { S: `user#${identity.userId}` }, itemType: { S: "user" }, userId: { S: identity.userId },
      userName: { S: identity.userName }, role: { S: identity.role }, lastSeenAt: { S: new Date().toISOString() },
    },
  }));
}

async function allowedGroupIds(identity) {
  if (identity.role === "super_admin") return null;
  const result = await dynamodb.send(new ScanCommand({
    TableName: groupsTable,
    FilterExpression: "userId = :userId AND (itemType = :permission OR itemType = :configured)",
    ExpressionAttributeValues: { ":permission": { S: "permission" }, ":configured": { S: "permission-config" }, ":userId": { S: identity.userId } },
  }));
  const configured = (result.Items || []).some((item) => item.itemType?.S === "permission-config");
  if (identity.role === "admin" && !configured) return null;
  return new Set((result.Items || []).map((item) => item.grantedGroupId?.S).filter(Boolean));
}

function normalizeAccount(body) {
  const accountId = String(body.accountId || "").trim();
  const remark = String(body.remark || body.name || "").trim();
  const region = String(body.region || "us-east-1").trim();
  const groupId = String(body.groupId || "").trim();
  if (!/^\d{12}$/.test(accountId)) throw new Error("AWS account ID must be 12 digits");
  if (!remark || remark.length > 100) throw new Error("Account remark is required");
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Invalid AWS region");
  if (operationsAccountId === accountId) throw new Error("Operations account cannot be added");
  return { accountId, remark, region, groupId };
}

async function ensureGroup(groupId) {
  if (!groupId) return;
  const result = await dynamodb.send(new GetItemCommand({ TableName: groupsTable, Key: { groupId: { S: groupId } }, ConsistentRead: true }));
  if (!result.Item) throw new Error("Group does not exist");
}

async function listAccounts(identity) {
  const result = await dynamodb.send(new ScanCommand({
    TableName: accountsTable,
    ProjectionExpression: "accountId, #name, remark, #region, groupId, createdAt, updatedAt",
    ExpressionAttributeNames: { "#name": "name", "#region": "region" },
  }));
  const access = await allowedGroupIds(identity);
  return (result.Items || []).map((item) => ({
    accountId: item.accountId.S,
    remark: item.remark?.S || item.name?.S || item.accountId.S,
    region: item.region.S,
    groupId: item.groupId?.S || "",
    createdAt: item.createdAt?.S,
    updatedAt: item.updatedAt?.S,
  })).filter((account) => !access || access.has(account.groupId || UNGROUPED))
    .sort((a, b) => String(a.name || a.remark || a.accountId || "").localeCompare(String(b.name || b.remark || b.accountId || ""), "zh-CN"));
}

async function saveAccount(body) {
  const account = normalizeAccount(body);
  await ensureGroup(account.groupId);
  const now = new Date().toISOString();
  await dynamodb.send(new PutItemCommand({
    TableName: accountsTable,
    Item: {
      accountId: { S: account.accountId }, name: { S: account.remark }, remark: { S: account.remark }, region: { S: account.region },
      groupId: { S: account.groupId }, createdAt: { S: now }, updatedAt: { S: now },
    },
    ConditionExpression: "attribute_not_exists(accountId)",
  }));
  return account;
}

async function updateAccount(body) {
  const accountId = String(body.accountId || "").trim();
  if (!/^\d{12}$/.test(accountId)) throw new Error("Invalid AWS account ID");
  const current = await dynamodb.send(new GetItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, ConsistentRead: true }));
  if (!current.Item) throw new Error("Account does not exist");
  const remark = String(body.remark ?? current.Item.remark?.S ?? current.Item.name?.S ?? "").trim();
  const region = String(body.region ?? current.Item.region?.S ?? "us-east-1").trim();
  const groupId = String(body.groupId ?? current.Item.groupId?.S ?? "").trim();
  if (!remark || remark.length > 100) throw new Error("Account remark is required");
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error("Invalid AWS region");
  await ensureGroup(groupId);
  const result = await dynamodb.send(new UpdateItemCommand({
    TableName: accountsTable,
    Key: { accountId: { S: accountId } },
    UpdateExpression: "SET remark = :remark, #name = :remark, #region = :region, groupId = :groupId, updatedAt = :updatedAt",
    ConditionExpression: "attribute_exists(accountId)",
    ExpressionAttributeNames: { "#name": "name", "#region": "region" },
    ExpressionAttributeValues: { ":remark": { S: remark }, ":region": { S: region }, ":groupId": { S: groupId }, ":updatedAt": { S: new Date().toISOString() } },
    ReturnValues: "ALL_NEW",
  }));
  return {
    accountId: result.Attributes.accountId.S, remark: result.Attributes.remark.S,
    region: result.Attributes.region.S, groupId: result.Attributes.groupId?.S || "",
  };
}

async function deleteAccount(body) {
  const accountId = String(body.accountId || "").trim();
  if (!/^\d{12}$/.test(accountId)) throw new Error("Invalid AWS account ID");
  await dynamodb.send(new DeleteItemCommand({
    TableName: accountsTable,
    Key: { accountId: { S: accountId } },
    ConditionExpression: "attribute_exists(accountId)",
  }));
  return { accountId };
}

async function listGroups(identity) {
  const result = await dynamodb.send(new ScanCommand({ TableName: groupsTable }));
  const access = await allowedGroupIds(identity);
  return (result.Items || []).filter((item) => item.name?.S && !item.itemType?.S).map((item) => ({
    groupId: item.groupId.S, name: item.name.S, createdAt: item.createdAt?.S,
  })).filter((group) => !access || access.has(group.groupId))
    .sort((a, b) => String(a.name || a.groupId || "").localeCompare(String(b.name || b.groupId || ""), "zh-CN"));
}

async function createGroup(body) {
  const name = String(body.name || "").trim();
  if (!name || name.length > 50) throw new Error("Group name is required");
  const group = { groupId: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
  await dynamodb.send(new PutItemCommand({
    TableName: groupsTable,
    Item: { groupId: { S: group.groupId }, name: { S: group.name }, createdAt: { S: group.createdAt } },
    ConditionExpression: "attribute_not_exists(groupId)",
  }));
  return group;
}

async function getAccount(accountId) {
  const result = await dynamodb.send(new GetItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, ConsistentRead: true }));
  if (!result.Item) return null;
  return { accountId: result.Item.accountId.S, name: result.Item.name.S, region: result.Item.region.S };
}

async function createConsoleLogin(identity, body) {
  const accountId = String(body.accountId || "").trim();
  const access = body.access === "admin" ? "admin" : "operations";
  if (!/^\d{12}$/.test(accountId)) throw new Error("Invalid AWS account ID");
  if (access === "admin" && process.env.ALLOW_ADMIN !== "true") {
    const error = new Error("Administrator console access is disabled"); error.statusCode = 403; throw error;
  }
  const account = await getAccount(accountId);
  if (!account) { const error = new Error("Account is not registered"); error.statusCode = 404; throw error; }
  const accessGroups = await allowedGroupIds(identity);
  const accountRecord = await dynamodb.send(new GetItemCommand({ TableName: accountsTable, Key: { accountId: { S: accountId } }, ConsistentRead: true }));
  const accountGroupId = accountRecord.Item?.groupId?.S || UNGROUPED;
  if (accessGroups && !accessGroups.has(accountGroupId)) { const error = new Error("This account group is not assigned to you"); error.statusCode = 403; throw error; }
  const roleName = access === "admin" ? "TontianAdminRole" : "TontianOperationsRole";
  const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`, RoleSessionName: `tontian-web-${Date.now()}`, DurationSeconds: 3600 }));
  const credentials = assumed.Credentials;
  const session = JSON.stringify({ sessionId: credentials.AccessKeyId, sessionKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken });
  const tokenResponse = await fetch(`https://signin.aws.amazon.com/federation?Action=getSigninToken&Session=${encodeURIComponent(session)}`);
  if (!tokenResponse.ok) throw new Error("AWS federation token request failed");
  const { SigninToken } = await tokenResponse.json();
  const destination = `https://${account.region}.console.aws.amazon.com/console/home?region=${account.region}`;
  const loginUrl = `https://signin.aws.amazon.com/federation?Action=login&Issuer=${encodeURIComponent("Tontian AWS Access")}&Destination=${encodeURIComponent(destination)}&SigninToken=${encodeURIComponent(SigninToken)}`;
  console.log(JSON.stringify({ action: "console-login", accountId, roleName, at: new Date().toISOString() }));
  return { loginUrl, expiresIn: 3600, accountId, roleName };
}

async function listPermissions(identity) {
  requireAdmin(identity);
  const result = await dynamodb.send(new ScanCommand({ TableName: groupsTable }));
  const users = new Map();
  for (const item of result.Items || []) {
    if (item.itemType?.S === "user") users.set(item.userId.S, { userId: item.userId.S, userName: item.userName?.S || item.userId.S, role: item.role?.S || "user", groupIds: [], configured: false });
  }
  for (const item of result.Items || []) {
    if (item.itemType?.S !== "permission") continue;
    const userId = item.userId?.S;
    if (!userId) continue;
    if (!users.has(userId)) users.set(userId, { userId, userName: item.userName?.S || userId, role: "user", groupIds: [], configured: false });
    users.get(userId).groupIds.push(item.grantedGroupId.S);
  }
  for (const item of result.Items || []) {
    if (item.itemType?.S !== "permission-config" || !item.userId?.S) continue;
    if (!users.has(item.userId.S)) users.set(item.userId.S, { userId: item.userId.S, userName: item.userId.S, role: "user", groupIds: [], configured: true });
    users.get(item.userId.S).configured = true;
  }
  return [...users.values()].sort((a, b) => a.userName.localeCompare(b.userName, "zh-CN"));
}

async function savePermissions(identity, body) {
  requireAdmin(identity);
  const targetUserId = String(body.userId || "").trim();
  const targetUserName = String(body.userName || targetUserId).trim();
  const targetRole = String(body.targetRole || "user");
  const requested = [...new Set(Array.isArray(body.groupIds) ? body.groupIds.map((value) => String(value).trim()).filter(Boolean) : [])];
  if (!targetUserId || targetUserId.length > 200) throw new Error("Invalid user ID");
  if (targetRole === "super_admin") { const error = new Error("Super administrator permission cannot be changed"); error.statusCode = 403; throw error; }
  if (targetRole === "admin" && identity.role !== "super_admin") { const error = new Error("Only super administrators can manage administrators"); error.statusCode = 403; throw error; }
  const existingGroups = await dynamodb.send(new ScanCommand({ TableName: groupsTable }));
  const validGroups = new Set((existingGroups.Items || []).filter((item) => item.name?.S && !item.itemType?.S).map((item) => item.groupId.S));
  validGroups.add(UNGROUPED);
  if (requested.some((groupId) => !validGroups.has(groupId))) throw new Error("Invalid group permission");
  const callerGroups = await allowedGroupIds(identity);
  if (callerGroups && requested.some((groupId) => !callerGroups.has(groupId))) { const error = new Error("Cannot grant a group you cannot access"); error.statusCode = 403; throw error; }
  const previous = (existingGroups.Items || []).filter((item) => item.itemType?.S === "permission" && item.userId?.S === targetUserId);
  await Promise.all(previous.map((item) => dynamodb.send(new DeleteItemCommand({ TableName: groupsTable, Key: { groupId: { S: item.groupId.S } } }))));
  await Promise.all(requested.map((grantedGroupId) => {
    const key = crypto.createHash("sha256").update(`${targetUserId}\0${grantedGroupId}`).digest("hex");
    return dynamodb.send(new PutItemCommand({ TableName: groupsTable, Item: {
      groupId: { S: `permission#${key}` }, itemType: { S: "permission" }, userId: { S: targetUserId },
      userName: { S: targetUserName }, grantedGroupId: { S: grantedGroupId }, updatedAt: { S: new Date().toISOString() },
    } }));
  }));
  const configKey = crypto.createHash("sha256").update(targetUserId).digest("hex");
  await dynamodb.send(new PutItemCommand({ TableName: groupsTable, Item: {
    groupId: { S: `permission-config#${configKey}` }, itemType: { S: "permission-config" }, userId: { S: targetUserId },
    userName: { S: targetUserName }, updatedAt: { S: new Date().toISOString() },
  } }));
  return { userId: targetUserId, userName: targetUserName, groupIds: requested, configured: true };
}

export const handler = async (event) => {
  try {
    if (!authorized(event)) return response(401, { error: "Unauthorized" });
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.rawPath || event.path || "/";
    if (method === "GET" && path === "/health") return response(200, { ok: true, accountId: operationsAccountId });
    const identity = requestIdentity(event);
    await rememberIdentity(identity);
    if (method === "GET" && path === "/accounts") return response(200, { accounts: await listAccounts(identity) });
    if (method === "POST" && path === "/accounts") { requireAdmin(identity); return response(201, { account: await saveAccount(parseBody(event)) }); }
    if (method === "PATCH" && path === "/accounts") { requireAdmin(identity); return response(200, { account: await updateAccount(parseBody(event)) }); }
    if (method === "DELETE" && path === "/accounts") { requireAdmin(identity); return response(200, { account: await deleteAccount(parseBody(event)) }); }
    if (method === "GET" && path === "/groups") return response(200, { groups: await listGroups(identity) });
    if (method === "POST" && path === "/groups") { requireAdmin(identity); return response(201, { group: await createGroup(parseBody(event)) }); }
    if (method === "GET" && path === "/permissions") return response(200, { users: await listPermissions(identity) });
    if (method === "POST" && path === "/permissions") return response(200, { user: await savePermissions(identity, parseBody(event)) });
    if (method === "POST" && path === "/console-login") return response(200, await createConsoleLogin(identity, parseBody(event)));
    return response(404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    const duplicate = error?.name === "ConditionalCheckFailedException";
    return response(error.statusCode || (duplicate ? 409 : 400), { error: duplicate ? "Already exists" : error.message || "Request failed" });
  }
};
