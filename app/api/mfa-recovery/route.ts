import { NextResponse } from 'next/server';
import { proxyBroker, requireIdentity } from '../broker';
import { localMfaRecoveryPreview } from './local-preview';

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  try {
    const body = await request.json();
    const allowedActions = ['organization-status', 'preflight', 'root-status', 'root-delete', 'root-recover'];
    if (!body || !allowedActions.includes(body.action)) {
      return NextResponse.json({ error: '不支持的恢复操作' }, { status: 400 });
    }
    const response = await proxyBroker('/mfa-recovery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, user);
    if (process.env.NODE_ENV === 'development' && response.status === 404) return localMfaRecoveryPreview(body);
    return response;
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}
