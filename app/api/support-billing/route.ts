import { NextResponse } from 'next/server';
import { proxyBroker, requireIdentity } from '../broker';
import { localSupportBillingPreview, type LocalRequest } from './local-preview';

export async function GET() {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  const response = process.env.NODE_ENV === 'development'
    ? await localSupportBillingPreview(user)
    : await proxyBroker('/support-billing', { method: 'GET' }, user);
  if (!response.ok) return response;
  const payload = await response.json() as Record<string, unknown>;
  return NextResponse.json({ ...payload, cacheScope: `${user.userId}:${user.role}` }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  try {
    const value = await request.json() as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
    const body = value as LocalRequest;
    if (process.env.NODE_ENV === 'development') return localSupportBillingPreview(user, body);
    const response = await proxyBroker('/support-billing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, user);
    return response;
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}
