import { CreateLoginProfileCommand, DeactivateMFADeviceCommand, DeleteAccessKeyCommand, DeleteLoginProfileCommand, DeleteSigningCertificateCommand, GetLoginProfileCommand, IAMClient, ListAccessKeysCommand, ListMFADevicesCommand, ListOrganizationsFeaturesCommand, ListSigningCertificatesCommand } from "@aws-sdk/client-iam";
import { DescribeAccountCommand, DescribeOrganizationCommand, ListAWSServiceAccessForOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { AssumeRoleCommand, AssumeRootCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const sts = new STSClient({ region: "us-east-1" });
const automationRole = "TontianOrganizationAutomationRole";

function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function validAccountId(value, label) { const result = String(value || ""); if (!/^\d{12}$/.test(result)) fail(`${label}不正确`); return result; }
function credentials(value) { return { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken }; }
function activeAccount(value) { return String(value?.State || value?.Status || "").toUpperCase() === "ACTIVE"; }

async function payerContext(payerAccountId) {
  const payerId = validAccountId(payerAccountId, "代付账号 ID");
  const assumed = await sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${payerId}:role/${automationRole}`, RoleSessionName: `nexus-mfa-${Date.now()}`, DurationSeconds: 900 }));
  if (!assumed.Credentials?.AccessKeyId) fail("无法进入代付账号");
  const config = { region: "us-east-1", credentials: credentials(assumed.Credentials) };
  return { payerId, sts: new STSClient(config), iam: new IAMClient(config), organizations: new OrganizationsClient(config) };
}

async function organizationStatus(payerAccountId) {
  const context = await payerContext(payerAccountId);
  const [caller, organizationResult, serviceAccess] = await Promise.all([context.sts.send(new GetCallerIdentityCommand({})), context.organizations.send(new DescribeOrganizationCommand({})), context.organizations.send(new ListAWSServiceAccessForOrganizationCommand({}))]);
  const organization = organizationResult.Organization || {};
  const managementAccountId = organization.ManagementAccountId || organization.MasterAccountId || "";
  if (caller.Account !== managementAccountId) fail("当前代付账号不是该 Organization 的管理账号");
  const services = new Set((serviceAccess.EnabledServicePrincipals || []).map((item) => item.ServicePrincipal));
  const trustedAccessEnabled = services.has("iam.amazonaws.com");
  let enabledFeatures = new Set();
  if (trustedAccessEnabled) {
    try { const features = await context.iam.send(new ListOrganizationsFeaturesCommand({})); enabledFeatures = new Set(features.EnabledFeatures || []); }
    catch (error) { if (!/ServiceAccessNotEnabled|Trusted Access/i.test(String(error?.message || ""))) throw error; }
  }
  return { context, preflight: { organization: { id: organization.Id || "", managementAccountId }, rootAccess: { trustedAccessEnabled, rootSessionsEnabled: enabledFeatures.has("RootSessions"), rootCredentialsManagementEnabled: enabledFeatures.has("RootCredentialsManagement") } } };
}

async function preflight(payerAccountId, memberAccountId) {
  const memberId = validAccountId(memberAccountId, "成员账号 ID");
  const result = await organizationStatus(payerAccountId);
  const targetResult = await result.context.organizations.send(new DescribeAccountCommand({ AccountId: memberId }));
  if (!targetResult.Account || !activeAccount(targetResult.Account)) fail("目标成员账号当前不是 ACTIVE 状态");
  return { context: result.context, preflight: { ...result.preflight, target: { accountId: memberId, name: targetResult.Account.Name || memberId, state: targetResult.Account.State || targetResult.Account.Status || "" } } };
}

async function assumeRoot(context, memberAccountId, taskPolicyName) {
  const result = await context.sts.send(new AssumeRootCommand({ TargetPrincipal: memberAccountId, TaskPolicyArn: { arn: `arn:aws:iam::aws:policy/root-task/${taskPolicyName}` }, DurationSeconds: 900 }));
  if (!result.Credentials?.AccessKeyId) fail("无法取得成员账号的短期根会话");
  return new IAMClient({ region: "us-east-1", credentials: credentials(result.Credentials) });
}

async function optional(command) { try { return await command(); } catch (error) { if (/NoSuchEntity|not found/i.test(String(error?.message || ""))) return null; throw error; } }
async function readRootStatus(client) {
  const [profile, accessKeys, signingCertificates, mfaDevices] = await Promise.all([optional(() => client.send(new GetLoginProfileCommand({}))), client.send(new ListAccessKeysCommand({})), client.send(new ListSigningCertificatesCommand({})), client.send(new ListMFADevicesCommand({}))]);
  return { passwordPresent: Boolean(profile?.LoginProfile), accessKeys: accessKeys.AccessKeyMetadata || [], signingCertificates: signingCertificates.Certificates || [], mfaDevices: mfaDevices.MFADevices || [] };
}
function publicStatus(status) { return { passwordPresent: status.passwordPresent, accessKeys: status.accessKeys.map((item) => ({ accessKeyId: item.AccessKeyId ? `••••${item.AccessKeyId.slice(-4)}` : "" })), signingCertificates: status.signingCertificates.map((item) => ({ certificateId: item.CertificateId ? `••••${item.CertificateId.slice(-4)}` : "" })), mfaDevices: status.mfaDevices.map((item) => ({ serialNumber: item.SerialNumber || "MFA" })) }; }

async function auditRoot(body) { const result = await preflight(body.payerAccountId, body.memberAccountId); const root = await assumeRoot(result.context, body.memberAccountId, "IAMAuditRootUserCredentials"); return publicStatus(await readRootStatus(root)); }
async function deleteRootCredentials(body) {
  const memberId = validAccountId(body.memberAccountId, "成员账号 ID");
  if (String(body.confirmationAccountId || "") !== memberId) fail("目标账号 ID 二次确认不匹配");
  const result = await preflight(body.payerAccountId, memberId);
  const root = await assumeRoot(result.context, memberId, "IAMDeleteRootUserCredentials");
  const status = await readRootStatus(root); const changes = [];
  if (status.passwordPresent) { await root.send(new DeleteLoginProfileCommand({})); changes.push("已删除根用户密码"); }
  for (const key of status.accessKeys) if (key.AccessKeyId) { await root.send(new DeleteAccessKeyCommand({ AccessKeyId: key.AccessKeyId })); changes.push(`已删除根访问密钥 ${key.AccessKeyId.slice(-4)}`); }
  for (const certificate of status.signingCertificates) if (certificate.CertificateId) { await root.send(new DeleteSigningCertificateCommand({ CertificateId: certificate.CertificateId })); changes.push("已删除根签名证书"); }
  for (const device of status.mfaDevices) if (device.SerialNumber) { await root.send(new DeactivateMFADeviceCommand({ SerialNumber: device.SerialNumber })); changes.push("已停用根用户 MFA"); }
  if (!changes.length) changes.push("目标账号已无根凭证，无需重复清除");
  return { changes, status: publicStatus({ passwordPresent: false, accessKeys: [], signingCertificates: [], mfaDevices: [] }) };
}
async function allowPasswordRecovery(body) {
  const result = await preflight(body.payerAccountId, body.memberAccountId); const root = await assumeRoot(result.context, body.memberAccountId, "IAMCreateRootUserPassword");
  try { await root.send(new CreateLoginProfileCommand({})); } catch (error) { if (!/EntityAlreadyExists|already exists/i.test(String(error?.message || ""))) throw error; }
  const profile = await optional(() => root.send(new GetLoginProfileCommand({}))); if (!profile?.LoginProfile) fail("AWS 尚未开放密码恢复，请稍后重试");
  return { changes: ["已允许通过根邮箱重置密码"] };
}
export async function handleMfaRecoveryRequest({ method, body, identity }) {
  if (identity?.role !== "super_admin" && identity?.role !== "admin") fail("Administrator permission required", 403);
  if (method !== "POST") fail("Method not allowed", 405);
  if (body.action === "organization-status") return { preflight: (await organizationStatus(body.payerAccountId)).preflight };
  if (body.action === "preflight") return { preflight: (await preflight(body.payerAccountId, body.memberAccountId)).preflight };
  if (body.action === "root-status") return { status: await auditRoot(body) };
  if (body.action === "root-delete") return deleteRootCredentials(body);
  if (body.action === "root-recover") return allowPasswordRecovery(body);
  fail("Invalid MFA recovery action");
}
