'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from './credit-monitor.module.css';

type Money = { currencyCode: string; currencyAmount: number };
type Credit = {
  accountId: string;
  accountName: string;
  creditId: string;
  description: string;
  initialAmount: Money;
  estimatedAmount: Money;
  endDate: string;
  state: 'active' | 'exhausted' | 'expired' | 'disabled';
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
type Payload = { accounts: AccountState[]; credits: Credit[]; history: unknown[] };
const EMPTY: Payload = { accounts: [], credits: [], history: [] };

function dateTime(value: string) {
  if (!value) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dateOnly(value: string) {
  if (!value) return '无到期日';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function money(value: Money) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: value.currencyCode || 'USD', minimumFractionDigits: 2 }).format(Number(value.currencyAmount || 0));
}

function totalMoney(credits: Credit[]) {
  const totals = new Map<string, number>();
  for (const credit of credits) {
    const currency = credit.estimatedAmount?.currencyCode || 'USD';
    totals.set(currency, (totals.get(currency) || 0) + Number(credit.estimatedAmount?.currencyAmount || 0));
  }
  if (totals.size === 0) return money({ currencyCode: 'USD', currencyAmount: 0 });
  if (totals.size > 1) return `${totals.size} 种币种`;
  const [currencyCode, currencyAmount] = [...totals.entries()][0];
  return money({ currencyCode, currencyAmount });
}

export function CreditMonitorDashboard() {
  const [data, setData] = useState<Payload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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

  async function refresh() {
    setRefreshing(true);
    setNotice('');
    try {
      const response = await fetch('/api/credit-monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await response.json() as { error?: string; accounts?: number; credits?: number; changes?: number; errors?: unknown[] };
      if (!response.ok) throw new Error(body.error || '同步失败');
      const suffix = body.errors?.length ? `，${body.errors.length} 个账号失败` : '';
      setNotice(`同步完成：${body.accounts || 0} 个账号，${body.credits || 0} 张券，${body.changes || 0} 项变化${suffix}`);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  }

  const accountRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.accounts
      .filter((item) => (architecture === 'all' || item.architecture === architecture) && (!needle || item.name.toLowerCase().includes(needle) || item.accountId.includes(needle)))
      .map((account) => {
        const credits = data.credits.filter((credit) => credit.accountId === account.accountId);
        const activeCredits = credits.filter((credit) => credit.state === 'active');
        const nearestExpiry = activeCredits.map((credit) => credit.endDate).filter(Boolean).sort()[0] || '';
        return { account, activeCredits, nearestExpiry, remaining: totalMoney(activeCredits) };
      })
      .sort((left, right) => Number(right.account.status === 'error') - Number(left.account.status === 'error') || right.activeCredits.length - left.activeCredits.length || left.account.name.localeCompare(right.account.name, 'zh-CN'));
  }, [architecture, data.accounts, data.credits, query]);

  const activeCredits = useMemo(() => data.credits.filter((item) => item.state === 'active'), [data.credits]);
  const errorCount = useMemo(() => data.accounts.filter((item) => item.status === 'error').length, [data.accounts]);
  const cmaCount = useMemo(() => data.accounts.filter((item) => item.architecture === 'cma').length, [data.accounts]);
  const legacyCount = data.accounts.length - cmaCount;
  const lastRunAt = useMemo(() => data.accounts.map((item) => item.lastRunAt).filter(Boolean).sort().at(-1) || '', [data.accounts]);

  return <main className={styles.shell}>
    <header className={styles.header}>
      <div><span>账单与成本管理</span><h1>代金券监控</h1><p>先选代付账号，再查看该账号的代金券明细</p></div>
      <div className={styles.actions}><Link className={styles.secondary} href="/">返回账号管理</Link><button type="button" className={styles.primary} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? '同步中...' : '立即同步'}</button></div>
    </header>
    {notice && <div className={styles.notice}>{notice}</div>}

    <section className={styles.summary}>
      <div><span>监控账号</span><strong>{data.accounts.length}</strong><small>CMA {cmaCount} · 老代付 {legacyCount}</small></div>
      <div><span>有效代金券</span><strong>{activeCredits.length}</strong><small>全部券 {data.credits.length}</small></div>
      <div><span>有效券预计余额</span><strong>{totalMoney(activeCredits)}</strong><small>按 AWS 预计金额统计</small></div>
      <div className={errorCount ? styles.summaryDanger : ''}><span>异常账号</span><strong>{errorCount}</strong><small>{errorCount ? '请进入账号查看' : '全部正常'}</small></div>
    </section>

    <section className={styles.accountPanel}>
      <div className={styles.accountPanelTop}>
        <div><h2>选择代付账号</h2><p>账号详情、历史券和变化记录均放在独立页面</p></div>
        <span>最后同步：{dateTime(lastRunAt)} · 每天 09:15 自动同步</span>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          <button className={architecture === 'all' ? styles.selectedTab : ''} onClick={() => setArchitecture('all')}>全部 {data.accounts.length}</button>
          <button className={architecture === 'cma' ? styles.selectedTab : ''} onClick={() => setArchitecture('cma')}>CMA {cmaCount}</button>
          <button className={architecture === 'legacy_payer' ? styles.selectedTab : ''} onClick={() => setArchitecture('legacy_payer')}>老代付 {legacyCount}</button>
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号名称或 ID" />
      </div>

      {loading ? <div className={styles.empty}>正在读取...</div> : accountRows.length === 0 ? <div className={styles.empty}>没有匹配的代付账号</div> : <div className={styles.accountGrid}>
        {accountRows.map(({ account, activeCredits: accountActiveCredits, nearestExpiry, remaining }) => <Link className={styles.accountCard} href={`/credit-monitor/${account.accountId}`} key={account.accountId}>
          <div className={styles.cardTitle}><b className={account.architecture === 'cma' ? styles.cma : styles.legacy}>{account.groupName}</b><span className={account.status === 'error' ? styles.errorStatus : styles.okStatus}>{account.status === 'error' ? '同步异常' : account.status === 'ok' ? '正常' : '未同步'}</span></div>
          <h3>{account.name}</h3>
          <code>{account.accountId}</code>
          <div className={styles.cardMetrics}>
            <div><span>有效券</span><strong>{accountActiveCredits.length}</strong><small>共 {account.creditCount} 张</small></div>
            <div><span>预计余额</span><strong>{remaining}</strong><small>仅统计有效券</small></div>
          </div>
          <div className={styles.cardFooter}><span>{nearestExpiry ? `最近到期 ${dateOnly(nearestExpiry)}` : '暂无有效券'}</span><b>查看详情 →</b></div>
          {account.error && <p className={styles.cardError}>{account.error}</p>}
        </Link>)}
      </div>}
    </section>
  </main>;
}
