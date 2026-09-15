import { NextResponse } from 'next/server';
import { proxyBroker, requireIdentity } from '../broker';

export const runtime = 'nodejs';

export async function GET() {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  return proxyBroker('/support-case-monitor', { method: 'GET' }, user);
}

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
    return proxyBroker('/support-case-monitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, user);
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}
