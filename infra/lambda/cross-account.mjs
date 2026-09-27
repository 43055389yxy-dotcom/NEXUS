import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

function credentials(value, message) {
  if (!value?.AccessKeyId || !value.SecretAccessKey || !value.SessionToken) {
    throw new Error(message);
  }
  return {
    accessKeyId: value.AccessKeyId,
    secretAccessKey: value.SecretAccessKey,
    sessionToken: value.SessionToken,
  };
}

export async function assumeManagedRole({ roleArn, sessionName, durationSeconds = 900, region = "us-east-1", maxAttempts = 5 }) {
  const local = new STSClient({ region, maxAttempts });
  const bridgeRoleArn = String(process.env.CROSS_ACCOUNT_BRIDGE_ROLE_ARN || "").trim();
  let client = local;

  if (bridgeRoleArn) {
    const bridge = await local.send(new AssumeRoleCommand({
      RoleArn: bridgeRoleArn,
      RoleSessionName: `${sessionName.slice(0, 45)}-bridge`,
      DurationSeconds: 900,
    }));
    client = new STSClient({
      region,
      maxAttempts,
      credentials: credentials(bridge.Credentials, "无法取得跨账号桥接角色凭证"),
    });
  }

  const target = await client.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: Math.min(durationSeconds, bridgeRoleArn ? 3600 : durationSeconds),
  }));
  return credentials(target.Credentials, "无法取得目标账号临时权限");
}
