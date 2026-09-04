'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import styles from './ou-automation.module.css';

type OuOption = { id: string; name: string };
type AutomationAccount = {
  accountId: string;
  remark: string;
  groupName: string;
  temporaryOuId: string;
  restrictedOuId: string;
  configured: boolean;
  lastRunAt?: string;
  lastStatus?: string;
};
type Discovery = { account: AutomationAccount; ous: OuOption[]; temporaryOuId: string; restrictedOuId: string };

export type OuAutomationHandle = { initializeAccount: (accountId: string) => Promise<void> };

export const OuAutomationPanel = forwardRef<OuAutomationHandle, { onNotice: (message: string) => void }>(function OuAutomationPanel({ onNotice }, ref) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<AutomationAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [mapping, setMapping] = useState({ temporaryOuId: '', restrictedOuId: '' });

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  async function request(body: Record<string, unknown>) {
    const response = await fetch('/api/ou-automation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'OU 自动化操作失败');
    return payload;
  }

  async function loadAccounts(preferredAccountId = '') {
    const response = await fetch('/api/ou-automation', { cache: 'no-store' });
    const payload = await response.json() as { accounts?: AutomationAccount[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? '自动化配置读取失败');
    const next = payload.accounts ?? [];
    setAccounts(next);
    const nextId = preferredAccountId || selectedAccountId || next[0]?.accountId || '';
    setSelectedAccountId(nextId);
    return nextId;
  }

  async function inspect(accountId: string) {
    setSelectedAccountId(accountId);
    setDiscovery(null);
    const payload = await request({ action: 'discover', accountId }) as { discovery?: Discovery };
    if (!payload.discovery) throw new Error('未返回 OU 信息');
    setDiscovery(payload.discovery);
    setMapping({ temporaryOuId: payload.discovery.temporaryOuId || '', restrictedOuId: payload.discovery.restrictedOuId || '' });
  }

  async function showPanel(preferredAccountId = '') {
    setOpen(true);
    setBusy(true);
    try {
      const accountId = await loadAccounts(preferredAccountId);
      if (accountId) await inspect(accountId);
      else setDiscovery(null);
    } catch (error) { onNotice(error instanceof Error ? error.message : '自动化配置读取失败'); }
    finally { setBusy(false); }
  }

  async function initializeAccount(accountId: string) {
    setBusy(true);
    try {
      const payload = await request({ action: 'initialize', accountId }) as { mappingRequired?: boolean; discovery?: Discovery };
      if (payload.mappingRequired && payload.discovery) {
        setOpen(true);
        await loadAccounts(accountId);
        setDiscovery(payload.discovery);
        setMapping({ temporaryOuId: payload.discovery.temporaryOuId || '', restrictedOuId: payload.discovery.restrictedOuId || '' });
        onNotice('发现非标准 OU，请确认对应关系');
      } else onNotice('账号已添加，OU 自动化已初始化');
    } catch (error) { onNotice(error instanceof Error ? error.message : '账号已保存，但 OU 初始化失败'); }
    finally { setBusy(false); }
  }

  useImperativeHandle(ref, () => ({ initializeAccount }), []);

  async function saveMapping() {
    if (!selectedAccountId) return;
    if (mapping.temporaryOuId && mapping.temporaryOuId === mapping.restrictedOuId) { onNotice('两个 OU 不能选择同一项'); return; }
    setBusy(true);
    try {
      await request({ action: 'configure', accountId: selectedAccountId, ...mapping });
      onNotice('OU 映射和 SCP 已初始化');
      await loadAccounts(selectedAccountId);
      await inspect(selectedAccountId);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'OU 映射保存失败'); }
    finally { setBusy(false); }
  }

  async function run(accountId = '') {
    setBusy(true);
    try {
      const payload = await request(accountId ? { action: 'run', accountId } : { action: 'run-all' }) as { result?: { message?: string }; results?: unknown[] };
      onNotice(payload.result?.message ?? `已执行 ${payload.results?.length ?? 0} 个代付 Organization`);
      await loadAccounts(accountId || selectedAccountId);
      if (accountId || selectedAccountId) await inspect(accountId || selectedAccountId);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'OU 归位失败'); }
    finally { setBusy(false); }
  }

  return <>
    <button className={styles.trigger} onClick={() => void showPanel()}>自动化OU归位</button>
    {open && <div className={styles.layer} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className={styles.dialog} role="dialog" aria-modal="true">
        <button className={styles.close} onClick={() => setOpen(false)}>×</button>
        <header className={styles.heading}><span>ORGANIZATION CONTROL</span><h2>自动化OU归位</h2><p>仅处理 CMA架构和老代付架构中的代付 Organization；每日把成员子账号归位到“禁止 SP/RI”。</p></header>
        <div className={styles.toolbar}><strong>代付 Organization {accounts.length}</strong><button disabled={busy || accounts.length === 0} onClick={() => void run()}>{busy ? '执行中...' : '全部立即归位'}</button></div>
        <div className={styles.layout}>
          <aside className={styles.accounts}>{accounts.length === 0 ? <p>目标架构中暂无代付账号</p> : accounts.map((account) => <button key={account.accountId} className={selectedAccountId === account.accountId ? styles.active : ''} onClick={() => { setBusy(true); void inspect(account.accountId).catch((error) => onNotice(error.message)).finally(() => setBusy(false)); }}><span>{account.remark.slice(0, 1).toUpperCase()}</span><div><strong>{account.remark}</strong><small>{account.accountId} · {account.groupName}</small></div><i className={account.configured ? styles.ready : ''}>{account.configured ? '已映射' : '待配置'}</i></button>)}</aside>
          <section className={styles.config}>{busy && !discovery ? <div className={styles.empty}>正在读取 AWS Organizations...</div> : !discovery ? <div className={styles.empty}>选择一个代付账号检查 OU</div> : <>
            <div className={styles.accountHead}><div><strong>{discovery.account.remark}</strong><small>{discovery.account.accountId}</small></div><button disabled={busy || !discovery.account.restrictedOuId} onClick={() => void run(discovery.account.accountId)}>立即归位</button></div>
            <label><span>临时 OU</span><select value={mapping.temporaryOuId} onChange={(event) => setMapping((current) => ({ ...current, temporaryOuId: event.target.value }))}><option value="">未找到则创建“临时”</option>{discovery.ous.map((ou) => <option key={ou.id} value={ou.id}>{ou.name} · {ou.id}</option>)}</select></label>
            <label><span>禁止 SP/RI OU</span><select value={mapping.restrictedOuId} onChange={(event) => setMapping((current) => ({ ...current, restrictedOuId: event.target.value }))}><option value="">未找到则创建“禁止 SP/RI”</option>{discovery.ous.map((ou) => <option key={ou.id} value={ou.id}>{ou.name} · {ou.id}</option>)}</select></label>
            <div className={styles.policy}><span>自动维护</span><strong>FullAWSAccess + SP/RI-Deny + Organizations</strong><small>SCP 只挂到“禁止 SP/RI”，不限制代付管理账号。</small></div>
            <button className={styles.save} disabled={busy} onClick={() => void saveMapping()}>{busy ? '处理中...' : '保存映射并初始化'}</button>
          </>}</section>
        </div>
      </section>
    </div>}
  </>;
});
