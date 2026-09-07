'use client';

import { useEffect, useRef } from 'react';
import styles from './billing-access-guide.module.css';

export function BillingAccessGuide({ account, onClose }: {
  account: { id: string; name: string };
  onClose: () => void;
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
      <h2 id="billing-access-guide-title" ref={headingRef} tabIndex={-1}>确认账单访问开关</h2>
      <p id="billing-access-guide-description">已开启可直接确认关闭；未开启或不确定，请按下面步骤操作。</p>
    </header>

    <div className={styles.account}>
      <div><strong>{account.name}</strong><code>{account.id}</code></div>
      <span>状态待确认</span>
    </div>
    <p className={styles.explanation}>AWS 未提供此开关的公开查询接口，这里不是自动检测结果，也不会替您修改 AWS 设置。</p>

    <ol className={styles.steps}>
      <li><b>1</b><div><strong>用此代付账号的 root 用户登录 AWS</strong><p>使用该账号的根用户邮箱登录，不是运维账号，也不是从本平台切换过去的 Role。</p></div></li>
      <li><b>2</b><div><strong>进入“账户”设置</strong><p>点击右上角账号名称，选择“账户（Account）”。先核对账号 ID 是 <code>{account.id}</code>。</p><a className={styles.link} href="https://console.aws.amazon.com/billing/home?#/account" target="_blank" rel="noopener noreferrer">打开 AWS 账户设置</a><small>链接会使用浏览器当前的 AWS 登录身份，请先完成第 1 步。</small></div></li>
      <li><b>3</b><div><strong>开启 IAM 用户和角色访问账单</strong><p>找到“IAM 用户和角色访问账单信息”，点击“编辑（Edit）”，勾选“激活 IAM 访问（Activate IAM Access）”，再点击“更新（Update）”。</p></div></li>
      <li><b>4</b><div><strong>回到本平台，重新打开 AWS 控制台</strong><p>重新进入这个账号，查看账单和费用是否能正常显示。</p></div></li>
    </ol>

    <div className={styles.note}>这个开关不授予最高管理员权限。登录角色仍需具备账单查看权限；如果已经开启但仍被拒绝，应检查角色权限，不能只反复开关。</div>
    <footer className={styles.footer}>
      <small>之后可从账号卡片菜单打开“账单访问教程”。“确认”仅代表您的手动确认，不是系统验证。</small>
      <div><button type="button" onClick={onClose}>稍后处理</button><button type="button" className={styles.primary} onClick={onClose}>我已确认开启</button></div>
    </footer>
  </dialog>;
}
