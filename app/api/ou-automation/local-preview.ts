import { NextResponse } from 'next/server';
import type { ChatGPTUser } from '../../chatgpt-auth';
import { proxyBroker } from '../broker';

type AccountRecord = { accountId: string; remark?: string; name?: string; groupId?: string };
type GroupRecord = { groupId: string; name: string };
type PreviewRequest = { action?: string; accountId?: string };

const TARGET_GROUP_NAMES = new Set(['CMA组', '老代付组']);

export async function localOuAutomationPreview(user: ChatGPTUser, body?: PreviewRequest) {
  const [accountsResponse, groupsResponse] = await Promise.all([
    proxyBroker('/accounts', { method: 'GET' }, user),
    proxyBroker('/groups', { method: 'GET' }, user),
  ]);
  const accountsPayload = await accountsResponse.json() as { accounts?: AccountRecord[]; error?: string };
  const groupsPayload = await groupsResponse.json() as { groups?: GroupRecord[]; error?: string };
  if (!accountsResponse.ok || !groupsResponse.ok) {
    return NextResponse.json({ error: accountsPayload.error ?? groupsPayload.error ?? '本地预览数据读取失败' }, { status: 502 });
  }

  const groups = groupsPayload.groups ?? [];
  const groupNames = new Map(groups.map((group) => [group.groupId, group.name]));
  const accounts = (accountsPayload.accounts ?? [])
    .filter((account) => TARGET_GROUP_NAMES.has(groupNames.get(account.groupId ?? '') ?? ''))
    .map((account) => ({
      accountId: account.accountId,
      remark: account.remark ?? account.name ?? account.accountId,
      groupName: groupNames.get(account.groupId ?? '') ?? '',
      temporaryOuId: '',
      restrictedOuId: '',
      configured: false,
      lastStatus: '本地预览',
    }));

  if (!body) return NextResponse.json({ accounts, preview: true });

  const account = accounts.find((item) => item.accountId === body.accountId);
  if ((body.action === 'discover' || body.action === 'initialize') && account) {
    const confirmations = [
      { kind: 'temporary', action: 'create', targetName: '临时' },
      { kind: 'restricted', action: 'create', targetName: '禁止 SP/RI' },
    ];
    const discovery = { account, temporaryOu: null, restrictedOu: null, temporaryOuId: '', restrictedOuId: '', confirmations };
    return NextResponse.json({ confirmationRequired: body.action === 'initialize', confirmations, discovery, members: [], preview: true });
  }
  if (!account && body.accountId) return NextResponse.json({ error: '未找到目标分组中的代付账号' }, { status: 404 });

  return NextResponse.json({ error: '本地预览模式不会执行 AWS 操作；生产 Lambda 部署后才能归位' }, { status: 503 });
}
