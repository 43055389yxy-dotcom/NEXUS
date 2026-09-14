'use client';

import { useEffect, useState } from 'react';
import styles from './mfa-recovery.module.css';
import { CENTRALIZED_ROOT_ACCESS_SETUP_COMMAND } from './mfa-recovery-provision';

type Preflight = { rootAccess: { trustedAccessEnabled: boolean; rootSessionsEnabled: boolean; rootCredentialsManagementEnabled: boolean } };

export function MfaRecoveryPanel({ payerAccountId, autoCheck, onAutoCheckComplete, onNotice }: { payerAccountId: string; autoCheck: boolean; onAutoCheckComplete: () => void; onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preflight, setPreflight] = useState<Preflight | null>(null);

  async function request(body: Record<string, unknown>) {
    const response = await fetch('/api/mfa-recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? '账号恢复操作失败');
    return payload;
  }

  function rootReady(value: Preflight) {
    return value.rootAccess.trustedAccessEnabled && value.rootAccess.rootSessionsEnabled && value.rootAccess.rootCredentialsManagementEnabled;
  }

  async function copySetupCommand() {
    try {
      await navigator.clipboard.writeText(CENTRALIZED_ROOT_ACCESS_SETUP_COMMAND);
      onNotice('CloudShell 命令已复制');
    } catch {
      onNotice('复制失败，请手动选择命令');
    }
  }

  async function checkPayer(showReady = false) {
    setBusy(true); setError('');
    try {
      const payload = await request({ action: 'organization-status', payerAccountId }) as { preflight?: Preflight };
      if (!payload.preflight) throw new Error('未返回集中式根访问状态');
      setPreflight(payload.preflight);
      if (!rootReady(payload.preflight)) setOpen(true);
      else {
        setOpen(false);
        if (showReady) onNotice('集中式根访问已开启');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '集中式根访问检测失败'); setOpen(true);
    } finally { setBusy(false); onAutoCheckComplete(); }
  }

  useEffect(() => {
    if (!autoCheck || !payerAccountId) return;
    const timer = window.setTimeout(() => void checkPayer(false), 0);
    return () => window.clearTimeout(timer);
    // This onboarding check is cleared by the parent after one run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck, payerAccountId]);

  return open && <div className={styles.layer}><section className={styles.dialog} role="dialog" aria-modal="true"><button className={styles.close} disabled={busy} onClick={() => setOpen(false)}>×</button>
    <span>ROOT ACCESS</span><h3>启用集中式根访问</h3><p>在当前代付账号打开 CloudShell，复制并运行下面的命令。已开启的功能会自动跳过。</p><div className={styles.status}><i data-ready={preflight?.rootAccess.trustedAccessEnabled}>IAM 可信访问</i><i data-ready={preflight?.rootAccess.rootCredentialsManagementEnabled}>根凭证管理</i><i data-ready={preflight?.rootAccess.rootSessionsEnabled}>成员账号特权操作</i></div><div className={styles.command}><pre><code>{CENTRALIZED_ROOT_ACCESS_SETUP_COMMAND}</code></pre><button type="button" onClick={() => void copySetupCommand()}>复制 CloudShell 命令</button></div><p className={styles.hint}>执行完成后回到这里点击“重新检测”。</p>{error && <em>{error}</em>}<footer><button disabled={busy} onClick={() => setOpen(false)}>关闭</button><button className={styles.primary} disabled={busy} onClick={() => void checkPayer(true)}>{busy ? '检测中...' : '重新检测'}</button></footer>
  </section></div>;
}
