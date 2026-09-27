import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

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

async function bridgeClient({ sessionName, region, maxAttempts }) {
  const local = new STSClient({ region, maxAttempts });
  const bridgeRoleArn = String(process.env.CROSS_ACCOUNT_BRIDGE_ROLE_ARN || "").trim();
  if (!bridgeRoleArn) return { client: local, bridgeRoleArn: "" };
  const bridge = await local.send(new AssumeRoleCommand({
    RoleArn: bridgeRoleArn,
    RoleSessionName: `${sessionName.slice(0, 45)}-bridge`,
    DurationSeconds: 900,
  }));
  return {
    bridgeRoleArn,
    client: new STSClient({
      region,
      maxAttempts,
      credentials: credentials(bridge.Credentials, "无法取得跨账号桥接角色凭证"),
    }),
  };
}

export async function checkCrossAccountBridge({ region = "us-east-1", maxAttempts = 5 } = {}) {
  const { client, bridgeRoleArn } = await bridgeClient({ sessionName: "nexus-bridge-health", region, maxAttempts });
  const identity = await client.send(new GetCallerIdentityCommand({}));
  return {
    mode: bridgeRoleArn ? "bridge" : "direct",
    account: identity.Account || "",
    role: String(identity.Arn || "").split("/")[1] || "",
  };
}

export async function assumeManagedRole({ roleArn, sessionName, durationSeconds = 900, region = "us-east-1", maxAttempts = 5 }) {
  const { client, bridgeRoleArn } = await bridgeClient({ sessionName, region, maxAttempts });

  const target = await client.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: Math.min(durationSeconds, bridgeRoleArn ? 3600 : durationSeconds),
  }));
  return credentials(target.Credentials, "无法取得目标账号临时权限");
}
