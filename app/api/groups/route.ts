import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../chatgpt-auth';

export async function GET() {
  const denied = await requireUser();
  if (denied) return denied;
  return proxyBroker({ method: 'GET' });
}

export async function POST(request: Request) {
  const denied = await requireUser();
  if (denied) return denied;
  try {
    const body = await request.json();
    return proxyBroker({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}

async function requireUser() {
  const user = await getChatGPTUser();
  if (!user && process.env.NODE_ENV === 'production') return NextResponse.json({ error: '请先登录运维平台' }, { status: 401 });
  return null;
}

async function proxyBroker(init: RequestInit) {
  const brokerUrl = process.env.AWS_CONSOLE_BROKER_URL?.replace(/\/$/, '');
  const brokerToken = process.env.AWS_CONSOLE_BROKER_TOKEN;
  if (!brokerUrl || !brokerToken) return NextResponse.json({ error: 'AWS 服务尚未配置' }, { status: 503 });
  try {
    const response = await fetch(`${brokerUrl}/groups`, { ...init, headers: { ...init.headers, 'x-internal-key': brokerToken }, cache: 'no-store' });
    const payload = await response.json();
    return NextResponse.json(payload, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'AWS 服务暂时不可用' }, { status: 502 });
  }
}
