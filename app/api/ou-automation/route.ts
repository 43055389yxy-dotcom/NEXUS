import { NextResponse } from 'next/server';
import { proxyBroker, requireIdentity } from '../broker';
import { localOuAutomationPreview } from './local-preview';

export async function GET() {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  const response = await proxyBroker('/ou-automation', { method: 'GET' }, user);
  if (process.env.NODE_ENV === 'development' && response.status === 404) return localOuAutomationPreview(user);
  return response;
}

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  try {
    const body = await request.json();
    const response = await proxyBroker('/ou-automation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, user);
    if (process.env.NODE_ENV === 'development' && response.status === 404) return localOuAutomationPreview(user, body);
    return response;
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}
