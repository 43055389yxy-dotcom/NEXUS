'use client';

import { useMemo, useRef, useState } from 'react';
import { SupportBillingCache, snapshotIsFresh } from './support-billing-cache';
import styles from './support-billing.module.css';

type PeriodKey = 'current' | 'previous';
type SelectedPeriod = PeriodKey | `${number}-${number}`;
type Status = 'normal' | 'create' | 'update' | 'native_visible' | 'query_error' | 'zero_risk' | 'mapping_error' | 'mapping_ignored' | 'duplicate_cli' | 'period_range_error' | 'manual_deleted';
type BillingPeriod = { aws: number | null; synced: number | null; status: Status; suggestion: string; billingGroupMember: boolean; customLineItemArn?: string; customLineItemName?: string };
type BillingAccount = { id: string; name: string; cma: string; autoSyncEnabled?: boolean; current: BillingPeriod; previous: BillingPeriod; historical?: BillingPeriod; history?: { date: string; action: string; amount: string }[] };
type Snapshot = { lastScanAt: string; months: Record<PeriodKey, string>; historyMonth?: string; accounts: BillingAccount[] };
type Payer = { accountId: string; remark: string; groupName: string; architecture: 'pma' | 'legacy_payer'; autoSyncOverrides?: Record<string, boolean>; lastScanAt: string; lastStatus: string; lastMessage: string; accountCount: number; pendingCount: number; blockedCount: number };
type ConfirmAction = 'sync' | 'delete';
type RowFilter = 'all' | 'pending' | 'blocked' | 'synced';
type PayerState = 'pending' | 'abnormal' | 'unscanned' | 'normal';
type PayerFilter = 'all' | 'attention' | PayerState;

const statusText: Record<Status, string> = {
  normal: '金额一致', create: '待创建', update: '待更新', native_visible: '原生可见', query_error: '查询失败', zero_risk: '疑似清零', mapping_error: '映射异常', mapping_ignored: '已通过', duplicate_cli: '重复账单', period_range_error: '周期待修正', manual_deleted: '已人工删除',
};
const safeToSync = (status: Status) => ['create', 'update', 'period_range_error'].includes(status);
const risky = (status: Status) => ['query_error', 'zero_risk', 'mapping_error', 'duplicate_cli', 'period_range_error'].includes(status);
const hasSupportCharge = (item: BillingPeriod) => (item.aws ?? 0) !== 0 || (item.synced ?? 0) !== 0;
const money = (value: number | null | undefined) => value === null || value === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const historicalMonthFor = (period: SelectedPeriod) => period === 'current' || period === 'previous' ? undefined : period;
const unreadPeriod: BillingPeriod = { aws: null, synced: null, status: 'query_error', suggestion: '尚未读取', billingGroupMember: false };
const payerStateText: Record<PayerState, string> = { pending: '待处理', abnormal: '异常', unscanned: '未扫描', normal: '正常' };

function accountAutoSyncEnabled(account: BillingAccount, payer?: Payer) {
  const override = payer?.autoSyncOverrides?.[account.id];
  if (typeof override === 'boolean') return override;
  if (typeof account.autoSyncEnabled === 'boolean') return account.autoSyncEnabled;
  return payer?.architecture === 'pma';
}

function withAutoSync(snapshot: Snapshot, accountId: string, enabled: boolean): Snapshot {
  return { ...snapshot, accounts: snapshot.accounts.map((account) => account.id === accountId ? { ...account, autoSyncEnabled: enabled } : account) };
}

function payerState(item: Payer): PayerState {
  if (!item.lastScanAt) return 'unscanned';
  if (item.lastStatus === 'failed' || item.lastStatus === 'partial' || item.blockedCount > 0) return 'abnormal';
  if (item.pendingCount > 0) return 'pending';
  return 'normal';
}

