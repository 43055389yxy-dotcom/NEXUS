'use client';

import { useMemo, useRef, useState } from 'react';
import { SupportBillingCache, snapshotIsFresh } from './support-billing-cache';
import styles from './support-billing.module.css';

type PeriodKey = 'current' | 'previous';
type SelectedPeriod = PeriodKey | `${number}-${number}`;
type Status = 'normal' | 'create' | 'update' | 'native_visible' | 'query_error' | 'data_pending' | 'zero_risk' | 'mapping_error' | 'mapping_ignored' | 'duplicate_cli' | 'period_range_error' | 'manual_deleted';
type BillingPeriod = { aws: number | null; synced: number | null; status: Status; suggestion: string; billingGroupMember: boolean; customLineItemArn?: string; customLineItemName?: string };
type BillingAccount = { id: string; name: string; cma: string; autoSyncEnabled?: boolean; current: BillingPeriod; previous: BillingPeriod; historical?: BillingPeriod; history?: { date: string; action: string; amount: string }[] };
type Snapshot = { lastScanAt: string; months: Record<PeriodKey, string>; historyMonth?: string; accounts: BillingAccount[]; diagnostics?: { viewWarnings?: Array<{ sourceAccountId?: string; viewName?: string }> } };
type Payer = { accountId: string; remark: string; groupName: string; architecture: 'pma' | 'legacy_payer'; autoSyncOverrides?: Record<string, boolean>; lastScanAt: string; lastStatus: string; lastMessage: string; accountCount: number; pendingCount: number; blockedCount: number };
type ConfirmAction = 'sync' | 'delete';
type RowFilter = 'all' | 'pending' | 'blocked' | 'synced' | 'enabled';
type PayerState = 'pending' | 'abnormal' | 'unscanned' | 'normal';
type BillingRow = BillingAccount & { payerId: string; payerRemark: string; payerInfo?: Payer };

const ALL_PAYERS_ID = '__all_payers__';

