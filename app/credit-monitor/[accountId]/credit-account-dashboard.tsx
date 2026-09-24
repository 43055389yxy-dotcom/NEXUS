'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from '../credit-monitor.module.css';

type Money = { currencyCode: string; currencyAmount: number };
type CreditState = 'active' | 'exhausted' | 'expired' | 'disabled';
type Credit = {
  accountId: string;
  accountName: string;
  creditId: string;
  ownerAccountId: string;
  creditType: string;
  description: string;
  initialAmount: Money;
  remainingAmount: Money;
  estimatedAmount: Money;
  usedAmount: Money;
  estimatedUsedAmount: Money;
  applicableProductNames: string[];
  startDate: string;
  endDate: string;
  exhaustDate: string;
  creditStatus: string;
  state: CreditState;
  sharingType: string;
  sharingEnabled: boolean;
  observedAt: string;
};
type AccountState = {
  accountId: string;
  name: string;
  architecture: 'cma' | 'legacy_payer';
  groupName: string;
  lastRunAt: string;
  status: 'ok' | 'error' | 'not_scanned';
  error: string;
  creditCount: number;
  activeCreditCount: number;
};
type Change = { type: string; field: string; before: unknown; after: unknown; threshold?: number };
type History = { accountId: string; accountName: string; architecture: string; creditId: string; description: string; changes: Change[]; observedAt: string };
type Payload = { accounts: AccountState[]; credits: Credit[]; history: History[] };
const EMPTY: Payload = { accounts: [], credits: [], history: [] };
const PAGE_SIZE = 15;
const STATE_NAMES: Record<CreditState, string> = { active: '有效', exhausted: '已耗尽', expired: '已过期', disabled: '已停用' };
const CHANGE_NAMES: Record<string, string> = { new: '新增代金券', balance: '余额变化', exhausted: '代金券耗尽', status: '状态变化', expiry_changed: '到期日变化', expiring: '即将到期' };

function dateTime(value: string) {
  if (!value) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dateOnly(value: string) {
  if (!value) return '无到期日';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function money(value?: Money) {
  if (!value) return '-';
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: value.currencyCode || 'USD', minimumFractionDigits: 2 }).format(Number(value.currencyAmount || 0));
}

function totalMoney(credits: Credit[], field: 'initialAmount' | 'estimatedAmount') {
  const totals = new Map<string, number>();
  for (const credit of credits) {
    const value = credit[field];
    const currency = value?.currencyCode || 'USD';
    totals.set(currency, (totals.get(currency) || 0) + Number(value?.currencyAmount || 0));
  }
  if (totals.size === 0) return money({ currencyCode: 'USD', currencyAmount: 0 });
  if (totals.size > 1) return `${totals.size} 种币种`;
  const [currencyCode, currencyAmount] = [...totals.entries()][0];
  return money({ currencyCode, currencyAmount });
}

function historyText(item: History) {
  const change = item.changes[0];
  if (!change) return '状态已更新';
  if (change.type === 'balance') return `${CHANGE_NAMES[change.type]}：${money(change.before as Money)} → ${money(change.after as Money)}`;
  if (change.type === 'expiring') return `距离到期仅剩 ${String(change.after)} 天`;
  return CHANGE_NAMES[change.type] || '状态已更新';
}

