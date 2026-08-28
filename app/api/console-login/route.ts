import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';

type LoginRequest = { accountId?: string; roleName?: string };

export async function GET(request: Request) {
  const denied = await requireUser();
  if (denied) return denied;
  const url = new URL(request.url);
  const result = await requestLogin({ accountId: url.searchParams.get('accountId') ?? '', roleName: url.searchParams.get('roleName') ?? '' });
  if (result.error || !result.url) return NextResponse.json({ error: result.error ?? '连接失败' }, { status: result.status });
  return NextResponse.redirect(result.url, 302);
}

export async function POST(request: Request) {
  const denied = await requireUser();
  if (denied) return denied;
  let body: LoginRequest;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: '请求格式不正确' }, { status: 400 }); }
  const result = await requestLogin(body);
  if (result.error || !result.url) return NextResponse.json({ error: result.error ?? '连接失败' }, { status: result.status });
  return NextResponse.json({ mode: 'broker', url: result.url }, { headers: { 'Cache-Control': 'no-store' } });
}

async function requireUser() {
  const user = await getChatGPTUser();
  if (!user && process.env.NODE_ENV === 'production') return NextResponse.json({ error: '请先登录运维平台' }, { status: 401 });
  return null;
}

async function requestLogin(body: LoginRequest) {
  if (!/^\d{12}$/.test(body.accountId ?? '') || (body.roleName !== 'TontianOperationsRole' && body.roleName !== 'TontianAdminRole')) return { error: '账号或角色未被授权', status: 403 };
  const brokerUrl = process.env.AWS_CONSOLE_BROKER_URL?.replace(/\/$/, '');
  const brokerToken = process.env.AWS_CONSOLE_BROKER_TOKEN;
  if (!brokerUrl || !brokerToken) return { error: 'AWS 服务尚未配置', status: 503 };
  try {
    const brokerResponse = await fetch(`${brokerUrl}/console-login`, {
      method: 'POST',
      headers: { 'x-internal-key': brokerToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: body.accountId, access: body.roleName === 'TontianAdminRole' ? 'admin' : 'operations' }),
    });
    const payload = await brokerResponse.json() as { loginUrl?: string; error?: string };
    if (!brokerResponse.ok) return { error: payload.error ?? '连接失败', status: brokerResponse.status };
    if (!payload.loginUrl || !isAwsSigninUrl(payload.loginUrl)) return { error: 'AWS 返回了无效地址', status: 502 };
    return { url: payload.loginUrl, status: 200 };
  } catch { return { error: 'AWS 服务暂时不可用', status: 502 }; }
}

function isAwsSigninUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'signin.aws.amazon.com' || url.hostname.endsWith('.signin.aws.amazon.com')); }
  catch { return false; }
}
