'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { MfaRecoveryPanel } from './mfa-recovery-panel';
import styles from './ou-automation.module.css';

type OuOption = { id: string; name: string; match?: 'saved' | 'exact' | 'compatible' | 'created' };
type ConfirmationItem = { kind: 'temporary' | 'restricted' | 'standardize'; action: 'create' | 'reuse' | 'standardize'; targetName: string; candidate?: OuOption };
type AutomationAccount = { accountId: string; remark: string; groupName: string; temporaryOuId: string; restrictedOuId: string; configured: boolean };
type Discovery = { account: AutomationAccount; temporaryOu: OuOption | null; restrictedOu: OuOption | null; temporaryOuId: string; restrictedOuId: string; confirmations?: ConfirmationItem[] };
type MemberAccount = { accountId: string; name: string; email: string; parentId: string; parentName: string; placement: 'ungrouped' | 'restricted' | 'temporary' | 'other' };
type MoveDestination = 'restricted' | 'temporary';
type MovedAccount = { accountId: string; name: string; email: string; sourceParentName: string; destinationParentName: string };
type HistoryEntry = { payerAccountId: string; payerRemark: string; occurredAt: string; mode: 'automatic' | 'manual'; status: 'success' | 'failed'; checked: number; moved: number; skipped: number; message: string; movedAccounts: MovedAccount[] };
type OuMapping = { accountId: string; options: OuOption[]; temporaryOuId: string; restrictedOuId: string; temporaryMissing?: boolean; restrictedMissing?: boolean };

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
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [recoveryCheckAccountId, setRecoveryCheckAccountId] = useState('');
  const [confirmations, setConfirmations] = useState<ConfirmationItem[]>([]);
  const [pendingMove, setPendingMove] = useState<{ member: MemberAccount; destination: MoveDestination } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [mapping, setMapping] = useState<OuMapping | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (historyOpen) setHistoryOpen(false);
      else if (mapping) setMapping(null);
      else if (!confirmations.length && !pendingMove) setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open, confirmations.length, pendingMove, historyOpen, mapping]);

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
    setSelectedMemberId('');
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
    const payload = await request({ action: 'initialize', accountId }) as { confirmationRequired?: boolean; confirmations?: ConfirmationItem[]; mappingRequired?: boolean; mapping?: OuMapping; discovery?: Discovery; preview?: boolean };
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
    if (payload.mappingRequired && payload.mapping && payload.discovery) {
      setOpen(true);
      await loadAccounts(accountId);
      setDiscovery(payload.discovery);
      setMapping(payload.mapping);
      return;
    }
    onNotice('OU 初始化完成');
    if (open) { await loadAccounts(accountId); await inspect(accountId); }
  }

  async function initializeAccount(accountId: string) {
    setOpen(true);
    setBusy(true);
    try { await beginInitialization(accountId); await loadAccounts(accountId); await inspect(accountId); setRecoveryCheckAccountId(accountId); }
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

  async function openHistory() {
    if (!selectedAccountId) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const payload = await request({ action: 'history', accountId: selectedAccountId }) as { history?: HistoryEntry[] };
      setHistoryEntries(payload.history ?? []);
    } catch (error) { onNotice(error instanceof Error ? error.message : '操作记录读取失败'); }
    finally { setHistoryLoading(false); }
  }

  async function openMapping() {
    if (!selectedAccountId) return;
    setBusy(true);
    try {
      const payload = await request({ action: 'mapping-options', accountId: selectedAccountId }) as { mapping?: OuMapping };
      if (!payload.mapping) throw new Error('未返回 OU 列表');
      setMapping(payload.mapping);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'OU 映射读取失败'); }
    finally { setBusy(false); }
  }

  async function saveMapping() {
    if (!mapping) return;
    setBusy(true);
    try {
      await request({ action: 'configure-mapping', accountId: mapping.accountId, temporaryOuId: mapping.temporaryOuId, restrictedOuId: mapping.restrictedOuId });
      setMapping(null);
      await loadAccounts(mapping.accountId);
      await inspect(mapping.accountId);
      onNotice('OU 映射已保存');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'OU 映射保存失败'); }
    finally { setBusy(false); }
  }

  const accountNeedle = accountQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleAccounts = accounts.filter((account) => !accountNeedle || [account.remark, account.accountId, account.groupName].some((value) => value.toLocaleLowerCase('zh-CN').includes(accountNeedle)));
  const memberNeedle = memberQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleMembers = members.filter((member) => (memberFilter === 'all' || member.placement === memberFilter) && (!memberNeedle || [member.name, member.email, member.accountId].some((value) => value.toLocaleLowerCase('zh-CN').includes(memberNeedle))));
  const selectedMember = members.find((member) => member.accountId === selectedMemberId) ?? null;
  const hasCompatible = confirmations.some((item) => item.action === 'reuse');
  const historyGroups = historyEntries.reduce<Record<string, HistoryEntry[]>>((groups, entry) => {
    const date = formatHistoryDate(entry.occurredAt);
    groups[date] = [...(groups[date] ?? []), entry];
    return groups;
  }, {});

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
            <div className={styles.accountHead}><div><strong>{discovery.account.remark}</strong><small>{discovery.account.accountId}</small></div><aside className={styles.accountActions}><button disabled={busy || previewMode} onClick={() => void openMapping()}>OU 映射</button><button disabled={busy || previewMode} onClick={() => void openHistory()}>操作记录</button><button disabled={busy || previewMode || !discovery.restrictedOuId} onClick={() => void run(discovery.account.accountId)}>立即归位</button></aside></div>
            <div className={styles.ouSummary}><div><span>临时</span><strong>{discovery.temporaryOu?.name ?? '未配置'}</strong></div><div><span>禁止 SP/RI</span><strong>{discovery.restrictedOu?.name ?? '未配置'}</strong></div>{(!discovery.temporaryOuId || !discovery.restrictedOuId) && <button disabled={busy || previewMode} onClick={() => void beginInitialization(discovery.account.accountId)}>初始化</button>}</div>
            <div className={styles.memberHead}><div><h3>成员账号</h3><span>{members.length}</span></div><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索名称、邮箱或账号 ID" /></div>
            <div className={styles.tabs}>{(['all', 'restricted', 'temporary'] as const).map((value) => <button key={value} className={memberFilter === value ? styles.selectedTab : ''} onClick={() => setMemberFilter(value)}>{placementLabel(value)}</button>)}</div>
            <MfaRecoveryPanel payerAccountId={discovery.account.accountId} member={selectedMember} disabled={busy || previewMode} autoCheck={recoveryCheckAccountId === discovery.account.accountId} onAutoCheckComplete={() => setRecoveryCheckAccountId('')} onNotice={onNotice} />
            <div className={styles.memberList}>{visibleMembers.length === 0 ? <p>没有匹配的成员账号</p> : visibleMembers.map((member) => <div className={styles.memberRow} key={member.accountId}><div><label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input aria-label={`选择 ${member.name}`} type="checkbox" checked={selectedMemberId === member.accountId} onChange={() => setSelectedMemberId((current) => current === member.accountId ? '' : member.accountId)} /><strong>{member.name}</strong></label><small>{member.email}</small></div><code>{member.accountId}</code><select value={member.placement === 'restricted' || member.placement === 'temporary' ? member.placement : 'current'} disabled={busy || previewMode || !discovery.temporaryOuId || !discovery.restrictedOuId} onChange={(event) => setPendingMove({ member, destination: event.target.value as MoveDestination })}><option value="current" disabled>{member.parentName || '其他 OU'}</option><option value="restricted">禁止 SP/RI</option><option value="temporary">临时</option></select></div>)}</div>
          </>}</section>
        </div>
        {confirmations.length > 0 && <div className={styles.confirmLayer}><div className={styles.confirmBox}><span>需要确认</span><h3>统一 OU</h3>{confirmations.map((item) => <p key={item.kind}>{item.action === 'create' ? `未找到“${item.targetName}”，确认后将创建。` : item.action === 'reuse' ? `发现相似 OU“${item.candidate?.name}”，确认后将重命名为“${item.targetName}”。` : '确认后将统一两个 OU 的名称和直接挂载策略；其他 OU 不会修改。'}</p>)}<div><button onClick={() => setConfirmations([])}>取消</button>{hasCompatible && <button onClick={() => void confirmInitialization(false)}>不复用，全部新建并执行</button>}<button className={styles.primary} onClick={() => void confirmInitialization(true)}>{hasCompatible ? '复用并执行' : '确认创建并执行'}</button></div></div></div>}
        {pendingMove && <div className={styles.confirmLayer}><div className={styles.confirmBox}><span>成员账号</span><h3>{pendingMove.member.name}</h3><p>移动到“{placementLabel(pendingMove.destination)}”？移到临时后，次日 02:00 会自动归位。</p><div><button onClick={() => setPendingMove(null)}>取消</button><button className={styles.primary} disabled={busy} onClick={() => void confirmMove()}>确认移动</button></div></div></div>}
        {mapping && <div className={styles.confirmLayer}><div className={styles.confirmBox}><span>OU MAPPING</span><h3>确认两个目标 OU</h3><p>执行后会统一名称和直接挂载策略，其他 OU 不会修改。</p><label style={{ display: 'grid', gap: 7, marginTop: 14, color: '#a5b5c8', fontSize: 12 }}>临时<select style={{ height: 42, padding: '0 10px', borderRadius: 9, border: '1px solid rgba(126,154,195,.2)', color: '#d5e1ef', background: '#091522' }} value={mapping.temporaryOuId} onChange={(event) => setMapping((current) => current ? { ...current, temporaryOuId: event.target.value } : current)}><option value="" disabled>请选择</option>{mapping.temporaryMissing && <option value="__create__">创建标准“临时”</option>}{mapping.options.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.id}</option>)}</select></label><label style={{ display: 'grid', gap: 7, marginTop: 14, color: '#a5b5c8', fontSize: 12 }}>禁止 SP/RI<select style={{ height: 42, padding: '0 10px', borderRadius: 9, border: '1px solid rgba(126,154,195,.2)', color: '#d5e1ef', background: '#091522' }} value={mapping.restrictedOuId} onChange={(event) => setMapping((current) => current ? { ...current, restrictedOuId: event.target.value } : current)}><option value="" disabled>请选择</option>{mapping.restrictedMissing && <option value="__create__">创建标准“禁止 SP/RI”</option>}{mapping.options.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.id}</option>)}</select></label><div><button disabled={busy} onClick={() => setMapping(null)}>取消</button><button className={styles.primary} disabled={busy || !mapping.temporaryOuId || !mapping.restrictedOuId || (mapping.temporaryOuId === mapping.restrictedOuId && mapping.temporaryOuId !== '__create__')} onClick={() => void saveMapping()}>确认并执行</button></div></div></div>}
        {historyOpen && <div className={styles.confirmLayer}><section className={styles.historyBox}><header><div><span>OPERATION LOG</span><h3>{discovery?.account.remark} · 操作记录</h3></div><button onClick={() => setHistoryOpen(false)}>×</button></header><div className={styles.historyBody}>{historyLoading ? <p>正在读取...</p> : historyEntries.length === 0 ? <p>暂无操作记录</p> : Object.entries(historyGroups).map(([date, entries]) => <section key={date}><h4>{date}</h4>{entries.map((entry) => <article key={`${entry.occurredAt}-${entry.mode}`}><div className={styles.historySummary}><time>{formatHistoryTime(entry.occurredAt)}</time><i data-mode={entry.mode}>{entry.mode === 'automatic' ? '自动任务' : '手动操作'}</i><b data-status={entry.status}>{entry.status === 'success' ? '成功' : '失败'}</b><p>检查 {entry.checked} · 移动 {entry.moved} · 跳过 {entry.skipped}</p></div>{entry.status === 'failed' && <em>{entry.message}</em>}{entry.movedAccounts.length > 0 && <div className={styles.movedAccounts}>{entry.movedAccounts.map((member) => <div key={`${entry.occurredAt}-${member.accountId}`}><span><strong>{member.name}</strong><small>{member.accountId}</small></span><p>{member.sourceParentName}<b>→</b>{member.destinationParentName}</p></div>)}</div>}</article>)}</section>)}</div></section></div>}
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

function formatHistoryDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知日期' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatHistoryTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
