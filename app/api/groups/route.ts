import { NextResponse } from 'next/server';
import { proxyBroker, proxyLocalBroker, requireIdentity } from '../broker';

const groupBroker = process.env.NODE_ENV === 'development' ? proxyLocalBroker : proxyBroker;

export async function GET() {
  const { user, denied } = await requireIdentity();
  if (denied || !user) return denied;
  return groupBroker('/groups', { method: 'GET' }, user);
}

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  try {
    const body = await request.json();
    return groupBroker('/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, user);
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}
