'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import styles from './ou-automation.module.css';

type OuOption = { id: string; name: string; match?: 'saved' | 'exact' | 'compatible' | 'created' };
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
type Discovery = { account: AutomationAccount; temporaryOu: OuOption | null; restrictedOu: OuOption | null; temporaryOuId: string; restrictedOuId: string };

export type OuAutomationHandle = { initializeAccount: (accountId: string) => Promise<void> };

export const OuAutomationPanel = forwardRef<OuAutomationHandle, { onNotice: (message: string) => void }>(function OuAutomationPanel({ onNotice }, ref) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<AutomationAccount[]>([]);
  const [accountQuery, setAccountQuery] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  async function request(body: Record<string, unknown>) {
    const response = await fetch('/api/ou-automation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as Record<string, unknown> & { error?: string; preview?: boolean };
    if (!response.ok) throw new Error(payload.error ?? 'OU 自动化操作失败');
    setPreviewMode(Boolean(payload.preview));
    return payload;
  }

  async function loadAccounts(preferredAccountId = '') {
    const response = await fetch('/api/ou-automation', { cache: 'no-store' });
    const payload = await response.json() as { accounts?: AutomationAccount[]; error?: string; preview?: boolean };
    if (!response.ok) throw new Error(payload.error ?? '自动化配置读取失败');
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
    const payload = await request({ action: 'discover', accountId }) as { discovery?: Discovery };
    if (!payload.discovery) throw new Error('未返回 OU 信息');
    setDiscovery(payload.discovery);
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
      const payload = await request({ action: 'initialize', accountId }) as { discovery?: Discovery; preview?: boolean };
      if (payload.preview && payload.discovery) {
        setOpen(true);
        await loadAccounts(accountId);
        setDiscovery(payload.discovery);
        onNotice('本地预览已读取目标账号');
      } else onNotice('账号已添加，OU 已自动识别并初始化');
    } catch (error) { onNotice(error instanceof Error ? error.message : '账号已保存，但 OU 初始化失败'); }
    finally { setBusy(false); }
  }

  // The parent only needs a stable command handle; preferredAccountId keeps this path independent of render state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ initializeAccount }), []);

  async function initializeSelected() {
    if (!selectedAccountId) return;
    setBusy(true);
    try {
      await request({ action: 'initialize', accountId: selectedAccountId });
      onNotice('OU 已自动识别，缺失项和 SCP 已补齐');
      await loadAccounts(selectedAccountId);
      await inspect(selectedAccountId);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'OU 自动初始化失败'); }
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

  const accountNeedle = accountQuery.trim().toLocaleLowerCase('zh-CN');
  const visibleAccounts = accounts.filter((account) => !accountNeedle || [account.remark, account.accountId, account.groupName].some((value) => value.toLocaleLowerCase('zh-CN').includes(accountNeedle)));

  return <>
    <button className={styles.trigger} onClick={() => void showPanel()}>自动化OU归位</button>
    {open && <div className={styles.layer} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className={styles.dialog} role="dialog" aria-modal="true">
        <button className={styles.close} onClick={() => setOpen(false)}>×</button>
        <header className={styles.heading}><span>ORGANIZATION CONTROL</span><h2>自动化OU归位</h2><p>{previewMode ? '本地预览：显示真实代付账号，但不会执行 AWS 操作。' : '自动识别兼容 OU，缺失时创建标准 OU；每日把成员子账号归位到“禁止 SP/RI”。'}</p></header>
        <div className={styles.toolbar}><strong>代付 Organization {accounts.length}</strong><input value={accountQuery} onChange={(event) => setAccountQuery(event.target.value)} placeholder="搜索备注或账号 ID" aria-label="搜索代付账号" /><button disabled={busy || accounts.length === 0 || previewMode} onClick={() => void run()}>{busy ? '执行中...' : '全部立即归位'}</button></div>
        <div className={styles.layout}>
          <aside className={styles.accounts}>{accounts.length === 0 ? <p>目标架构中暂无代付账号</p> : visibleAccounts.length === 0 ? <p>没有匹配的代付账号</p> : visibleAccounts.map((account) => <button key={account.accountId} className={selectedAccountId === account.accountId ? styles.active : ''} onClick={() => { setBusy(true); void inspect(account.accountId).catch((error) => onNotice(error.message)).finally(() => setBusy(false)); }}><span>{account.remark.slice(0, 1).toUpperCase()}</span><div><strong>{account.remark}</strong><small>{account.accountId} · {account.groupName}</small></div><i className={account.configured ? styles.ready : ''}>{account.configured ? '已初始化' : previewMode ? '待线上识别' : '待初始化'}</i></button>)}</aside>
          <section className={styles.config}>{busy && !discovery ? <div className={styles.empty}>正在读取 AWS Organizations...</div> : !discovery ? <div className={styles.empty}>选择一个代付账号检查 OU</div> : <>
            <div className={styles.accountHead}><div><strong>{discovery.account.remark}</strong><small>{discovery.account.accountId}</small></div><button disabled={busy || previewMode || !discovery.account.restrictedOuId} onClick={() => void run(discovery.account.accountId)}>立即归位</button></div>
            <div className={styles.policy}><span>临时 OU</span><strong>{previewMode ? '本地预览尚未查询 AWS Organizations' : discovery.temporaryOu ? `${discovery.temporaryOu.name} · ${discovery.temporaryOu.id}` : '未识别到兼容 OU，将自动创建“临时”'}</strong><small>{previewMode ? '部署 Lambda 后自动执行精确名称和权限内容识别' : recognitionLabel(discovery.temporaryOu?.match)}</small></div>
            <div className={styles.policy}><span>禁止 SP/RI OU</span><strong>{previewMode ? '本地预览尚未查询 AWS Organizations' : discovery.restrictedOu ? `${discovery.restrictedOu.name} · ${discovery.restrictedOu.id}` : '未识别到兼容 OU，将自动创建“禁止 SP/RI”'}</strong><small>{previewMode ? '部署 Lambda 后自动执行精确名称和权限内容识别' : recognitionLabel(discovery.restrictedOu?.match)}</small></div>
            <div className={styles.policy}><span>自动维护</span><strong>FullAWSAccess + SP/RI-Deny + Organizations</strong><small>SCP 只挂到“禁止 SP/RI”，不限制代付管理账号。</small></div>
            <button className={styles.save} disabled={busy || previewMode} onClick={() => void initializeSelected()}>{previewMode ? '本地预览不可执行' : busy ? '处理中...' : '自动识别并初始化'}</button>
          </>}</section>
        </div>
      </section>
    </div>}
  </>;
});

function recognitionLabel(match?: OuOption['match']) {
  if (match === 'saved') return '已记录并确认存在';
  if (match === 'exact') return '标准名称精确识别';
  if (match === 'compatible') return '相似名称且 SCP 权限内容一致，已兼容识别';
  if (match === 'created') return '由 NEXUS 自动创建';
  return '不会猜测其他 OU，初始化时创建标准项';
}
