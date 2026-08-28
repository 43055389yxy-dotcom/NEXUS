import { NextResponse } from 'next/server';
import { findCloudAccount } from '../../accounts';
import { getChatGPTUser } from '../../chatgpt-auth';

const allowedDestinationHosts = new Set([
  'console.aws.amazon.com',
  'ap-southeast-1.console.aws.amazon.com',
  'ap-northeast-1.console.aws.amazon.com',
  'us-east-1.console.aws.amazon.com',
  'eu-west-1.console.aws.amazon.com',
]);

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: '请先登录运维平台' }, { status: 401 });
  }

  let body: { accountId?: string; roleName?: string; destination?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }

  const account = findCloudAccount(body.accountId ?? '', body.roleName ?? '');
  if (!account) return NextResponse.json({ error: '账号或角色未被授权' }, { status: 403 });

  const destination = safeDestination(body.destination, account.region);
  const brokerUrl = process.env.AWS_CONSOLE_BROKER_URL;
  const brokerToken = process.env.AWS_CONSOLE_BROKER_TOKEN;

  if (brokerUrl && brokerToken) {
    const brokerResponse = await fetch(brokerUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${brokerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roleArn: `arn:aws:iam::${account.id}:role/${account.roleName}`,
        sourceIdentity: user?.email ?? 'local-demo-user',
        sessionName: safeSessionName(user?.email ?? 'local-demo-user'),
        durationSeconds: 3600,
        destination,
      }),
    });

    if (!brokerResponse.ok) return NextResponse.json({ error: '身份代理暂时不可用' }, { status: 502 });
    const result = await brokerResponse.json() as { url?: string };
    if (!result.url || !isAwsSigninUrl(result.url)) {
      return NextResponse.json({ error: '身份代理返回了无效地址' }, { status: 502 });
    }
    return NextResponse.json({ mode: 'broker', url: result.url }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const url = new URL('https://signin.aws.amazon.com/switchrole');
  url.searchParams.set('account', account.id);
  url.searchParams.set('roleName', account.roleName);
  url.searchParams.set('displayName', account.name);
  return NextResponse.json({ mode: 'switch-role', url: url.toString() }, { headers: { 'Cache-Control': 'no-store' } });
}

function safeDestination(value: string | undefined, region: string) {
  const fallback = `https://${region}.console.aws.amazon.com/console/home?region=${region}`;
  if (!value) return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && allowedDestinationHosts.has(url.hostname) ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function safeSessionName(value: string) {
  return value.replace(/[^a-zA-Z0-9+=,.@_-]/g, '-').slice(0, 64);
}

function isAwsSigninUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'signin.aws.amazon.com' || url.hostname.endsWith('.signin.aws.amazon.com'));
  } catch {
    return false;
  }
}
