'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Clipboard, ExternalLink, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import styles from './support-case-monitor.module.css';

type TrackedCase = { caseId: string; displayId: string; subject: string; statusLabel: string; submittedBy: string; latestAt: string; latestBody: string };
type TrackedAccount = { accountId: string; remark: string; lastCheckedAt: string; cases: TrackedCase[] };
type MonitorData = { accounts: TrackedAccount[]; lastCheckedAt: string };

async function requestMonitor(body?: Record<string, unknown>) {
  const response = await fetch('/api/support-case-monitor', body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || '操作失败');
  return payload;
}

function formatTime(value: string) {
  if (!value) return '尚未检查';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function SupportCaseMonitorDashboard({ userName }: { userName: string }) {
  const [data, setData] = useState<MonitorData>({ accounts: [], lastCheckedAt: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [accountModal, setAccountModal] = useState(false);
  const [caseAccount, setCaseAccount] = useState<TrackedAccount | null>(null);
  const [remark, setRemark] = useState('');
  const [accountId, setAccountId] = useState('');
  const [externalId, setExternalId] = useState('');
  const [command, setCommand] = useState('');
  const [caseIds, setCaseIds] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await requestMonitor()); }
    catch (error) { setNotice(error instanceof Error ? error.message : '读取失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function prepareAccount() {
    if (!/^\d{12}$/.test(accountId.trim())) return setNotice('请输入 12 位 AWS 账号 ID');
    setBusy('prepare');
    try {
      const result = await requestMonitor({ action: 'prepareAccount', accountId: accountId.trim() });
      setExternalId(result.externalId); setCommand(result.command);
      setNotice('授权命令已生成，请在客户账号的 CloudShell 中执行');
    } catch (error) { setNotice(error instanceof Error ? error.message : '生成失败'); }
    finally { setBusy(''); }
  }

  async function verifyAccount() {
    setBusy('verify');
    try {
      await requestMonitor({ action: 'verifyAccount', accountId: accountId.trim(), remark: remark.trim(), externalId });
      setNotice('授权验证成功，账号已加入工单跟踪'); setAccountModal(false);
      setCommand(''); setExternalId(''); setAccountId(''); setRemark(''); await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : '暂时无法验证授权'); }
    finally { setBusy(''); }
  }

  async function addCases() {
    if (!caseAccount || !caseIds.trim()) return;
    setBusy('cases');
    try {
      const result = await requestMonitor({ action: 'addCases', accountId: caseAccount.accountId, caseIds });
      const missing = result.missing?.length ? `，未找到：${result.missing.join('、')}` : '';
      setNotice(`已添加 ${result.added} 个工单${missing}`); setCaseAccount(null); setCaseIds(''); await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : '添加工单失败'); }
    finally { setBusy(''); }
  }

  async function refresh() {
    setBusy('refresh');
    try { const result = await requestMonitor({ action: 'refresh' }); setNotice(`检查完成：${result.checkedCases || 0} 个工单，${result.changedCases || 0} 项更新`); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '检查失败'); }
    finally { setBusy(''); }
  }

  async function openCase(account: TrackedAccount, trackedCase: TrackedCase) {
    const popup = window.open('about:blank', '_blank'); setBusy(`open-${trackedCase.caseId}`);
    try {
      const result = await requestMonitor({ action: 'consoleLogin', accountId: account.accountId, caseId: trackedCase.caseId });
      if (popup) { popup.opener = null; popup.location.href = result.url; } else setNotice('浏览器拦截了新窗口，请允许本站打开新窗口');
    } catch (error) { popup?.close(); setNotice(error instanceof Error ? error.message : '无法进入工单'); }
    finally { setBusy(''); }
  }

  async function removeCase(account: TrackedAccount, trackedCase: TrackedCase) {
    if (!window.confirm(`停止跟踪工单 ${trackedCase.displayId}？`)) return;
    setBusy(`case-${trackedCase.caseId}`);
    try { await requestMonitor({ action: 'deleteCase', accountId: account.accountId, caseId: trackedCase.caseId }); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '删除失败'); }
    finally { setBusy(''); }
  }

  async function removeAccount(account: TrackedAccount) {
    if (!window.confirm(`删除客户账号“${account.remark || account.accountId}”及全部工单记录？`)) return;
    setBusy(`account-${account.accountId}`);
    try {
      const result = await requestMonitor({ action: 'deleteAccount', accountId: account.accountId });
      setNotice(result.roleDeleted ? '账号已删除，客户侧授权角色也已回收' : '账号已从监控中删除；客户侧角色未能自动回收，清理命令已复制');
      if (!result.roleDeleted && result.cleanupCommand) await navigator.clipboard.writeText(result.cleanupCommand).catch(() => undefined);
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : '删除失败'); }
    finally { setBusy(''); }
  }

  return <main className={styles.page}>
    <header className={styles.header}><div><p className={styles.eyebrow}>AWS SUPPORT</p><h1>工单跟踪</h1><p>集中查看外部客户账号的 AWS Support 工单更新</p></div><div className={styles.actions}><span>{userName}</span><a href="/" className={styles.secondary}><ArrowLeft size={16} />返回账号管理</a><button className={styles.secondary} onClick={() => setAccountModal(true)}><Plus size={16} />添加客户账号</button><button className={styles.primary} disabled={!!busy} onClick={refresh}><RefreshCw size={16} className={busy === 'refresh' ? styles.spin : ''} />立即检查</button></div></header>
    {notice && <div className={styles.notice}>{notice}<button onClick={() => setNotice('')}><X size={15} /></button></div>}
    <section className={styles.summary}><div><strong>{data.accounts.length}</strong><span>客户账号</span></div><div><strong>{data.accounts.reduce((sum, account) => sum + account.cases.length, 0)}</strong><span>跟踪工单</span></div><div><strong>{formatTime(data.lastCheckedAt)}</strong><span>最近检查</span></div><p>系统每天北京时间 09:00、16:00 自动检查；有新回复或状态变化时发送企业微信通知。</p></section>
    {loading ? <div className={styles.empty}><RefreshCw className={styles.spin} />正在读取工单</div> : data.accounts.length === 0 ? <div className={styles.empty}><h2>暂无跟踪账号</h2><p>先添加客户账号并完成授权，再录入需要跟踪的工单号。</p></div> : <section className={styles.accountList}>{data.accounts.map(account => <article className={styles.account} key={account.accountId}>
      <div className={styles.accountHead}><div><h2>{account.remark || '客户账号'}</h2><p>{account.accountId} · 最近检查 {formatTime(account.lastCheckedAt)}</p></div><div><button className={styles.secondary} onClick={() => setCaseAccount(account)}><Plus size={15} />添加工单</button><button className={styles.danger} disabled={busy === `account-${account.accountId}`} onClick={() => removeAccount(account)}><Trash2 size={15} />删除账号</button></div></div>
      {account.cases.length === 0 ? <div className={styles.noCases}>尚未添加工单</div> : <div className={styles.caseList}>{account.cases.map(trackedCase => <div className={styles.caseCard} key={trackedCase.caseId}><div className={styles.caseMain}><div className={styles.caseTitle}><span className={styles.status}>{trackedCase.statusLabel}</span><h3>{trackedCase.subject || `工单 ${trackedCase.displayId}`}</h3></div><p className={styles.caseMeta}>工单号 {trackedCase.displayId} · 最后更新 {formatTime(trackedCase.latestAt)}{trackedCase.submittedBy ? ` · ${trackedCase.submittedBy}` : ''}</p><p className={styles.message}>{trackedCase.latestBody || '暂无回复内容'}</p></div><div className={styles.caseActions}><button className={styles.primary} disabled={busy === `open-${trackedCase.caseId}`} onClick={() => openCase(account, trackedCase)}><ExternalLink size={15} />进入工单</button><button className={styles.iconButton} title="停止跟踪" onClick={() => removeCase(account, trackedCase)}><Trash2 size={16} /></button></div></div>)}</div>}
    </article>)}</section>}
    {accountModal && <div className={styles.backdrop}><div className={styles.modal}><button className={styles.close} onClick={() => setAccountModal(false)}><X /></button><p className={styles.eyebrow}>客户授权</p><h2>添加客户账号</h2><label>客户名称<input value={remark} onChange={event => setRemark(event.target.value)} placeholder="例如：某某科技" /></label><label>AWS 账号 ID<input value={accountId} onChange={event => setAccountId(event.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="12 位账号 ID" /></label>{!command ? <button className={styles.primary} disabled={busy === 'prepare'} onClick={prepareAccount}>{busy === 'prepare' ? '正在生成...' : '生成 CloudShell 授权命令'}</button> : <><div className={styles.commandHead}><span>请让客户使用管理员身份在 CloudShell 执行</span><button onClick={() => navigator.clipboard.writeText(command)}><Clipboard size={15} />复制</button></div><pre>{command}</pre><button className={styles.primary} disabled={busy === 'verify'} onClick={verifyAccount}>{busy === 'verify' ? '正在验证授权...' : '我已执行，验证并保存'}</button></>}</div></div>}
    {caseAccount && <div className={styles.backdrop}><div className={styles.modal}><button className={styles.close} onClick={() => setCaseAccount(null)}><X /></button><p className={styles.eyebrow}>新增跟踪</p><h2>添加工单</h2><p>{caseAccount.remark || caseAccount.accountId}</p><label>工单号<textarea rows={5} value={caseIds} onChange={event => setCaseIds(event.target.value)} placeholder={'每行一个工单号\n例如：1234567890'} /></label><button className={styles.primary} disabled={busy === 'cases'} onClick={addCases}>{busy === 'cases' ? '正在读取工单...' : '确认添加'}</button></div></div>}
  </main>;
}