function billingPeriodOptions(): { value: SelectedPeriod; month: string; label: string }[] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  return Array.from({ length: 7 }, (_, offset) => {
    const value = new Date(Date.UTC(year, month - 1 - offset, 1)).toISOString().slice(0, 7) as `${number}-${number}`;
    return { value: offset === 0 ? 'current' : offset === 1 ? 'previous' : value, month: value, label: offset === 0 ? '本月' : offset === 1 ? '上月' : value };
  });
}

export function SupportBillingPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerQuery, setPayerQuery] = useState('');
  const [payerFilter, setPayerFilter] = useState<PayerFilter>('attention');
  const [selectedPayerId, setSelectedPayerId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const cacheRef = useRef<SupportBillingCache<Snapshot> | null>(null);
  const selectedPayerRef = useRef('');
  const selectionVersion = useRef(0);
  const allowedPayers = useRef(new Set<string>());
  const openRef = useRef(false);
  const openingRef = useRef(false);
  const mutationRef = useRef(false);
  const [period, setPeriod] = useState<SelectedPeriod>('current');
  const periodRef = useRef<SelectedPeriod>('current');
  const [memberQuery, setMemberQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [rowFilter, setRowFilter] = useState<RowFilter>('all');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingPayerId, setLoadingPayerId] = useState('');
  const [mutating, setMutating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const busy = loadingList || (Boolean(loadingPayerId) && loadingPayerId === selectedPayerId) || mutating;
  const [preview, setPreview] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  async function request(body?: Record<string, unknown>) {
    const readOnly = !body || body.action === 'snapshot';
    const timeout = readOnly ? 20_000 : body?.action === 'scan' ? 120_000 : 300_000;
    const response = await fetch('/api/support-billing', { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    const payload = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'Support 对账服务暂时不可用');
    return payload;
  }

  async function showPanel() {
    if (openingRef.current || mutationRef.current) return;
    openingRef.current = true;
    openRef.current = true;
    setOpen(true);
    setLoadingList(true);
    setLoadError('');
    try {
      const payload = await request() as { payers?: Payer[]; preview?: boolean; cacheScope?: string };
      if (!openRef.current) return;
      const next = payload.payers ?? [];
      allowedPayers.current = new Set(next.map((item) => item.accountId));
      const scope = payload.cacheScope ?? 'current-session';
      if (!cacheRef.current || cacheRef.current.scope !== scope) {
        const cache = new SupportBillingCache<Snapshot>(scope, async (body) => await request(body) as { snapshot?: Snapshot; preview?: boolean }, (accountId, value, historyMonth) => {
          if (cacheRef.current !== cache) return;
          if (!historyMonth) setPayers((current) => current.map((item) => {
            if (item.accountId !== accountId) return item;
            const isNewerScan = Date.parse(value.snapshot.lastScanAt) > Date.parse(item.lastScanAt || '');
            return {
              ...item,
              lastScanAt: value.snapshot.lastScanAt,
              lastStatus: isNewerScan ? 'success' : item.lastStatus,
              lastMessage: isNewerScan ? '' : item.lastMessage,
              accountCount: value.snapshot.accounts.length,
              pendingCount: value.snapshot.accounts.filter((account) => safeToSync(account.current.status)).length,
              blockedCount: value.snapshot.accounts.filter((account) => risky(account.current.status) && !safeToSync(account.current.status)).length,
            };
          }));
          if (openRef.current && selectedPayerRef.current === accountId && historicalMonthFor(periodRef.current) === historyMonth) {
            setSnapshot(value.snapshot);
            setPreview(Boolean(value.preview));
          }
        });
        cacheRef.current = cache;
      }
      setPayers(next);
      setPreview(Boolean(payload.preview));
      setLoadingList(false);
      if (next.length) {
        const attention = next.filter((item) => payerState(item) !== 'normal');
        const current = next.find((item) => item.accountId === selectedPayerRef.current);
        if (!attention.length) setPayerFilter('all');
        const selected = attention.length ? (current && payerState(current) !== 'normal' ? current : attention[0]) : (current ?? next[0]);
        await selectPayer(selected.accountId);
      }
      else { selectedPayerRef.current = ''; setSelectedPayerId(''); setSnapshot(null); }
    } catch (error) {
      if (!openRef.current) return;
      allowedPayers.current.clear();
      cacheRef.current = null;
      setPayers([]); setSnapshot(null);
      const message = error instanceof Error ? error.message : '读取失败';
      setLoadError(message); onNotice(message);
    } finally { openingRef.current = false; if (openRef.current) setLoadingList(false); }
  }

  async function selectPayer(accountId: string, nextPeriod: SelectedPeriod = periodRef.current) {
    const cache = cacheRef.current;
    if (!cache || mutationRef.current || !allowedPayers.current.has(accountId)) return;
    if (!billingPeriodOptions().some((option) => option.value === nextPeriod)) nextPeriod = 'current';
    const version = ++selectionVersion.current;
    periodRef.current = nextPeriod;
    setPeriod(nextPeriod);
    setConfirm(null);
    const historyMonth = historicalMonthFor(nextPeriod);
    selectedPayerRef.current = accountId;
    setSelectedPayerId(accountId);
    setSelected([]);
    setRowFilter('all');
    setLoadError('');
    const cached = cache.get(accountId, historyMonth);
    setSnapshot(cached?.snapshot ?? null);
    setPreview(Boolean(cached?.preview));
    if (cached && snapshotIsFresh(cached.snapshot, Date.now(), historyMonth) && !cache.isLoading(accountId, historyMonth)) {
      setLoadingPayerId('');
      return;
    }
    setLoadingPayerId(accountId);
    try {
      const value = await cache.load(accountId, false, historyMonth);
      if (!openRef.current || version !== selectionVersion.current) return;
      setSnapshot(value.snapshot); setPreview(Boolean(value.preview));
    } catch (error) {
      if (!openRef.current || version !== selectionVersion.current) return;
      const message = error instanceof Error ? error.message : '读取账单失败';
      setPayers((current) => current.map((item) => item.accountId === accountId ? { ...item, lastStatus: 'failed', lastMessage: message } : item));
      setLoadError(message); onNotice(message);
    } finally { if (openRef.current && version === selectionVersion.current) setLoadingPayerId(''); }
  }

  async function scan() {
    const cache = cacheRef.current;
    const accountId = selectedPayerRef.current;
    if (!accountId || !cache || mutationRef.current || busy) return;
    const version = ++selectionVersion.current;
    setLoadingPayerId(accountId); setLoadError('');
    try {
      const value = await cache.load(accountId, true, historicalMonthFor(periodRef.current));
      if (!openRef.current || version !== selectionVersion.current) return;
      setSnapshot(value.snapshot);
      setSelected([]);
      onNotice(`扫描完成，共 ${value.snapshot.accounts.length} 个成员账号`);
    } catch (error) {
      if (!openRef.current || version !== selectionVersion.current) return;
      const message = error instanceof Error ? error.message : '扫描失败';
      setLoadError(message); onNotice(message);
    } finally { if (openRef.current && version === selectionVersion.current) setLoadingPayerId(''); }
  }

  async function perform() {
    if (!confirm || !selectedPayerId || selected.length === 0 || busy || mutationRef.current || historicalMonthFor(periodRef.current)) return;
    const action = confirm;
    mutationRef.current = true;
    setMutating(true); setLoadError('');
    try {
      const payload = await request({ action, accountId: selectedPayerId, period, targets: selected }) as { snapshot?: Snapshot; summary?: { created?: number; updated?: number; deleted?: number; repaired?: number; failed?: number } };
      if (payload.snapshot) {
        cacheRef.current?.put(selectedPayerId, { snapshot: payload.snapshot, preview });
        setSnapshot(payload.snapshot);
        const failed = payload.summary?.failed ?? 0;
        setPayers((current) => current.map((item) => item.accountId === selectedPayerId ? {
          ...item,
          lastStatus: failed > 0 ? 'partial' : 'success',
          lastMessage: failed > 0 ? `${failed} 个账号处理失败` : '',
        } : item));
      }
      setSelected([]);
      setConfirm(null);
      const completed = action === 'delete' ? payload.summary?.deleted ?? 0 : (payload.summary?.created ?? 0) + (payload.summary?.updated ?? 0) + (payload.summary?.repaired ?? 0);
      onNotice(`${action === 'delete' ? '删除' : '同步'}完成：成功 ${completed}，失败 ${payload.summary?.failed ?? 0}`);
    } catch (error) { const message = error instanceof Error ? error.message : '操作失败'; setLoadError(message); onNotice(message); }
    finally { mutationRef.current = false; setMutating(false); }
  }

  async function setAccountAutoSync(account: BillingAccount, enabled: boolean) {
    const payerId = selectedPayerRef.current;
    if (!payerId || busy || mutationRef.current) return;
    mutationRef.current = true;
    setMutating(true); setLoadError('');
    try {
      const payload = await request({ action: 'set_auto_sync', accountId: payerId, targetAccountId: account.id, enabled }) as { payer?: Payer; snapshot?: Snapshot };
      setPayers((current) => current.map((item) => item.accountId === payerId ? (payload.payer ?? { ...item, autoSyncOverrides: { ...(item.autoSyncOverrides ?? {}), [account.id]: enabled } }) : item));
      const historyMonth = historicalMonthFor(periodRef.current);
      const nextSnapshot = historyMonth ? (snapshot ? withAutoSync(snapshot, account.id, enabled) : null) : payload.snapshot ?? (snapshot ? withAutoSync(snapshot, account.id, enabled) : null);
      if (nextSnapshot) {
        cacheRef.current?.put(payerId, { snapshot: nextSnapshot, preview }, historyMonth);
        setSnapshot(nextSnapshot);
      }
      onNotice(`${account.name} 自动同步已${enabled ? '开启' : '关闭'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '自动同步设置失败';
      setLoadError(message); onNotice(message);
    } finally { mutationRef.current = false; setMutating(false); }
  }

  function closePanel() {
    if (mutationRef.current) return;
    openRef.current = false;
    selectionVersion.current += 1;
    setOpen(false); setConfirm(null); setLoadingList(false); setLoadingPayerId('');
  }

  const payer = payers.find((item) => item.accountId === selectedPayerId);
  const periodOptions = billingPeriodOptions();
  const historicalMonth = historicalMonthFor(period);
  const readOnlyPeriod = Boolean(historicalMonth);
  const recentPeriod: PeriodKey = period === 'previous' ? 'previous' : 'current';
  const billingMonth = historicalMonth ?? snapshot?.months[recentPeriod] ?? periodOptions.find((option) => option.value === period)?.month;
  const billingMonthLabel = billingMonth ? `${billingMonth.slice(0, 4)}年${Number(billingMonth.slice(5, 7))}月` : '尚未读取';
  const needle = memberQuery.trim().toLocaleLowerCase('zh-CN');
  const periodItem = (account: BillingAccount) => historicalMonth ? account.historical ?? unreadPeriod : account[recentPeriod];
  const isPending = (item: BillingPeriod) => safeToSync(item.status);
  const isBlocked = (item: BillingPeriod) => risky(item.status) && !safeToSync(item.status);
  const isSynced = (item: BillingPeriod) => item.status === 'normal' && Boolean(item.customLineItemArn);
  const rows = (snapshot?.accounts ?? [])
    .filter((account) => !needle || `${account.name} ${account.id} ${account.cma}`.toLocaleLowerCase('zh-CN').includes(needle))
    .filter((account) => { const item = periodItem(account); return rowFilter === 'all' || (rowFilter === 'pending' && isPending(item)) || (rowFilter === 'blocked' && isBlocked(item)) || (rowFilter === 'synced' && isSynced(item)); })
    .sort((left, right) => {
      const leftItem = periodItem(left);
      const rightItem = periodItem(right);
      const chargePriority = period === 'current' ? 0 : Number(hasSupportCharge(rightItem)) - Number(hasSupportCharge(leftItem));
      return chargePriority || rowPriority(leftItem) - rowPriority(rightItem) || left.name.localeCompare(right.name, 'zh-CN');
    });
  const selectedRows = rows.filter((account) => selected.includes(account.id));
  const selectableRows = rows.filter((account) => !readOnlyPeriod && safeToSync(periodItem(account).status));
  const allSelectableSelected = selectableRows.length > 0 && selectableRows.every((account) => selected.includes(account.id));
  const syncable = !readOnlyPeriod && selectedRows.length > 0 && selectedRows.every((account) => safeToSync(periodItem(account).status));
  const deletable = !readOnlyPeriod && selectedRows.length > 0 && selectedRows.every((account) => canDelete(account, recentPeriod, billingMonth));
  const summary = useMemo(() => {
    const values = (snapshot?.accounts ?? []).map(periodItem);
    return { pending: values.filter(isPending).length, blocked: values.filter(isBlocked).length, synced: values.filter(isSynced).length };
  }, [snapshot, period]);
  const payerSummary = useMemo(() => {
    const counts = { pending: 0, abnormal: 0, unscanned: 0, normal: 0 };
    for (const item of payers) counts[payerState(item)] += 1;
    return { ...counts, attention: counts.pending + counts.abnormal + counts.unscanned };
  }, [payers]);
  const payerNeedle = payerQuery.trim().toLocaleLowerCase('zh-CN');
  const visiblePayers = payers
    .filter((item) => !payerNeedle || `${item.remark} ${item.accountId} ${item.groupName} ${item.lastMessage}`.toLocaleLowerCase('zh-CN').includes(payerNeedle))
    .filter((item) => payerFilter === 'all' || (payerFilter === 'attention' ? payerState(item) !== 'normal' : payerState(item) === payerFilter))
    .sort((left, right) => payerStatePriority(payerState(left)) - payerStatePriority(payerState(right)) || left.remark.localeCompare(right.remark, 'zh-CN'));

  return <>
    <button className={styles.trigger} onClick={() => { setPayerFilter('attention'); void showPanel(); }}>Support 对账</button>
    {open && <div className={styles.layer} onMouseDown={(event) => event.target === event.currentTarget && closePanel()}>
      <section className={styles.dialog} role="dialog" aria-modal="true">
        <button className={styles.close} disabled={mutating} onClick={closePanel}>×</button>
        <header className={styles.heading}><span>BILLING CONTROL</span><h2>Business Support+ 对账</h2><p>{preview ? '本地预览，不执行 AWS 操作' : '自动核对费用，只处理通过安全校验的账单项'}</p></header>
        <div className={styles.toolbar}><div><b>{payer?.remark ?? '选择代付账号'}</b><small>{snapshot?.lastScanAt ? `最后扫描 ${formatTime(snapshot.lastScanAt)}${loadingPayerId === selectedPayerId ? ' · 正在更新' : ''}` : busy ? '正在读取账单...' : '尚未扫描'}</small></div><nav aria-label="选择账期">{periodOptions.map((option) => <button key={option.value} disabled={mutating || loadingList || !selectedPayerId} title={option.month} aria-pressed={period === option.value} className={period === option.value ? styles.active : ''} onClick={() => void selectPayer(selectedPayerId, option.value)}>{option.label}</button>)}</nav><button disabled={busy || preview || !selectedPayerId} onClick={() => void scan()}>{busy ? '处理中...' : '重新扫描'}</button></div>
        <div className={styles.overview}><div><strong>代付账号概览</strong><small>根据本月最近一次扫描结果汇总</small></div><nav aria-label="筛选代付账号"><button data-state="attention" className={payerFilter === 'attention' ? styles.overviewActive : ''} onClick={() => setPayerFilter('attention')}><b>{payerSummary.attention}</b>需处理</button><button className={payerFilter === 'all' ? styles.overviewActive : ''} onClick={() => setPayerFilter('all')}><b>{payers.length}</b>全部</button><button data-state="abnormal" className={payerFilter === 'abnormal' ? styles.overviewActive : ''} onClick={() => setPayerFilter('abnormal')}><b>{payerSummary.abnormal}</b>异常</button><button data-state="unscanned" className={payerFilter === 'unscanned' ? styles.overviewActive : ''} onClick={() => setPayerFilter('unscanned')}><b>{payerSummary.unscanned}</b>未扫描</button><button data-state="normal" className={payerFilter === 'normal' ? styles.overviewActive : ''} onClick={() => setPayerFilter('normal')}><b>{payerSummary.normal}</b>正常</button></nav></div>
        <div className={styles.layout}>
          <aside className={styles.payers}><input value={payerQuery} onChange={(event) => setPayerQuery(event.target.value)} placeholder="搜索代付账号" />{visiblePayers.length === 0 ? <p>没有符合条件的代付账号</p> : visiblePayers.map((item) => { const state = payerState(item); const detail = state === 'pending' ? `${item.pendingCount} 个` : state === 'abnormal' && item.blockedCount > 0 ? `${item.blockedCount} 个` : ''; return <button key={item.accountId} disabled={mutating || loadingList} title={item.lastMessage || payerStateText[state]} className={item.accountId === selectedPayerId ? styles.selectedPayer : ''} onClick={() => void selectPayer(item.accountId)}><i>{item.remark.slice(0, 1).toUpperCase()}</i><span><strong>{item.remark}</strong><small>{item.accountId} · {item.groupName} · 成员 {item.accountCount}</small></span><em data-state={state}>{payerStateText[state]}{detail && ` ${detail}`}</em></button>; })}</aside>
          <main className={styles.content}>
            {loadError && <p role="alert" style={{ color: '#ff8994', fontSize: 12, overflowWrap: 'anywhere' }}>{snapshot ? '更新失败，已保留上次数据。' : '读取失败。'}{loadError}</p>}
            <div className={styles.stats}><button className={rowFilter === 'pending' ? styles.statActive : ''} onClick={() => { setRowFilter((current) => current === 'pending' ? 'all' : 'pending'); setSelected([]); }}><b>{summary.pending}</b>待处理</button><button className={rowFilter === 'all' ? styles.statActive : ''} onClick={() => { setRowFilter('all'); setSelected([]); }}><b>{snapshot?.accounts.length ?? 0}</b>账号</button><button className={rowFilter === 'blocked' ? styles.statActive : ''} onClick={() => { setRowFilter((current) => current === 'blocked' ? 'all' : 'blocked'); setSelected([]); }}><b>{summary.blocked}</b>已拦截</button><button className={rowFilter === 'synced' ? styles.statActive : ''} onClick={() => { setRowFilter((current) => current === 'synced' ? 'all' : 'synced'); setSelected([]); }}><b>{summary.synced}</b>已同步</button><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索名称或账号 ID" /></div>
            <div className={styles.actions}><span aria-live="polite">{selected.length > 0 ? `已选择 ${selected.length} 个账号` : ''}</span><div><button disabled={busy || selectableRows.length === 0} onClick={() => setSelected(allSelectableSelected ? [] : selectableRows.map((account) => account.id))}>{allSelectableSelected ? '取消全选' : '一键选择'}</button><button disabled={busy || !deletable} onClick={() => setConfirm('delete')}>删除账单项</button><button className={styles.primary} disabled={busy || !syncable} onClick={() => setConfirm('sync')}>同步选中</button></div></div>
            {readOnlyPeriod && <p className={styles.readOnlyHint}>历史月份仅查看对账结果；AWS 只支持修改本月和上月账单。</p>}
            <div className={styles.tableWrap}><table><thead><tr><th>选择</th><th>成员账号</th><th>账期</th><th>账单组 / 同步资格</th><th>自动同步</th><th>最近同步</th><th>AWS Support</th><th>当前同步</th><th>差额</th><th>状态</th></tr></thead><tbody>{busy && !snapshot ? <tr><td colSpan={10}>正在读取...</td></tr> : rows.length === 0 ? <tr><td colSpan={10}>暂无扫描结果</td></tr> : rows.map((account) => { const item = periodItem(account); const selectable = !readOnlyPeriod && (safeToSync(item.status) || canDelete(account, recentPeriod, billingMonth)); const difference = item.aws === null ? null : item.aws - (item.synced ?? 0); const autoSync = accountAutoSyncEnabled(account, payer); const lastSync = account.history?.find((entry) => entry.action !== '删除'); return <tr key={account.id} data-risk={risky(item.status)}><td><input type="checkbox" disabled={busy || !selectable} checked={selected.includes(account.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, account.id] : current.filter((value) => value !== account.id))} /></td><td><strong>{account.name}</strong><small>{account.id}</small></td><td className={styles.billingMonth}>{billingMonthLabel}</td><td>{billingGroupLabel(payer?.architecture, account.cma, item, readOnlyPeriod)}</td><td><button type="button" aria-pressed={autoSync} title={autoSync ? '每两天扫描时允许自动同步；人工同步始终可用' : '自动写入已关闭；扫描展示和人工同步不受影响'} className={`${styles.autoSyncToggle} ${autoSync ? styles.autoSyncOn : styles.autoSyncOff}`} disabled={busy} onClick={() => void setAccountAutoSync(account, !autoSync)}>{autoSync ? '已开启' : '已关闭'}</button></td><td className={styles.lastSync}>{lastSync ? <><time dateTime={lastSync.date}>{formatTime(lastSync.date)}</time><small>{lastSync.action}</small></> : '暂无记录'}</td><td>{money(item.aws)}</td><td>{money(item.synced)}</td><td>{difference === null ? '—' : `${difference > 0 ? '+' : ''}${money(difference)}`}</td><td><span data-status={item.status}>{statusText[item.status] ?? item.suggestion}</span></td></tr>; })}</tbody></table></div>
          </main>
        </div>
        {confirm && <div className={styles.confirmLayer}><section className={styles.confirm}><span>CONFIRM ACTION</span><h3>{confirm === 'delete' ? '删除账单项' : '同步 Support 费用'}</h3><p>{busy ? '正在读取 AWS 数据并修正账单周期，请不要关闭页面。' : `将处理 ${selected.length} 个成员账号。系统会重新读取 AWS 数据，通过安全校验后才会写入。`}</p><div><button disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className={styles.primary} disabled={busy} onClick={() => void perform()}>{busy ? '处理中...' : '确认执行'}</button></div></section></div>}
      </section>
    </div>}
  </>;
}

function canDelete(account: BillingAccount, period: PeriodKey, month?: string) {
  const item = account[period];
  return Boolean(month && item.customLineItemArn && item.customLineItemName === `AWSBusinessSupportPlus_${account.id}_${month.replace('-', '')}`);
}

function billingGroupLabel(architecture: Payer['architecture'] | undefined, cma: string, item: BillingPeriod, readOnly: boolean) {
  if (architecture === 'pma') return cma;
  if ((item.aws ?? 0) > 0) {
    if (!item.billingGroupMember) return '未在账单组 · 不同步';
    return readOnly ? '已在账单组 · 历史只读' : '已在账单组';
  }
  return item.billingGroupMember ? '已加入' : '原生可见';
}

function rowPriority(item: BillingPeriod) {
  if (item.status === 'normal' && item.customLineItemArn) return 0;
  if (item.status === 'normal') return 1;
  if (item.status === 'native_visible') return 2;
  if (safeToSync(item.status)) return 3;
  if (risky(item.status)) return 4;
  return 5;
}

function payerStatePriority(state: PayerState) {
  return { abnormal: 0, pending: 1, unscanned: 2, normal: 3 }[state];
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
