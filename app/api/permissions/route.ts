import { NextResponse } from 'next/server';
import { proxyBroker, requireIdentity } from '../broker';

export async function GET() {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  const token = process.env.ITSM_INTEGRATION_TOKEN;
  const usersUrl = process.env.ITSM_USERS_URL ?? 'http://itsm-admin:3000/api/integrations/users';
  if (!token) return NextResponse.json({ error: 'ITSM 用户同步尚未配置' }, { status: 503 });

  const grantsResponse = await proxyBroker('/permissions', { method: 'GET' }, user);
  const grantsPayload = await grantsResponse.json() as { users?: Array<{ userId: string; groupIds?: string[]; configured?: boolean }>; error?: string };
  if (!grantsResponse.ok) return NextResponse.json(grantsPayload, { status: grantsResponse.status });

  try {
    const usersResponse = await fetch(usersUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const usersPayload = await usersResponse.json() as {
      success?: boolean;
      users?: Array<{ userId: string; username: string; role: string; enabled: boolean }>;
      error?: string;
    };
    if (!usersResponse.ok || !usersPayload.success) {
      return NextResponse.json({ error: usersPayload.error ?? 'ITSM 用户同步失败' }, { status: 502 });
    }

    const grants = new Map((grantsPayload.users ?? []).map((item) => [item.userId, { groupIds: item.groupIds ?? [], configured: item.configured ?? false }]));
    const users = (usersPayload.users ?? [])
      .filter((item) => item.enabled && item.userId && item.username)
      .map((item) => ({
        userId: item.userId,
        userName: item.username,
        role: item.role === 'super_admin' || item.role === 'admin' ? item.role : 'user',
        groupIds: grants.get(item.userId)?.groupIds ?? [],
        configured: grants.get(item.userId)?.configured ?? false,
      }))
      .sort((a, b) => a.userName.localeCompare(b.userName, 'zh-CN'));
    return NextResponse.json({ users }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '无法连接 ITSM 用户服务' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  try {
    const body = await request.json();
    const token = process.env.ITSM_INTEGRATION_TOKEN;
    const usersUrl = process.env.ITSM_USERS_URL ?? 'http://itsm-admin:3000/api/integrations/users';
    if (!token) return NextResponse.json({ error: 'ITSM 用户同步尚未配置' }, { status: 503 });
    const usersResponse = await fetch(usersUrl, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const usersPayload = await usersResponse.json() as { success?: boolean; users?: Array<{ userId: string; role: string; enabled: boolean }> };
    const target = usersPayload.users?.find((item) => item.enabled && item.userId === body.userId);
    if (!usersResponse.ok || !usersPayload.success || !target) return NextResponse.json({ error: 'ITSM 用户不存在或已停用' }, { status: 400 });
    if (target.role === 'super_admin') return NextResponse.json({ error: '超级管理员权限不可修改' }, { status: 403 });
    if (target.role === 'admin' && user.role !== 'super_admin') return NextResponse.json({ error: '只有超级管理员可以修改管理员权限' }, { status: 403 });
    return proxyBroker('/permissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, targetRole: target.role }) }, user);
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
}
