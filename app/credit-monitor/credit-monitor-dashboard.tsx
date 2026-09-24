'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './credit-monitor.module.css';

type Money = { currencyCode: string; currencyAmount: number };
type Credit = {
  accountId: string;
  accountName: string;
  architecture: 'cma' | 'legacy_payer';
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
  state: 'active' | 'exhausted' | 'expired' | 'disabled';
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
type History = { accountId: string; accountName: string; architecture: string; creditId: string; description: string; changes: Array<{ type: string; field: string; before: unknown; after: unknown; threshold?: number }>; observedAt: string };
type Payload = { accounts: AccountState[]; credits: Credit[]; history: History[] };
const EMPTY: Payload = { accounts: [], credits: [], history: [] };

function dateTime(value: string) {
  if (!value) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dateOnly(value: string) {
  if (!value) return '无到期日';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function money(value?: Money) {
  if (!value) return '-';
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: value.currencyCode || 'USD', minimumFractionDigits: 2 }).format(Number(value.currencyAmount || 0));
}

const STATE_NAMES: Record<string, string> = { active: '有效', exhausted: '已耗尽', expired: '已过期', disabled: '已停用' };
const CHANGE_NAMES: Record<string, string> = { new: '新增代金券', balance: '余额变化', exhausted: '代金券耗尽', status: '状态变化', expiry_changed: '到期日变化', expiring: '即将到期' };

function historyText(item: History) {
  const change = item.changes[0];
  if (!change) return '状态已更新';
  if (change.type === 'balance') {
    const before = change.before as Money;
    const after = change.after as Money;
    return `${CHANGE_NAMES[change.type]}：${money(before)} → ${money(after)}`;
  }
  if (change.type === 'expiring') return `距离到期仅剩 ${String(change.after)} 天`;
  return CHANGE_NAMES[change.type] || '状态已更新';
}

export function CreditMonitorDashboard() {
  const [data, setData] = useState<Payload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [architecture, setArchitecture] = useState<'all' | 'cma' | 'legacy_payer'>('all');

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

  async function refresh(accountId = '') {
    setRefreshing(accountId || 'all');
    setNotice('');
    try {
      const response = await fetch('/api/credit-monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accountId ? { accountId } : {}) });
      const body = await response.json() as { error?: string; accounts?: number; credits?: number; changes?: number; baselines?: number; errors?: Array<{ name: string; error: string }> };
      if (!response.ok) throw new Error(body.error || '同步失败');
      const suffix = body.errors?.length ? `，${body.errors.length} 个账号失败` : '';
      setNotice(`同步完成：${body.accounts || 0} 个账号，${body.credits || 0} 张券，${body.changes || 0} 项变化${suffix}`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing('');
    }
  }

  const accounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.accounts.filter((item) => (architecture === 'all' || item.architecture === architecture) && (!needle || item.name.toLowerCase().includes(needle) || item.accountId.includes(needle)));
  }, [architecture, data.accounts, query]);
  const activeCount = useMemo(() => data.credits.filter((item) => item.state === 'active').length, [data.credits]);
  const errorCount = useMemo(() => data.accounts.filter((item) => item.status === 'error').length, [data.accounts]);
  const lastRunAt = useMemo(() => data.accounts.map((item) => item.lastRunAt).filter(Boolean).sort().at(-1) || '', [data.accounts]);

  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><span>账单与成本管理</span><h1>代金券监控</h1><p>老架构监控老代付账号，新架构仅监控 CMA</p></div>
      <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => window.location.assign('/')}>返回账号管理</button><button type="button" className={styles.primary} disabled={Boolean(refreshing)} onClick={() => void refresh()}>{refreshing === 'all' ? '同步中...' : '立即同步'}</button></div>
    </header>
    {notice && <div className={styles.notice}>{notice}</div>}
    <section className={styles.summary}>
      <div><span>监控账号</span><strong>{data.accounts.length}</strong></div>
      <div><span>代金券</span><strong>{data.credits.length}</strong></div>
      <div><span>有效券</span><strong>{activeCount}</strong></div>
      <div className={errorCount ? styles.summaryDanger : ''}><span>异常账号</span><strong>{errorCount}</strong></div>
      <small>最后同步：{dateTime(lastRunAt)}</small>
    </section>
    <section className={styles.toolbar}>
      <div className={styles.tabs}><button className={architecture === 'all' ? styles.active : ''} onClick={() => setArchitecture('all')}>全部</button><button className={architecture === 'cma' ? styles.active : ''} onClick={() => setArchitecture('cma')}>CMA</button><button className={architecture === 'legacy_payer' ? styles.active : ''} onClick={() => setArchitecture('legacy_payer')}>老代付</button></div>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号名称或 ID" />
      <span>每天 09:15 自动同步</span>
    </section>
    {loading ? <section className={styles.empty}>正在读取...</section> : accounts.length === 0 ? <section className={styles.empty}>没有匹配的代付账号</section> : <section className={styles.accounts}>
      {accounts.map((account) => {
        const credits = data.credits.filter((credit) => credit.accountId === account.accountId);
        return <article className={styles.account} key={account.accountId}>
          <div className={styles.accountHeader}>
            <div><b className={account.architecture === 'cma' ? styles.cma : styles.legacy}>{account.groupName}</b><h2>{account.name}</h2><small>{account.accountId}</small></div>
            <div><span className={account.status === 'error' ? styles.errorStatus : styles.okStatus}>{account.status === 'error' ? '同步异常' : account.status === 'ok' ? '正常' : '尚未同步'}</span><small>{dateTime(account.lastRunAt)}</small><button type="button" disabled={Boolean(refreshing)} onClick={() => void refresh(account.accountId)}>{refreshing === account.accountId ? '同步中' : '同步'}</button></div>
          </div>
          {account.error && <p className={styles.accountError}>{account.error}</p>}
          {credits.length === 0 ? <div className={styles.noCredits}>{account.status === 'not_scanned' ? '点击同步建立监控基准' : '当前未读取到代金券'}</div> : <div className={styles.creditTable}>
            <div className={styles.tableHead}><span>代金券</span><span>所有者</span><span>已发放</span><span>已使用</span><span>剩余</span><span>预计剩余</span><span>到期日</span><span>状态</span></div>
            {credits.map((credit) => <div className={styles.tableRow} key={credit.creditId}>
              <div><strong>{credit.description}</strong><small>{credit.creditId}</small>{credit.applicableProductNames.length > 0 && <em>{credit.applicableProductNames.slice(0, 3).join(' / ')}</em>}</div>
              <span>{credit.ownerAccountId}</span><span>{money(credit.initialAmount)}</span><span>{money(credit.usedAmount)}</span><span>{money(credit.remainingAmount)}</span><span>{money(credit.estimatedAmount)}</span><span>{dateOnly(credit.endDate)}</span><b className={styles[credit.state]}>{STATE_NAMES[credit.state] || credit.state}</b>
            </div>)}
          </div>}
        </article>;
      })}
    </section>}
    {data.history.length > 0 && <section className={styles.history}><div className={styles.historyTitle}><span>变化记录</span><small>最近 {Math.min(data.history.length, 200)} 条</small></div>{data.history.slice(0, 30).map((item) => <div className={styles.historyRow} key={`${item.accountId}-${item.creditId}-${item.observedAt}`}><time>{dateTime(item.observedAt)}</time><strong>{item.accountName}</strong><span>{item.description}</span><b>{historyText(item)}</b></div>)}</section>}
  </main>;
}
