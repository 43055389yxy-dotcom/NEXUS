'use client';

import { useEffect, useState } from 'react';
import styles from './mfa-recovery.module.css';

export type RecoveryMember = { accountId: string; name: string; email: string };
type RootStatus = { passwordPresent: boolean; accessKeys: Array<{ accessKeyId: string }>; signingCertificates: Array<{ certificateId: string }>; mfaDevices: Array<{ serialNumber: string }> };
type Preflight = { organization: { managementAccountId: string }; target?: { accountId: string; name: string; state: string }; rootAccess: { trustedAccessEnabled: boolean; rootSessionsEnabled: boolean; rootCredentialsManagementEnabled: boolean } };
type Mode = 'setup' | 'login' | 'complete' | null;

export function MfaRecoveryPanel({ payerAccountId, member, disabled, autoCheck, onAutoCheckComplete, onNotice }: { payerAccountId: string; member: RecoveryMember | null; disabled: boolean; autoCheck: boolean; onAutoCheckComplete: () => void; onNotice: (message: string) => void }) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [rootStatus, setRootStatus] = useState<RootStatus | null>(null);
  const [changes, setChanges] = useState<string[]>([]);

  async function request(body: Record<string, unknown>) {
    const response = await fetch('/api/mfa-recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? '账号恢复操作失败');
    return payload;
  }

  function rootReady(value: Preflight) {
    return value.rootAccess.trustedAccessEnabled && value.rootAccess.rootSessionsEnabled && value.rootAccess.rootCredentialsManagementEnabled;
  }

  async function checkPayer(showReady = false) {
    setBusy(true); setError('');
    try {
      const payload = await request({ action: 'organization-status', payerAccountId }) as { preflight?: Preflight };
      if (!payload.preflight) throw new Error('未返回集中式根访问状态');
      setPreflight(payload.preflight);
      if (!rootReady(payload.preflight)) setMode('setup');
      else if (showReady) onNotice('账号恢复功能已就绪');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '集中式根访问检测失败'); setMode('setup');
    } finally { setBusy(false); onAutoCheckComplete(); }
  }

  useEffect(() => {
    if (!autoCheck || !payerAccountId) return;
    const timer = window.setTimeout(() => void checkPayer(false), 0);
    return () => window.clearTimeout(timer);
    // This onboarding check is cleared by the parent after one run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck, payerAccountId]);

  async function openAction() {
    if (!member) return;
    setMode('login'); setBusy(true); setError(''); setChanges([]); setRootStatus(null);
    try {
      const payload = await request({ action: 'preflight', payerAccountId, memberAccountId: member.accountId }) as { preflight?: Preflight };
      if (!payload.preflight) throw new Error('未返回账号检查结果');
      setPreflight(payload.preflight);
      if (!rootReady(payload.preflight)) { setMode('setup'); return; }
        const statusPayload = await request({ action: 'root-status', payerAccountId, memberAccountId: member.accountId }) as { status?: RootStatus };
        if (!statusPayload.status) throw new Error('未返回根凭证状态');
        setRootStatus(statusPayload.status);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '账号检查失败'); }
    finally { setBusy(false); }
  }

  async function recoverLogin() {
    if (!member) return;
    setBusy(true); setError('');
    try {
      const deleted = await request({ action: 'root-delete', payerAccountId, memberAccountId: member.accountId, confirmationAccountId: member.accountId }) as { changes?: string[] };
      const recovered = await request({ action: 'root-recover', payerAccountId, memberAccountId: member.accountId }) as { changes?: string[] };
      setChanges([...(deleted.changes ?? []), ...(recovered.changes ?? [])]); setMode('complete'); onNotice(`${member.accountId} 登录恢复已完成`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '登录恢复失败'); }
    finally { setBusy(false); }
  }

  return <>
    <div className={styles.actions}><span>{member ? `${member.name} · ${member.accountId}` : '选择一个成员账号'}</span><button disabled={disabled || !member} onClick={() => void openAction()}>登录恢复</button></div>
    {mode && <div className={styles.layer}><section className={styles.dialog} role="dialog" aria-modal="true"><button className={styles.close} disabled={busy} onClick={() => setMode(null)}>×</button>
      {mode === 'setup' && <><span>ROOT ACCESS</span><h3>启用集中式根访问</h3><p>请在当前代付账号的 AWS 控制台完成一次设置。</p><div className={styles.status}><i data-ready={preflight?.rootAccess.trustedAccessEnabled}>IAM 可信访问</i><i data-ready={preflight?.rootAccess.rootCredentialsManagementEnabled}>根凭证管理</i><i data-ready={preflight?.rootAccess.rootSessionsEnabled}>成员账号特权操作</i></div><ol><li>打开 IAM → 根访问权限管理。</li><li>点击“启用”。</li><li>同时开启“根凭证管理”和“成员账号特权根操作”。</li></ol>{error && <em>{error}</em>}<footer><button disabled={busy} onClick={() => setMode(null)}>关闭</button><button className={styles.primary} disabled={busy} onClick={() => void checkPayer(true)}>{busy ? '检测中...' : '重新检测'}</button></footer></>}
      {mode === 'login' && <><span>LOGIN RECOVERY</span><h3>{member?.name}</h3><p>{member?.accountId}</p>{busy && !rootStatus ? <div className={styles.loading}>正在扫描根凭证...</div> : rootStatus && <div className={styles.credentialGrid}><div><b>{rootStatus.passwordPresent ? '1' : '0'}</b><small>根密码</small></div><div><b>{rootStatus.mfaDevices.length}</b><small>MFA</small></div><div><b>{rootStatus.accessKeys.length}</b><small>根 AK/SK</small></div><div><b>{rootStatus.signingCertificates.length}</b><small>签名证书</small></div></div>}<p className={styles.warning}>将按原恢复流程清除以上根凭证，然后开放密码重置。IAM 用户和角色不受影响。</p>{error && <em>{error}</em>}<footer><button disabled={busy} onClick={() => setMode(null)}>取消</button><button className={styles.danger} disabled={busy || !rootStatus} onClick={() => void recoverLogin()}>{busy ? '处理中...' : '确认恢复'}</button></footer></>}
      {mode === 'complete' && <><span>COMPLETED</span><h3>操作完成</h3><div className={styles.changes}>{changes.map((change) => <p key={change}>{change}</p>)}</div><footer><button className={styles.primary} onClick={() => setMode(null)}>完成</button></footer></>}
    </section></div>}
  </>;
}
