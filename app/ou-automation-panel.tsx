'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import styles from './ou-automation.module.css';

type OuOption = { id: string; name: string; match?: 'saved' | 'exact' | 'compatible' | 'created' };
type ConfirmationItem = { kind: 'temporary' | 'restricted'; action: 'create' | 'reuse'; targetName: string; candidate?: OuOption };
type AutomationAccount = { accountId: string; remark: string; groupName: string; temporaryOuId: string; restrictedOuId: string; configured: boolean };
type Discovery = { account: AutomationAccount; temporaryOu: OuOption | null; restrictedOu: OuOption | null; temporaryOuId: string; restrictedOuId: string; confirmations?: ConfirmationItem[] };
type MemberAccount = { accountId: string; name: string; email: string; parentId: string; parentName: string; placement: 'ungrouped' | 'restricted' | 'temporary' | 'other' };
type MoveDestination = 'restricted' | 'temporary';

export type OuAutomationHandle = { initializeAccount: (accountId: string) => Promise<void> };

export const OuAutomationPanel = forwardRef<OuAutomationHandle, { onNotice: (message: string) => void }>(function OuAutomationPanel({ onNotice }, ref) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<AutomationAccount[]>([]);
  const [accountQuery, setAccountQuery] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [members, setMembers] = useState<MemberAccount[]>([]);
  const [memberQuery, setMemberQuery] = useState('');
  const [memberFilter, setMemberFilter] = useState<'all' | MemberAccount['placement']>('all');
  const [confirmations, setConfirmations] = useState<ConfirmationItem[]>([]);
  const [pendingMove, setPendingMove] = useState<{ member: MemberAccount; destination: MoveDestination } | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && !confirmations.length && !pendingMove && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open, confirmations.length, pendingMove]);

  async function request(body: Record<string, unknown>) {
    const response = await fetch('/api/ou-automation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as Record<string, unknown> & { error?: string; preview?: boolean };
    if (!response.ok) throw new Error(payload.error ?? 'OU 操作失败');
    setPreviewMode(Boolean(payload.preview));
    return payload;
  }

  async function loadAccounts(preferredAccountId = '') {
    const response = await fetch('/api/ou-automation', { cache: 'no-store' });
    const payload = await response.json() as { accounts?: AutomationAccount[]; error?: string; preview?: boolean };
    if (!response.ok) throw new Error(payload.error ?? '账号读取失败');
    setPreviewMode(Boolean(payload.preview));
    const next = payload.accounts ?? [];
    setAccounts(next);
    const nextId = preferredAccountId || selectedAccountId || next[0]?.accountId || '';
    setSelectedAccountId(nextId);
    return nextId;
  }

  async function inspect(accountId: string) {
    setSelectedAccountId(accountId);
    setDiscovery(null);
    setMembers([]);
    const payload = await request({ action: 'discover', accountId }) as { discovery?: Discovery; members?: MemberAccount[] };
    if (!payload.discovery) throw new Error('未返回 Organization 信息');
    setDiscovery(payload.discovery);
    setMembers(payload.members ?? []);
  }

  async function showPanel(preferredAccountId = '') {
    setOpen(true);
    setBusy(true);
    try {
      const accountId = await loadAccounts(preferredAccountId);
      if (accountId) await inspect(accountId);
      else { setDiscovery(null); setMembers([]); }
    } catch (error) { onNotice(error instanceof Error ? error.message : '读取失败'); }
    finally { setBusy(false); }
  }

  async function beginInitialization(accountId: string) {
    const payload = await request({ action: 'initialize', accountId }) as { confirmationRequired?: boolean; confirmations?: ConfirmationItem[]; discovery?: Discovery; preview?: boolean };
    if (payload.preview && payload.discovery) {
      setOpen(true);
      await loadAccounts(accountId);
      setDiscovery(payload.discovery);
      setMembers([]);
      return;
    }
    if (payload.confirmationRequired && payload.discovery) {
      setOpen(true);
      await loadAccounts(accountId);
      setDiscovery(payload.discovery);
      setConfirmations(payload.confirmations ?? payload.discovery.confirmations ?? []);
      return;
    }
    onNotice('OU 初始化完成');
    if (open) { await loadAccounts(accountId); await inspect(accountId); }
  }

  async function initializeAccount(accountId: string) {
    setBusy(true);
    try { await beginInitialization(accountId); }
    catch (error) { onNotice(error instanceof Error ? error.message : '账号已保存，但 OU 初始化失败'); }
    finally { setBusy(false); }
  }

  // The parent only needs a stable command handle; accountId makes this path independent of render state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ initializeAccount }), []);

  async function confirmInitialization(useCompatible: boolean) {
    if (!selectedAccountId) return;
    setBusy(true);
    try {
      await request({ action: 'initialize', accountId: selectedAccountId, confirmed: true, useCompatible });
      setConfirmations([]);
      await loadAccounts(selectedAccountId);
      await inspect(selectedAccountId);
      onNotice('OU 初始化完成');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'OU 初始化失败'); }
    finally { setBusy(false); }
  }

  async function run(accountId = '') {
    setBusy(true);
    try {
      const payload = await request(accountId ? { action: 'run', accountId } : { action: 'run-all' }) as { result?: { message?: string }; results?: unknown[] };
      onNotice(payload.result?.message ?? `已处理 ${payload.results?.length ?? 0} 个 Organization`);
      await loadAccounts(accountId || selectedAccountId);
      if (accountId || selectedAccountId) await inspect(accountId || selectedAccountId);
    } catch (error) { onNotice(error instanceof Error ? error.message : '归位失败'); }
    finally { setBusy(false); }
  }

  async function confirmMove() {
    if (!pendingMove || !selectedAccountId) return;
    setBusy(true);
    try {
      await request({ action: 'move-member', accountId: selectedAccountId, memberAccountId: pendingMove.member.accountId, destination: pendingMove.destination });
      setPendingMove(null);
      await inspect(selectedAccountId);
      onNotice('成员账号 OU 已更新');
    } catch (error) { onNotice(error instanceof Error ? error.message : '移动成员账号失败'); }
    finally { setBusy(false); }
  }

  const accountNeedle = accountQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleAccounts = accounts.filter((account) => !accountNeedle || [account.remark, account.accountId, account.groupName].some((value) => value.toLocaleLowerCase('zh-CN').includes(accountNeedle)));
  const memberNeedle = memberQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleMembers = members.filter((member) => (memberFilter === 'all' || member.placement === memberFilter) && (!memberNeedle || [member.name, member.email, member.accountId].some((value) => value.toLocaleLowerCase('zh-CN').includes(memberNeedle))));
  const hasCompatible = confirmations.some((item) => item.action === 'reuse');

  return <>
    <button className={styles.trigger} onClick={() => void showPanel()}>自动化OU归位</button>
    {open && <div className={styles.layer} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className={styles.dialog} role="dialog" aria-modal="true">
        <button className={styles.close} onClick={() => setOpen(false)}>×</button>
        <header className={styles.heading}><span>ORGANIZATION CONTROL</span><h2>OU 与成员账号</h2><p>{previewMode ? '本地预览，不执行 AWS 操作' : '管理代付 Organization 的成员账号'}</p></header>
        <div className={styles.toolbar}><strong>代付账号 {accounts.length}</strong><input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="搜索代付账号" aria-label="搜索代付账号" /></div>
        <div className={styles.layout}>
          <aside className={styles.accounts}>{accounts.length === 0 ? <p>暂无代付账号</p> : visibleAccounts.length === 0 ? <p>没有匹配账号</p> : visibleAccounts.map((account) => <button key={account.accountId} className={selectedAccountId === account.accountId ? styles.active : ''} onClick={() => { setBusy(true); void inspect(account.accountId).catch((error) => onNotice(error.message)).finally(() => setBusy(false)); }}><span>{account.remark.slice(0, 1).toUpperCase()}</span><div><strong>{account.remark}</strong><small>{account.accountId} · {account.groupName}</small></div>{account.configured && <i className={styles.ready}>已就绪</i>}</button>)}</aside>
          <section className={styles.config}>{busy && !discovery ? <div className={styles.empty}>正在读取...</div> : !discovery ? <div className={styles.empty}>选择一个代付账号</div> : <>
            <div className={styles.accountHead}><div><strong>{discovery.account.remark}</strong><small>{discovery.account.accountId}</small></div><button disabled={busy || previewMode || !discovery.restrictedOuId} onClick={() => void run(discovery.account.accountId)}>立即归位</button></div>
            <div className={styles.ouSummary}><div><span>临时</span><strong>{discovery.temporaryOu?.name ?? '未配置'}</strong></div><div><span>禁止 SP/RI</span><strong>{discovery.restrictedOu?.name ?? '未配置'}</strong></div>{(!discovery.temporaryOuId || !discovery.restrictedOuId) && <button disabled={busy || previewMode} onClick={() => void beginInitialization(discovery.account.accountId)}>初始化</button>}</div>
            <div className={styles.memberHead}><div><h3>成员账号</h3><span>{members.length}</span></div><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索名称、邮箱或账号 ID" /></div>
            <div className={styles.tabs}>{(['all', 'restricted', 'temporary'] as const).map((value) => <button key={value} className={memberFilter === value ? styles.selectedTab : ''} onClick={() => setMemberFilter(value)}>{placementLabel(value)}</button>)}</div>
            <div className={styles.memberList}>{visibleMembers.length === 0 ? <p>没有匹配的成员账号</p> : visibleMembers.map((member) => <div className={styles.memberRow} key={member.accountId}><div><strong>{member.name}</strong><small>{member.email}</small></div><code>{member.accountId}</code><span data-placement={member.placement}>{member.parentName}</span><select value="" disabled={busy || previewMode || !discovery.temporaryOuId || !discovery.restrictedOuId} onChange={(event) => setPendingMove({ member, destination: event.target.value as MoveDestination })}><option value="" disabled>调整 OU</option><option value="restricted">禁止 SP/RI</option><option value="temporary">临时</option></select></div>)}</div>
          </>}</section>
        </div>
        {confirmations.length > 0 && <div className={styles.confirmLayer}><div className={styles.confirmBox}><span>需要确认</span><h3>初始化 OU</h3>{confirmations.map((item) => <p key={item.kind}>{item.action === 'create' ? `未找到“${item.targetName}”，是否创建？` : `发现相似 OU“${item.candidate?.name}”，是否作为“${item.targetName}”？`}</p>)}<div><button onClick={() => setConfirmations([])}>取消</button>{hasCompatible && <button onClick={() => void confirmInitialization(false)}>不使用相似项</button>}<button className={styles.primary} onClick={() => void confirmInitialization(true)}>{hasCompatible ? '确认使用' : '确认创建'}</button></div></div></div>}
        {pendingMove && <div className={styles.confirmLayer}><div className={styles.confirmBox}><span>调整 OU</span><h3>{pendingMove.member.name}</h3><p>移动到“{placementLabel(pendingMove.destination)}”？移到临时后，次日 02:00 会自动归位。</p><div><button onClick={() => setPendingMove(null)}>取消</button><button className={styles.primary} disabled={busy} onClick={() => void confirmMove()}>确认移动</button></div></div></div>}
      </section>
    </div>}
  </>;
});

function placementLabel(value: 'all' | MemberAccount['placement']) {
  if (value === 'all') return '全部';
  if (value === 'ungrouped') return '未分组';
  if (value === 'restricted') return '禁止 SP/RI';
  if (value === 'temporary') return '临时';
  return '其他 OU';
}
