'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { MfaRecoveryPanel } from './mfa-recovery-panel';
import styles from './ou-automation.module.css';

type AutomationAccount = { accountId: string; remark: string; groupName: string; lastRunAt?: string; lastStatus?: string };
type Discovery = { account: AutomationAccount; policyName: string; policyId?: string };
type RestrictionStatus = 'restricted' | 'missing' | 'exempt';
type MemberAccount = { accountId: string; name: string; email: string; restrictionStatus: RestrictionStatus; restricted: boolean; exempt: boolean };
type ChangedAccount = { accountId: string; name: string; email: string; sourceParentName: string; destinationParentName: string };
type HistoryEntry = { payerAccountId: string; payerRemark: string; occurredAt: string; mode: 'automatic' | 'manual' | 'cloudsweep'; status: 'success' | 'failed'; checked: number; moved: number; skipped: number; message: string; movedAccounts: ChangedAccount[] };
type DiscoveryPayload = { discovery?: Discovery; members?: MemberAccount[]; cachedAt?: string; preview?: boolean };

export type OuAutomationHandle = { initializeAccount: (accountId: string) => Promise<void> };

export const OuAutomationPanel = forwardRef<OuAutomationHandle, { onNotice: (message: string) => void }>(function OuAutomationPanel({ onNotice }, ref) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<AutomationAccount[]>([]);
  const [accountQuery, setAccountQuery] = useState('');
  const [globalMemberId, setGlobalMemberId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [members, setMembers] = useState<MemberAccount[]>([]);
  const [cachedAt, setCachedAt] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [memberFilter, setMemberFilter] = useState<'all' | RestrictionStatus>('all');
  const [recoveryCheckAccountId, setRecoveryCheckAccountId] = useState('');
  const [pendingChange, setPendingChange] = useState<{ member: MemberAccount; enabled: boolean } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [previewMode, setPreviewMode] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (historyOpen) setHistoryOpen(false);
      else if (pendingChange) setPendingChange(null);
      else setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open, historyOpen, pendingChange]);

  async function request(body: Record<string, unknown>) {
    const response = await fetch('/api/ou-automation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as Record<string, unknown> & { error?: string; preview?: boolean };
    if (!response.ok) throw new Error(payload.error ?? '客户限制操作失败');
    setPreviewMode(Boolean(payload.preview));
    return payload;
  }

  function applyDiscovery(payload: DiscoveryPayload) {
    if (!payload.discovery) throw new Error('未返回客户账号信息');
    setDiscovery(payload.discovery);
    setSelectedAccountId(payload.discovery.account.accountId);
    setMembers(payload.members ?? []);
    setCachedAt(payload.cachedAt ?? new Date().toISOString());
  }

  async function loadAccounts(preferredAccountId = '') {
    const response = await fetch('/api/ou-automation', { cache: 'no-store' });
    const payload = await response.json() as { accounts?: AutomationAccount[]; error?: string; preview?: boolean };
    if (!response.ok) throw new Error(payload.error ?? '代付账号读取失败');
    setPreviewMode(Boolean(payload.preview));
    const next = payload.accounts ?? [];
    setAccounts(next);
    const nextId = preferredAccountId || selectedAccountId || next[0]?.accountId || '';
    setSelectedAccountId(nextId);
    return nextId;
  }

  async function inspect(accountId: string, force = false) {
    setSelectedAccountId(accountId);
    setDiscovery(null);
    setMembers([]);
    const payload = await request({ action: 'discover', accountId, force }) as DiscoveryPayload;
    applyDiscovery(payload);
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

  async function initializeAccount(accountId: string) {
    setOpen(true);
    setBusy(true);
    try {
      await loadAccounts(accountId);
      await inspect(accountId, true);
      onNotice('账号已接入，可以同步客户限制');
    } catch (error) { onNotice(error instanceof Error ? error.message : '账号已保存，但客户扫描失败'); }
    finally { setBusy(false); }
  }

  // The parent only needs a stable command handle; accountId makes this independent of render state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ initializeAccount }), []);

  async function syncAccount(accountId: string) {
    setBusy(true);
    try {
      const payload = await request({ action: 'run', accountId }) as { result?: { message?: string } };
      onNotice(payload.result?.message ?? '客户限制同步完成');
      await loadAccounts(accountId);
      await inspect(accountId, true);
    } catch (error) { onNotice(error instanceof Error ? error.message : '客户限制同步失败'); }
    finally { setBusy(false); }
  }

  async function findMember() {
    const memberAccountId = globalMemberId.trim();
    if (!/^\d{12}$/.test(memberAccountId)) { onNotice('请输入 12 位客户账号 ID'); return; }
    setBusy(true);
    try {
      const payload = await request({ action: 'find-member', memberAccountId }) as DiscoveryPayload & { selectedAccountId?: string; memberAccountId?: string };
      applyDiscovery(payload);
      setMemberQuery(memberAccountId);
      setMemberFilter('all');
      onNotice(`已找到客户账号 ${memberAccountId}`);
    } catch (error) { onNotice(error instanceof Error ? error.message : '没有找到该客户账号'); }
    finally { setBusy(false); }
  }

  async function saveRestrictionChange() {
    if (!pendingChange || !discovery) return;
    setBusy(true);
    try {
      const payload = await request({ action: 'set-member-restriction', accountId: discovery.account.accountId, memberAccountId: pendingChange.member.accountId, enabled: pendingChange.enabled, confirmed: true }) as DiscoveryPayload & { result?: { message?: string } };
      applyDiscovery(payload);
      onNotice(payload.result?.message ?? (pendingChange.enabled ? '限制已添加' : '限制已取消'));
      setPendingChange(null);
    } catch (error) { onNotice(error instanceof Error ? error.message : '客户限制修改失败'); }
    finally { setBusy(false); }
  }

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const responses = await Promise.all(accounts.map(async (account) => {
        try {
          const payload = await request({ action: 'history', accountId: account.accountId }) as { history?: HistoryEntry[] };
          return { history: payload.history ?? [], error: '' };
        } catch (error) { return { history: [] as HistoryEntry[], error: error instanceof Error ? error.message : '读取失败' }; }
      }));
      const successful = responses.filter((response) => !response.error);
      if (accounts.length > 0 && successful.length === 0) throw new Error(responses[0]?.error || '操作记录读取失败');
      const unique = new Map<string, HistoryEntry>();
      for (const entry of successful.flatMap((response) => response.history)) unique.set(`${entry.payerAccountId}-${entry.occurredAt}-${entry.mode}`, entry);
      setHistoryEntries([...unique.values()].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)));
      if (successful.length < responses.length) onNotice(`${responses.length - successful.length} 个代付账号的记录读取失败`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作记录读取失败';
      setHistoryEntries([]);
      setHistoryError(message);
      onNotice(message);
    } finally { setHistoryLoading(false); }
  }

  const accountNeedle = accountQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleAccounts = accounts.filter((account) => !accountNeedle || [account.remark, account.accountId, account.groupName].some((value) => value.toLocaleLowerCase('zh-CN').includes(accountNeedle)));
  const memberNeedle = memberQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleMembers = members.filter((member) => (memberFilter === 'all' || member.restrictionStatus === memberFilter) && (!memberNeedle || [member.name, member.email, member.accountId].some((value) => value.toLocaleLowerCase('zh-CN').includes(memberNeedle))));
  const counts = members.reduce((value, member) => ({ ...value, [member.restrictionStatus]: value[member.restrictionStatus] + 1 }), { restricted: 0, missing: 0, exempt: 0 });
  const historyGroups = historyEntries.reduce<Record<string, HistoryEntry[]>>((groups, entry) => {
    const date = formatHistoryDate(entry.occurredAt);
    groups[date] = [...(groups[date] ?? []), entry];
    return groups;
  }, {});

  return <>
    <button className={styles.trigger} onClick={() => void showPanel()}>客户账号限制</button>
    {open && <div className={styles.layer} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className={styles.dialog} role="dialog" aria-modal="true">
        <button className={styles.close} onClick={() => setOpen(false)}>×</button>
        <header className={styles.heading}><span>ACCOUNT GUARDRAILS</span><h2>客户账号限制</h2><p>{previewMode ? '本地预览，不执行 AWS 操作' : '直接按账号 ID 管理 5 项限制，不依赖 OU'}</p></header>
        <div className={styles.toolbar}>
          <strong>代付账号 {accounts.length}</strong>
          <input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="搜索代付账号" aria-label="搜索代付账号" />
          <div className={styles.globalSearch}><input inputMode="numeric" maxLength={12} value={globalMemberId} onChange={(event) => setGlobalMemberId(event.target.value.replace(/\D/g, '').slice(0, 12))} onKeyDown={(event) => event.key === 'Enter' && void findMember()} placeholder="输入客户账号 ID" aria-label="输入客户账号 ID" /><button disabled={busy} onClick={() => void findMember()}>查找</button></div>
          <aside className={styles.accountActions}><button disabled={busy || previewMode} onClick={() => void openHistory()}>操作记录</button></aside>
        </div>
        <div className={styles.layout}>
          <aside className={styles.accounts}>{accounts.length === 0 ? <p>暂无代付账号</p> : visibleAccounts.length === 0 ? <p>没有匹配账号</p> : visibleAccounts.map((account) => <button key={account.accountId} className={selectedAccountId === account.accountId ? styles.active : ''} onClick={() => { setBusy(true); setMemberQuery(''); void inspect(account.accountId).catch((error) => onNotice(error.message)).finally(() => setBusy(false)); }}><span>{account.remark.slice(0, 1).toUpperCase()}</span><div><strong>{account.remark}</strong><small>{account.accountId} · {account.groupName}</small></div>{account.lastStatus === 'failed' && <i data-status="failed">异常</i>}</button>)}</aside>
          <section className={styles.config}>{busy && !discovery ? <div className={styles.empty}>正在读取...</div> : !discovery ? <div className={styles.empty}>选择一个代付账号</div> : <>
            <div className={styles.accountHead}><div><strong>{discovery.account.remark}</strong><small>{discovery.account.accountId}{cachedAt ? ` · 更新 ${formatHistoryTime(cachedAt)}` : ''}</small></div><aside className={styles.accountActions}><button disabled={busy || previewMode} onClick={() => void syncAccount(discovery.account.accountId)}>{busy ? '同步中...' : '同步全部客户'}</button></aside></div>
            <div className={styles.guardrailStats}><div><span>客户</span><strong>{members.length}</strong></div><div data-status="restricted"><span>已限制</span><strong>{counts.restricted}</strong></div><div data-status="missing"><span>待添加</span><strong>{counts.missing}</strong></div><div data-status="exempt"><span>已取消</span><strong>{counts.exempt}</strong></div></div>
            <div className={styles.memberHead}><div><h3>客户账号</h3><span>{members.length}</span></div><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索名称、邮箱或账号 ID" /></div>
            <div className={styles.tabs}>{(['all', 'restricted', 'missing', 'exempt'] as const).map((value) => <button key={value} className={memberFilter === value ? styles.selectedTab : ''} onClick={() => setMemberFilter(value)}>{restrictionLabel(value)}</button>)}</div>
            <MfaRecoveryPanel payerAccountId={discovery.account.accountId} autoCheck={recoveryCheckAccountId === discovery.account.accountId} onAutoCheckComplete={() => setRecoveryCheckAccountId('')} onNotice={onNotice} />
            <div className={styles.memberList}>{visibleMembers.length === 0 ? <p>没有匹配的客户账号</p> : visibleMembers.map((member) => <div className={styles.memberRow} key={member.accountId}><div><strong>{member.name}</strong><small>{member.email}</small></div><code>{member.accountId}</code><i data-status={member.restrictionStatus}>{restrictionLabel(member.restrictionStatus)}</i><button disabled={busy || previewMode} data-action={member.restricted ? 'remove' : 'add'} onClick={() => setPendingChange({ member, enabled: !member.restricted })}>{member.restricted ? '取消限制' : '添加限制'}</button></div>)}</div>
          </>}</section>
        </div>
        {pendingChange && <div className={styles.confirmLayer}><section className={styles.confirmBox}><span>CONFIRM CHANGE</span><h3>{pendingChange.enabled ? '添加 5 项限制' : '取消 5 项限制'}</h3><p><strong>{pendingChange.member.name}</strong>（{pendingChange.member.accountId}）</p><p>{pendingChange.enabled ? '将禁止购买 SP、EC2 RI、RDS RI，以及退出组织和关闭账号。' : '只解除这 5 项限制；客户原有 IAM 权限不会被删除。'}</p><div><button disabled={busy} onClick={() => setPendingChange(null)}>返回</button><button className={styles.primary} disabled={busy} onClick={() => void saveRestrictionChange()}>{busy ? '处理中...' : '确认'}</button></div></section></div>}
        {historyOpen && <div className={styles.confirmLayer}><section className={styles.historyBox}><header><div><span>OPERATION LOG</span><h3>客户限制 · 操作记录</h3></div><button onClick={() => setHistoryOpen(false)}>×</button></header><div className={styles.historyBody}>{historyLoading ? <p>正在读取...</p> : historyError ? <p className={styles.historyError}>{historyError}</p> : historyEntries.length === 0 ? <p>暂无操作记录</p> : Object.entries(historyGroups).map(([date, entries]) => <section key={date}><h4>{date}</h4>{entries.map((entry) => <article key={`${entry.payerAccountId}-${entry.occurredAt}-${entry.mode}`}><div className={styles.historySummary}><time>{formatHistoryTime(entry.occurredAt)}</time><i data-mode={entry.mode}>{entry.mode === 'automatic' ? '自动任务' : '手动操作'}</i><b data-status={entry.status}>{entry.status === 'success' ? '成功' : '失败'}</b><p><strong>{entry.payerRemark}</strong><small>{entry.payerAccountId}</small><span>{entry.status === 'failed' && entry.checked === 0 && entry.moved === 0 && entry.skipped === 0 ? '未执行扫描' : `检查 ${entry.checked} · 变更 ${entry.moved} · 跳过 ${entry.skipped}`}</span></p></div><em className={entry.status === 'failed' ? styles.historyFailure : styles.historyMessage}>{entry.message}</em>{entry.movedAccounts.length > 0 && <div className={styles.movedAccounts}>{entry.movedAccounts.map((member) => <div key={`${entry.occurredAt}-${member.accountId}`}><span><strong>{member.name}</strong><small>{member.accountId}</small></span><p>{member.sourceParentName}<b>→</b>{member.destinationParentName}</p></div>)}</div>}</article>)}</section>)}</div></section></div>}
      </section>
    </div>}
  </>;
});

function restrictionLabel(value: 'all' | RestrictionStatus) {
  if (value === 'all') return '全部';
  if (value === 'restricted') return '已限制';
  if (value === 'missing') return '待添加';
  return '已取消';
}

function formatHistoryDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知日期' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatHistoryTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