const statusText: Record<Status, string> = {
  normal: '金额一致', create: '待创建', update: '待更新', native_visible: '原生可见', query_error: '处理失败', data_pending: '数据待更新', zero_risk: '疑似清零', mapping_error: '映射异常', mapping_ignored: '已通过', duplicate_cli: '重复账单', period_range_error: '周期待修正', manual_deleted: '已人工删除',
};
const safeToSync = (status: Status) => ['create', 'update', 'query_error', 'period_range_error'].includes(status);
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
  const [selectedPayerId, setSelectedPayerId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [allSnapshots, setAllSnapshots] = useState<Record<string, Snapshot>>({});
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
            const warningCount = new Set((value.snapshot.diagnostics?.viewWarnings || []).map((warning) => warning.sourceAccountId || warning.viewName)).size;
            return {
              ...item,
              lastScanAt: value.snapshot.lastScanAt,
              lastStatus: warningCount ? 'partial' : isNewerScan ? 'success' : item.lastStatus,
              lastMessage: warningCount ? `${warningCount} 个账单视图数据待更新` : isNewerScan ? '' : item.lastMessage,
              accountCount: value.snapshot.accounts.length,
              pendingCount: value.snapshot.accounts.filter((account) => safeToSync(account.current.status)).length,
              blockedCount: value.snapshot.accounts.filter((account) => risky(account.current.status) && !safeToSync(account.current.status)).length,
            };
          }));
          if (openRef.current && selectedPayerRef.current === accountId && historicalMonthFor(periodRef.current) === historyMonth) {
            setSnapshot(value.snapshot);
            setPreview(Boolean(value.preview));
          }
          if (openRef.current && selectedPayerRef.current === ALL_PAYERS_ID && historicalMonthFor(periodRef.current) === historyMonth) {
            setAllSnapshots((current) => ({ ...current, [accountId]: value.snapshot }));
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

  async function selectAllPayers(nextPeriod: SelectedPeriod = periodRef.current) {
    const cache = cacheRef.current;
    if (!cache || mutationRef.current || payers.length === 0) return;
    if (!billingPeriodOptions().some((option) => option.value === nextPeriod)) nextPeriod = 'current';
    const version = ++selectionVersion.current;
    const historyMonth = historicalMonthFor(nextPeriod);
    periodRef.current = nextPeriod;
    selectedPayerRef.current = ALL_PAYERS_ID;
    setSelectedPayerId(ALL_PAYERS_ID);
    setPeriod(nextPeriod);
    setSnapshot(null);
    setSelected([]);
    setRowFilter('all');
    setConfirm(null);
    setLoadError('');
    setLoadingPayerId(ALL_PAYERS_ID);
    try {
      const loaded = await Promise.allSettled(payers.map(async (item) => ({ accountId: item.accountId, value: await cache.load(item.accountId, false, historyMonth) })));
      if (!openRef.current || version !== selectionVersion.current) return;
      const next: Record<string, Snapshot> = {};
      let previewMode = false;
      let failures = 0;
      for (const item of loaded) {
        if (item.status === 'rejected') { failures += 1; continue; }
        next[item.value.accountId] = item.value.value.snapshot;
        previewMode ||= Boolean(item.value.value.preview);
      }
      setAllSnapshots(next);
      setPreview(previewMode);
      if (failures) setLoadError(`${failures} 个代付账号读取失败，已显示其余账号的缓存结果。`);
    } catch (error) {
      if (!openRef.current || version !== selectionVersion.current) return;
      const message = error instanceof Error ? error.message : '读取全部代付失败';
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
      if (accountId === ALL_PAYERS_ID) {
        const historyMonth = historicalMonthFor(periodRef.current);
        const next = { ...allSnapshots };
        let accounts = 0;
        let failures = 0;
        let skipped = 0;
        for (const item of payers) {
          if (!openRef.current || version !== selectionVersion.current) return;
          try {
            const value = await cache.load(item.accountId, true, historyMonth) as { snapshot: Snapshot; preview?: boolean; skipped?: boolean };
            next[item.accountId] = value.snapshot;
            accounts += value.snapshot.accounts.length;
            if (value.skipped) skipped += 1;
            setAllSnapshots({ ...next });
          } catch { failures += 1; }
        }
        if (!openRef.current || version !== selectionVersion.current) return;
        setAllSnapshots(next);
        if (failures) setLoadError(`${failures} 个代付账号扫描失败，其他结果已更新。`);
        onNotice(`全部扫描完成：成员账号 ${accounts}，今日已跳过 ${skipped} 个代付，失败 ${failures} 个`);
        return;
      }
      const value = await cache.load(accountId, true, historicalMonthFor(periodRef.current)) as { snapshot: Snapshot; preview?: boolean; skipped?: boolean };
      if (!openRef.current || version !== selectionVersion.current) return;
      setSnapshot(value.snapshot);
      setSelected([]);
      onNotice(value.skipped ? '今日已同步，已跳过重复扫描' : `扫描完成，共 ${value.snapshot.accounts.length} 个成员账号`);
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
      const groupedTargets = new Map<string, string[]>();
      if (isAllPayers) {
        for (const account of selectedRows) groupedTargets.set(account.payerId, [...(groupedTargets.get(account.payerId) ?? []), account.id]);
      } else groupedTargets.set(selectedPayerId, selected);
      type ActionPayload = { snapshot?: Snapshot; summary?: { created?: number; updated?: number; deleted?: number; repaired?: number; failed?: number } };
      const results = await Promise.allSettled([...groupedTargets.entries()].map(async ([payerId, targets]) => ({ payerId, payload: await request({ action, accountId: payerId, period, targets }) as ActionPayload })));
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ payerId: string; payload: ActionPayload }> => result.status === 'fulfilled');
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (fulfilled.length === 0 && rejected[0]) throw rejected[0].reason;
      const snapshotUpdates: Record<string, Snapshot> = {};
      const statusUpdates = new Map<string, { snapshot: Snapshot; failed: number }>();
      let completed = 0;
      let failed = rejected.length;
      for (const { value } of fulfilled) {
        const summary = value.payload.summary;
        failed += summary?.failed ?? 0;
        completed += action === 'delete' ? summary?.deleted ?? 0 : (summary?.created ?? 0) + (summary?.updated ?? 0) + (summary?.repaired ?? 0);
        if (!value.payload.snapshot) continue;
        snapshotUpdates[value.payerId] = value.payload.snapshot;
        statusUpdates.set(value.payerId, { snapshot: value.payload.snapshot, failed: summary?.failed ?? 0 });
        cacheRef.current?.put(value.payerId, { snapshot: value.payload.snapshot, preview });
        if (!isAllPayers) setSnapshot(value.payload.snapshot);
      }
      if (Object.keys(snapshotUpdates).length > 0) setAllSnapshots((current) => ({ ...current, ...snapshotUpdates }));
      setPayers((current) => current.map((item) => {
        const update = statusUpdates.get(item.accountId);
        if (!update) return item;
        return { ...item, lastScanAt: update.snapshot.lastScanAt, lastStatus: update.failed > 0 ? 'partial' : 'success', lastMessage: update.failed > 0 ? `${update.failed} 个账号处理失败` : '' };
      }));
      setSelected([]);
      setConfirm(null);
      if (rejected.length > 0) setLoadError(`${rejected.length} 个代付账号处理失败，其余结果已保存。`);
      onNotice(`${action === 'delete' ? '删除' : '同步'}完成：成功 ${completed}，失败 ${failed}`);
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
  const isAllPayers = selectedPayerId === ALL_PAYERS_ID;
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
  const sourceRows: BillingRow[] = isAllPayers
    ? Object.entries(allSnapshots).flatMap(([payerId, value]) => {
        const payerInfo = payers.find((item) => item.accountId === payerId);
        return value.accounts.map((account) => ({ ...account, payerId, payerRemark: payerInfo?.remark ?? payerId, payerInfo }));
      })
    : (snapshot?.accounts ?? []).map((account) => ({ ...account, payerId: selectedPayerId, payerRemark: payer?.remark ?? selectedPayerId, payerInfo: payer }));
  const rows = sourceRows
    .filter((account) => !needle || `${account.name} ${account.id} ${account.cma}`.toLocaleLowerCase('zh-CN').includes(needle))
    .filter((account) => { const item = periodItem(account); return rowFilter === 'all' || (rowFilter === 'pending' && isPending(item)) || (rowFilter === 'blocked' && isBlocked(item)) || (rowFilter === 'synced' && isSynced(item)) || (rowFilter === 'enabled' && accountAutoSyncEnabled(account, account.payerInfo)); })
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
    const values = sourceRows.map(periodItem);
    return { pending: values.filter(isPending).length, blocked: values.filter(isBlocked).length, synced: values.filter(isSynced).length, enabled: sourceRows.filter((account) => accountAutoSyncEnabled(account, account.payerInfo)).length };
  }, [sourceRows, period]);
  const payerNeedle = payerQuery.trim().toLocaleLowerCase('zh-CN');
  const visiblePayers = payers
    .filter((item) => !payerNeedle || `${item.remark} ${item.accountId} ${item.groupName} ${item.lastMessage}`.toLocaleLowerCase('zh-CN').includes(payerNeedle))
    .sort((left, right) => payerStatePriority(payerState(left)) - payerStatePriority(payerState(right)) || left.remark.localeCompare(right.remark, 'zh-CN'));
  const allPayerState: PayerState = payers.some((item) => payerState(item) === 'abnormal') ? 'abnormal' : payers.some((item) => payerState(item) === 'pending') ? 'pending' : payers.some((item) => payerState(item) === 'unscanned') ? 'unscanned' : 'normal';
  const allAttentionCount = payers.reduce((total, item) => total + item.pendingCount + item.blockedCount, 0);
  const allLastScanAt = Object.values(allSnapshots).map((item) => item.lastScanAt).filter(Boolean).sort().at(-1);

  return <>
    <button className={styles.trigger} onClick={() => void showPanel()}>Support 对账</button>
    {open && <div className={styles.layer} onMouseDown={(event) => event.target === event.currentTarget && closePanel()}>
      <section className={styles.dialog} role="dialog" aria-modal="true">
        <button className={styles.close} disabled={mutating} onClick={closePanel}>×</button>
        <header className={styles.heading}><span>BILLING CONTROL</span><h2>Business Support+ 对账</h2><p>{preview ? '本地预览，不执行 AWS 操作' : '自动核对费用，只处理通过安全校验的账单项'}</p></header>
        <div className={styles.toolbar}><div><b>{isAllPayers ? '全部代付' : payer?.remark ?? '选择代付账号'}</b><small>{isAllPayers ? (allLastScanAt ? `汇总 ${payers.length} 个代付 · 最近扫描 ${formatTime(allLastScanAt)}${busy ? ' · 正在更新' : ''}` : busy ? '正在读取全部代付...' : '尚未读取') : snapshot?.lastScanAt ? `最后扫描 ${formatTime(snapshot.lastScanAt)}${loadingPayerId === selectedPayerId ? ' · 正在更新' : ''}` : busy ? '正在读取账单...' : '尚未扫描'}</small></div><nav aria-label="选择账期">{periodOptions.map((option) => <button key={option.value} disabled={mutating || loadingList || !selectedPayerId} title={option.month} aria-pressed={period === option.value} className={period === option.value ? styles.active : ''} onClick={() => void (isAllPayers ? selectAllPayers(option.value) : selectPayer(selectedPayerId, option.value))}>{option.label}</button>)}</nav><button disabled={busy || preview || !selectedPayerId} onClick={() => void scan()}>{busy ? '处理中...' : isAllPayers ? '刷新全部代付' : '重新扫描'}</button></div>
        <div className={styles.layout}>
          <aside className={styles.payers}><input value={payerQuery} onChange={(event) => setPayerQuery(event.target.value)} placeholder="搜索代付账号" /><button disabled={mutating || loadingList || payers.length === 0} title="汇总查看并刷新所有代付账号" className={isAllPayers ? styles.selectedPayer : ''} onClick={() => void selectAllPayers()}><i>全</i><span><strong>全部代付</strong><small>{payers.length} 个代付 · 成员 {payers.reduce((total, item) => total + item.accountCount, 0)}</small></span><em data-state={allPayerState}>{payerStateText[allPayerState]}{allAttentionCount > 0 && ` ${allAttentionCount} 个`}</em></button>{visiblePayers.length === 0 ? <p>没有符合条件的代付账号</p> : visiblePayers.map((item) => { const state = payerState(item); const detail = state === 'pending' ? `${item.pendingCount} 个` : state === 'abnormal' && item.blockedCount > 0 ? `${item.blockedCount} 个` : ''; return <button key={item.accountId} disabled={mutating || loadingList} title={item.lastMessage || payerStateText[state]} className={item.accountId === selectedPayerId ? styles.selectedPayer : ''} onClick={() => void selectPayer(item.accountId)}><i>{item.remark.slice(0, 1).toUpperCase()}</i><span><strong>{item.remark}</strong><small>{item.accountId} · {item.groupName} · 成员 {item.accountCount}</small><small>同步时间：{item.lastScanAt ? formatTime(item.lastScanAt) : '尚未同步'}</small></span><em data-state={state}>{payerStateText[state]}{detail && ` ${detail}`}</em></button>; })}</aside>
          <main className={styles.content}>
            {loadError && <p role="alert" style={{ color: '#ff8994', fontSize: 12, overflowWrap: 'anywhere' }}>{snapshot ? '更新失败，已保留上次数据。' : '读取失败。'}{loadError}</p>}
            <div className={styles.stats}><button className={rowFilter === 'pending' ? styles.statActive : ''} onClick={() => { setRowFilter((current) => current === 'pending' ? 'all' : 'pending'); setSelected([]); }}><b>{summary.pending}</b>待处理</button><button className={rowFilter === 'all' ? styles.statActive : ''} onClick={() => { setRowFilter('all'); setSelected([]); }}><b>{sourceRows.length}</b>全部账号</button><button className={rowFilter === 'synced' ? styles.statActive : ''} onClick={() => { setRowFilter((current) => current === 'synced' ? 'all' : 'synced'); setSelected([]); }}><b>{summary.synced}</b>已同步</button><button className={rowFilter === 'blocked' ? styles.statActive : ''} onClick={() => { setRowFilter((current) => current === 'blocked' ? 'all' : 'blocked'); setSelected([]); }}><b>{summary.blocked}</b>已拦截</button><button className={rowFilter === 'enabled' ? styles.statActive : ''} onClick={() => { setRowFilter((current) => current === 'enabled' ? 'all' : 'enabled'); setSelected([]); }}><b>{summary.enabled}</b>自动同步开启</button><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="搜索名称或账号 ID" /></div>
            <div className={styles.actions}><span aria-live="polite">{selected.length > 0 ? `已选择 ${selected.length} 个账号` : ''}</span><div><button disabled={busy || selectableRows.length === 0} onClick={() => setSelected(allSelectableSelected ? [] : selectableRows.map((account) => account.id))}>{allSelectableSelected ? '取消全选' : '一键选择'}</button><button disabled={busy || !deletable} onClick={() => setConfirm('delete')}>删除账单项</button><button className={styles.primary} disabled={busy || !syncable} onClick={() => setConfirm('sync')}>同步选中</button></div></div>
            {readOnlyPeriod && <p className={styles.readOnlyHint}>历史月份仅查看对账结果；AWS 只支持修改本月和上月账单。</p>}
            <div className={styles.tableWrap}><table><thead><tr><th>选择</th><th>成员账号</th><th>账期</th><th>账单组 / 同步资格</th><th>自动同步</th><th>最近同步</th><th>AWS Support</th><th>当前同步</th><th>差额</th><th>状态</th></tr></thead><tbody>{busy && sourceRows.length === 0 ? <tr><td colSpan={10}>正在读取...</td></tr> : rows.length === 0 ? <tr><td colSpan={10}>暂无扫描结果</td></tr> : rows.map((account) => { const item = periodItem(account); const selectable = !readOnlyPeriod && (safeToSync(item.status) || canDelete(account, recentPeriod, billingMonth)); const difference = item.aws === null ? null : item.aws - (item.synced ?? 0); const autoSync = accountAutoSyncEnabled(account, account.payerInfo); const lastSync = account.history?.find((entry) => entry.action !== '删除'); return <tr key={`${account.payerId}:${account.id}`} data-risk={risky(item.status)}><td><input type="checkbox" disabled={busy || !selectable} checked={selected.includes(account.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, account.id] : current.filter((value) => value !== account.id))} /></td><td><strong>{account.name}</strong><small>{account.id}{isAllPayers ? ` · ${account.payerRemark}` : ''}</small></td><td className={styles.billingMonth}>{billingMonthLabel}</td><td>{billingGroupLabel(account.payerInfo?.architecture, account.cma, item, readOnlyPeriod)}</td><td><button type="button" aria-pressed={autoSync} title={autoSync ? '每两天扫描时允许自动同步；人工同步始终可用' : '自动写入已关闭；扫描展示和人工同步不受影响'} className={`${styles.autoSyncToggle} ${autoSync ? styles.autoSyncOn : styles.autoSyncOff}`} disabled={busy || isAllPayers} onClick={() => void setAccountAutoSync(account, !autoSync)}>{autoSync ? '已开启' : '已关闭'}</button></td><td className={styles.lastSync}>{lastSync ? <><time dateTime={lastSync.date}>{formatTime(lastSync.date)}</time><small>{lastSync.action}</small></> : '暂无记录'}</td><td>{money(item.aws)}</td><td>{money(item.synced)}</td><td>{difference === null ? '—' : `${difference > 0 ? '+' : ''}${money(difference)}`}</td><td><span data-status={item.status} title={item.suggestion}>{statusText[item.status] ?? item.suggestion}</span></td></tr>; })}</tbody></table></div>
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
