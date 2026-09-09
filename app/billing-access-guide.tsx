'use client';

import { useEffect, useRef } from 'react';
import styles from './billing-access-guide.module.css';

export function BillingAccessGuide({ account, busy, onClose, onComplete }: {
  account: { id: string; name: string };
  busy: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    headingRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return <dialog
    ref={dialogRef}
    className={styles.dialog}
    aria-labelledby="billing-access-guide-title"
    aria-describedby="billing-access-guide-description"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}
  >
    <header className={styles.header}>
      <span>BILLING ACCESS</span>
      <button type="button" className={styles.close} aria-label="关闭账单访问教程" onClick={onClose}>关闭</button>
      <h2 id="billing-access-guide-title" ref={headingRef} tabIndex={-1}>开启账单访问</h2>
      <p id="billing-access-guide-description">在 AWS 账户设置中完成下面两步。</p>
    </header>

    <div className={styles.account}>
      <div><strong>{account.name}</strong><code>{account.id}</code></div>
      <span>待开启</span>
    </div>

    <ol className={styles.steps}>
      <li><b>1</b><div><strong>用该代付账号的 root 用户登录</strong><p>打开右上角账号菜单 → 账户（Account）。</p><a className={styles.link} href="https://console.aws.amazon.com/billing/home?#/account" target="_blank" rel="noopener noreferrer">打开 AWS 账户设置</a></div></li>
      <li><b>2</b><div><strong>打开“IAM 用户和角色访问账单信息”</strong><p>点击编辑 → 勾选“激活 IAM 访问” → 更新。</p></div></li>
    </ol>

    <footer className={styles.footer}>
      <small>请确认当前 AWS 账号 ID 是 {account.id}。</small>
      <div><button type="button" disabled={busy} onClick={onClose}>稍后处理</button><button type="button" className={styles.primary} disabled={busy} onClick={onComplete}>{busy ? '记录中...' : '已完成'}</button></div>
    </footer>
  </dialog>;
}
