import { NextResponse } from 'next/server';
import { proxyBroker, requireIdentity } from '../broker';

export async function GET() {
  const { user, denied } = await requireIdentity();
  if (denied || !user) return denied;
  return proxyBroker('/accounts', { method: 'GET' }, user);
}

export async function POST(request: Request) {
  return proxyJson(request, 'POST');
}

export async function PATCH(request: Request) {
  return proxyJson(request, 'PATCH');
}

export async function DELETE(request: Request) {
  return proxyJson(request, 'DELETE');
}

async function proxyJson(request: Request, method: string) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  try {
    const body = await request.json();
    return proxyBroker('/accounts', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, user);
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}
