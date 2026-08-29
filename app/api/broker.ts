import { NextResponse } from 'next/server';
import { getChatGPTUser, isAdminRole, type ChatGPTUser } from '../chatgpt-auth';

export async function requireIdentity(adminOnly = false): Promise<{ user?: ChatGPTUser; denied?: NextResponse }> {
  const user = await getChatGPTUser();
  if (!user) return { denied: NextResponse.json({ error: '请先登录 ITSM' }, { status: 401 }) };
  if (adminOnly && !isAdminRole(user.role)) return { denied: NextResponse.json({ error: '仅管理员可以执行此操作' }, { status: 403 }) };
  return { user };
}

export async function proxyBroker(path: string, init: RequestInit, user: ChatGPTUser) {
  const brokerUrl = process.env.AWS_CONSOLE_BROKER_URL?.replace(/\/$/, '');
  const brokerToken = process.env.AWS_CONSOLE_BROKER_TOKEN;
  if (!brokerUrl || !brokerToken) return NextResponse.json({ error: 'AWS 服务尚未配置' }, { status: 503 });
  try {
    const response = await fetch(`${brokerUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        'x-internal-key': brokerToken,
        'x-auth-user': user.displayName,
        'x-auth-user-id': user.userId,
        'x-auth-role': user.role,
        'x-auth-permission': user.permissionId,
      },
      cache: 'no-store',
    });
    const payload = await response.json();
    return NextResponse.json(payload, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'AWS 服务暂时不可用' }, { status: 502 });
  }
}
