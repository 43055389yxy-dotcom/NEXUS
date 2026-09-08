'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { MfaRecoveryPanel } from './mfa-recovery-panel';
import styles from './ou-automation.module.css';

type OuOption = { id: string; name: string; path?: string; match?: 'created' };
type AutomationAccount = { accountId: string; remark: string; groupName: string; temporaryOuId: string; restrictedOuId: string; configured: boolean };
type Discovery = { account: AutomationAccount; ous: OuOption[]; temporaryOu: OuOption | null; restrictedOu: OuOption | null; temporaryOuId: string; restrictedOuId: string };
type MemberAccount = { accountId: string; name: string; email: string; parentId: string; parentName: string; placement: 'ungrouped' | 'restricted' | 'temporary' | 'other' };
type MovedAccount = { accountId: string; name: string; email: string; sourceParentName: string; destinationParentName: string };
type HistoryEntry = { payerAccountId: string; payerRemark: string; occurredAt: string; mode: 'automatic' | 'manual'; status: 'success' | 'failed'; checked: number; moved: number; skipped: number; message: string; movedAccounts: MovedAccount[] };

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
  const [mappingOpen, setMappingOpen] = useState(false);
  const [temporarySelection, setTemporarySelection] = useState('');
  const [restrictedSelection, setRestrictedSelection] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [previewMode, setPreviewMode] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (historyOpen) setHistoryOpen(false);
      else if (mappingOpen) setMappingOpen(false);
      else setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open, historyOpen, mappingOpen]);

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
    return payload.discovery;
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

  function prepareMapping(value: Discovery) {
    const ous = value.ous ?? [];
    setTemporarySelection(initialOuSelection(value.temporaryOuId, ous, '临时'));
    setRestrictedSelection(initialOuSelection(value.restrictedOuId, ous, '禁止 SP/RI'));
    setMappingOpen(true);
  }

  async function openMapping(accountId: string) {
    const payload = await request({ action: 'ou-options', accountId }) as { discovery?: Discovery };
    if (!payload.discovery) throw new Error('未返回 OU 列表');
    setSelectedAccountId(accountId);
    setDiscovery(payload.discovery);
    prepareMapping(payload.discovery);
  }

  async function beginMapping(accountId: string) {
    setBusy(true);
    try { await openMapping(accountId); }
    catch (error) { onNotice(error instanceof Error ? error.message : 'OU 读取失败'); }
    finally { setBusy(false); }
  }

  async function saveMapping() {
    if (!discovery || !mappingSelectionValid(temporarySelection, restrictedSelection)) return;
    setBusy(true);
    try {
      const payload = await request({ action: 'initialize', accountId: discovery.account.accountId, temporaryOuId: temporarySelection === '__create__' ? '' : temporarySelection, restrictedOuId: restrictedSelection === '__create__' ? '' : restrictedSelection, createTemporary: temporarySelection === '__create__', createRestricted: restrictedSelection === '__create__' }) as { discovery?: Discovery; members?: MemberAccount[] };
      if (!payload.discovery) throw new Error('OU 映射保存失败');
      setDiscovery(payload.discovery);
      setMembers(payload.members ?? []);
      setMappingOpen(false);
      await loadAccounts(discovery.account.accountId);
      setRecoveryCheckAccountId(discovery.account.accountId);
      onNotice('OU 映射已保存，未移动任何成员账号');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'OU 映射保存失败'); }
    finally { setBusy(false); }
  }

  async function initializeAccount(accountId: string) {
    setOpen(true);
    setBusy(true);
    try { await loadAccounts(accountId); setMembers([]); setSelectedMemberId(''); await openMapping(accountId); }
    catch (error) { onNotice(error instanceof Error ? error.message : '账号已保存，但 OU 扫描失败'); }
    finally { setBusy(false); }
  }

  // The parent only needs a stable command handle; accountId makes this path independent of render state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ initializeAccount }), []);

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

  const accountNeedle = accountQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleAccounts = accounts.filter((account) => !accountNeedle || [account.remark, account.accountId, account.groupName].some((value) => value.toLocaleLowerCase('zh-CN').includes(accountNeedle)));
  const memberNeedle = memberQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleMembers = members.filter((member) => (memberFilter === 'all' || member.placement === memberFilter) && (!memberNeedle || [member.name, member.email, member.accountId].some((value) => value.toLocaleLowerCase('zh-CN').includes(memberNeedle))));
  const selectedMember = members.find((member) => member.accountId === selectedMemberId) ?? null;
  const mappingOus = discovery?.ous ?? [];
  const canSaveMapping = mappingSelectionValid(temporarySelection, restrictedSelection);
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
            <div className={styles.accountHead}><div><strong>{discovery.account.remark}</strong><small>{discovery.account.accountId}</small></div><aside className={styles.accountActions}><button disabled={busy || previewMode} onClick={() => void openHistory()}>操作记录</button><button disabled={busy || previewMode || !discovery.restrictedOuId} onClick={() => void run(discovery.account.accountId)}>立即归位</button></aside></div>
            <div className={styles.ouSummary}><div><span>临时</span><strong>{discovery.temporaryOu?.name ?? '未配置'}</strong></div><div><span>禁止 SP/RI</span><strong>{discovery.restrictedOu?.name ?? '未配置'}</strong></div><button disabled={busy || previewMode} onClick={() => void beginMapping(discovery.account.accountId)}>{discovery.account.configured ? '修改映射' : '选择映射'}</button></div>
            <div className={styles.memberHead}><div><h3>成员账号</h3><span>{members.length}</span></div><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索名称、邮箱或账号 ID" /></div>
            <div className={styles.tabs}>{(['temporary', 'all', 'restricted'] as const).map((value) => <button key={value} className={memberFilter === value ? styles.selectedTab : ''} onClick={() => setMemberFilter(value)}>{placementLabel(value)}</button>)}</div>
            <MfaRecoveryPanel payerAccountId={discovery.account.accountId} member={selectedMember} disabled={busy || previewMode} autoCheck={recoveryCheckAccountId === discovery.account.accountId} onAutoCheckComplete={() => setRecoveryCheckAccountId('')} onNotice={onNotice} />
            <div className={styles.memberList}>{visibleMembers.length === 0 ? <p>没有匹配的成员账号</p> : visibleMembers.map((member) => <div className={styles.memberRow} key={member.accountId}><div><label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><input aria-label={`选择 ${member.name}`} type="checkbox" checked={selectedMemberId === member.accountId} onChange={() => setSelectedMemberId((current) => current === member.accountId ? '' : member.accountId)} /><strong>{member.name}</strong></label><small>{member.email}</small></div><code>{member.accountId}</code></div>)}</div>
          </>}</section>
        </div>
        {mappingOpen && discovery && <div className={styles.confirmLayer}><section className={`${styles.confirmBox} ${styles.mappingBox}`}><span>OU MAPPING</span><h3>选择 OU 映射</h3><p>这里只保存映射，不会移动任何成员账号。同名 OU 请根据路径和 ID 选择。</p><section className={styles.mappingFields}><label><span>临时 OU</span><select value={temporarySelection} onChange={(event) => setTemporarySelection(event.target.value)}><option value="" disabled>请选择临时 OU</option>{mappingOus.map((ou) => <option key={`temporary-${ou.id}`} value={ou.id}>{ouOptionLabel(ou)}</option>)}{!hasNamedOu(mappingOus, '临时') && <option value="__create__">不存在，创建“临时”</option>}</select></label><label><span>禁止 SP/RI OU</span><select value={restrictedSelection} onChange={(event) => setRestrictedSelection(event.target.value)}><option value="" disabled>请选择禁止 OU</option>{mappingOus.map((ou) => <option key={`restricted-${ou.id}`} value={ou.id}>{ouOptionLabel(ou)}</option>)}{!hasNamedOu(mappingOus, '禁止 SP/RI') && <option value="__create__">不存在，创建“禁止 SP/RI”</option>}</select></label>{temporarySelection && restrictedSelection && !canSaveMapping && <em>临时和禁止 SP/RI 不能选择同一个 OU</em>}</section><div><button disabled={busy} onClick={() => setMappingOpen(false)}>取消</button><button className={styles.primary} disabled={busy || !canSaveMapping} onClick={() => void saveMapping()}>{busy ? '保存中...' : '确认映射'}</button></div></section></div>}
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

function normalizedOuName(value: string) { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN'); }
function hasNamedOu(ous: OuOption[], name: string) { return ous.some((ou) => normalizedOuName(ou.name) === normalizedOuName(name)); }
function initialOuSelection(mappedId: string, ous: OuOption[], name: string) { return mappedId || (hasNamedOu(ous, name) ? '' : '__create__'); }
function mappingSelectionValid(temporary: string, restricted: string) { return Boolean(temporary && restricted && (temporary === '__create__' || restricted === '__create__' || temporary !== restricted)); }
function ouOptionLabel(ou: OuOption) { return `${ou.path || ou.name} (${ou.id})`; }

function formatHistoryDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知日期' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatHistoryTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