export function CreditAccountDashboard({ accountId }: { accountId: string }) {
  const [data, setData] = useState<Payload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'credits' | 'history'>('credits');
  const [stateFilter, setStateFilter] = useState<'active' | 'closed' | 'all'>('active');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/credit-monitor', { cache: 'no-store' });
      const body = await response.json() as Payload & { error?: string };
      if (!response.ok) throw new Error(body.error || '无法读取代金券监控数据');
      setData(body);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setNotice('');
    try {
      const response = await fetch('/api/credit-monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) });
      const body = await response.json() as { error?: string; credits?: number; changes?: number; errors?: Array<{ error: string }> };
      if (!response.ok) throw new Error(body.error || '同步失败');
      if (body.errors?.length) throw new Error(body.errors[0].error || '同步失败');
      setNotice(`同步完成：${body.credits || 0} 张券，${body.changes || 0} 项变化`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }

  const account = data.accounts.find((item) => item.accountId === accountId);
  const credits = useMemo(() => data.credits.filter((item) => item.accountId === accountId), [accountId, data.credits]);
  const activeCredits = useMemo(() => credits.filter((item) => item.state === 'active'), [credits]);
  const closedCredits = useMemo(() => credits.filter((item) => item.state !== 'active'), [credits]);
  const filteredCredits = stateFilter === 'active' ? activeCredits : stateFilter === 'closed' ? closedCredits : credits;
  const pageCount = Math.max(1, Math.ceil(filteredCredits.length / PAGE_SIZE));
  const visibleCredits = filteredCredits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const history = useMemo(() => data.history.filter((item) => item.accountId === accountId), [accountId, data.history]);
  const nearestExpiry = activeCredits.map((item) => item.endDate).filter(Boolean).sort()[0] || '';

  function chooseFilter(next: 'active' | 'closed' | 'all') {
    setStateFilter(next);
    setPage(1);
  }

  if (loading) return <main className={styles.shell}><div className={styles.empty}>正在读取账号详情...</div></main>;
  if (!account) return <main className={styles.shell}><div className={styles.missing}><h1>账号不在监控范围内</h1><Link className={styles.secondary} href="/credit-monitor">返回账号列表</Link></div></main>;

  return <main className={styles.shell}>
    <header className={styles.detailHeader}>
      <div className={styles.breadcrumb}><Link href="/credit-monitor">代金券监控</Link><span>/</span><b>{account.name}</b></div>
      <div className={styles.actions}><Link className={styles.secondary} href="/credit-monitor">返回账号列表</Link><button type="button" className={styles.primary} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? '同步中...' : '同步这个账号'}</button></div>
    </header>
    {notice && <div className={styles.notice}>{notice}</div>}

    <section className={styles.accountHero}>
      <div><div className={styles.accountIdentity}><b className={account.architecture === 'cma' ? styles.cma : styles.legacy}>{account.groupName}</b><span className={account.status === 'error' ? styles.errorStatus : styles.okStatus}>{account.status === 'error' ? '同步异常' : account.status === 'ok' ? '正常' : '未同步'}</span></div><h1>{account.name}</h1><code>{account.accountId}</code></div>
      <span>最后同步：{dateTime(account.lastRunAt)}</span>
    </section>
    {account.error && <p className={styles.detailError}>{account.error}</p>}

    <section className={styles.detailSummary}>
      <div><span>有效券</span><strong>{activeCredits.length}</strong><small>历史记录 {closedCredits.length} 张</small></div>
      <div><span>有效券发放金额</span><strong>{totalMoney(activeCredits, 'initialAmount')}</strong><small>仅统计有效券</small></div>
      <div><span>预计剩余</span><strong>{totalMoney(activeCredits, 'estimatedAmount')}</strong><small>按 AWS 预计金额</small></div>
      <div><span>最近到期</span><strong className={styles.dateValue}>{nearestExpiry ? dateOnly(nearestExpiry) : '暂无'}</strong><small>{nearestExpiry ? '最近一张有效券' : '没有有效券'}</small></div>
    </section>

    <section className={styles.detailPanel}>
      <div className={styles.viewTabs}>
        <button className={view === 'credits' ? styles.selectedView : ''} onClick={() => setView('credits')}>代金券明细</button>
        <button className={view === 'history' ? styles.selectedView : ''} onClick={() => setView('history')}>变化记录 {history.length}</button>
      </div>

      {view === 'credits' ? <>
        <div className={styles.creditFilters}>
          <button className={stateFilter === 'active' ? styles.selectedFilter : ''} onClick={() => chooseFilter('active')}>有效 {activeCredits.length}</button>
          <button className={stateFilter === 'closed' ? styles.selectedFilter : ''} onClick={() => chooseFilter('closed')}>已结束 {closedCredits.length}</button>
          <button className={stateFilter === 'all' ? styles.selectedFilter : ''} onClick={() => chooseFilter('all')}>所有记录 {credits.length}</button>
        </div>
        {visibleCredits.length === 0 ? <div className={styles.empty}>此分类暂无代金券</div> : <div className={styles.creditTableWrap}><div className={styles.creditTable}>
          <div className={styles.tableHead}><span>代金券</span><span>所有者</span><span>已发放</span><span>已使用</span><span>剩余</span><span>预计剩余</span><span>到期日</span><span>状态</span></div>
          {visibleCredits.map((credit) => <div className={styles.tableRow} key={credit.creditId}>
            <div><strong>{credit.description}</strong><small>{credit.creditId}</small>{credit.applicableProductNames.length > 0 && <em>{credit.applicableProductNames.slice(0, 3).join(' / ')}</em>}</div>
            <span>{credit.ownerAccountId}</span><span>{money(credit.initialAmount)}</span><span>{money(credit.usedAmount)}</span><span>{money(credit.remainingAmount)}</span><span>{money(credit.estimatedAmount)}</span><span>{dateOnly(credit.endDate)}</span><b className={styles[`state_${credit.state}`]}>{STATE_NAMES[credit.state]}</b>
          </div>)}
        </div></div>}
        {pageCount > 1 && <div className={styles.pagination}><button disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button><span>{page} / {pageCount}</span><button disabled={page === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button></div>}
      </> : history.length === 0 ? <div className={styles.empty}>暂时没有变化记录</div> : <div className={styles.historyList}>
        {history.slice(0, 100).map((item) => <div className={styles.historyRow} key={`${item.creditId}-${item.observedAt}`}><time>{dateTime(item.observedAt)}</time><div><strong>{item.description}</strong><small>{item.creditId}</small></div><b>{historyText(item)}</b></div>)}
      </div>}
    </section>
  </main>;
}
