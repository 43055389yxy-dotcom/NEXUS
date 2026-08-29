'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { type CloudAccount } from './accounts';

type AccountRecord = { accountId: string; remark?: string; name?: string; region: string; groupId?: string };
type GroupRecord = { groupId: string; name: string };
type ManagedAccount = CloudAccount & { groupId: string };
type NewAccount = { remark: string; accountId: string; region: string; groupId: string };
type PermissionUser = { userId: string; userName: string; role: string; groupIds: string[] };
const OPS_ACCOUNT_ID = '590184009438';
const regions = ['us-east-1', 'us-west-2', 'ap-southeast-1', 'ap-northeast-1', 'eu-west-1'];

export function CloudAccessDashboard({ userName, userRole }: { userName: string; userRole: 'super_admin' | 'admin' | 'user' }) {
  const isAdmin = userRole === 'super_admin' || userRole === 'admin';
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [activeMenu, setActiveMenu] = useState('');
  const [editing, setEditing] = useState<ManagedAccount | null>(null);
  const [deleting, setDeleting] = useState<ManagedAccount | null>(null);
  const [editForm, setEditForm] = useState({ remark: '', region: 'us-east-1', groupId: '' });
  const [groupName, setGroupName] = useState('');
  const [connecting, setConnecting] = useState<ManagedAccount | null>(null);
  const [launching, setLaunching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState('');
  const [showPermissions, setShowPermissions] = useState(false);
  const [permissionUsers, setPermissionUsers] = useState<PermissionUser[]>([]);
  const [permissionQuery, setPermissionQuery] = useState('');
  const [dirtyPermissionUsers, setDirtyPermissionUsers] = useState<string[]>([]);

  useEffect(() => {
    if (!activeMenu) return;

    const closeMenu = () => setActiveMenu('');
    window.addEventListener('mousedown', closeMenu);
    return () => window.removeEventListener('mousedown', closeMenu);
  }, [activeMenu]);
  const [notice, setNotice] = useState('');
  const [newAccount, setNewAccount] = useState<NewAccount>({ remark: '', accountId: '', region: 'us-east-1', groupId: '' });
  const searchRef = useRef<HTMLInputElement>(null);

  async function loadData() {
    setLoading(true);
    setLoadError('');
    try {
      const [accountsResponse, groupsResponse] = await Promise.all([
        fetch('/api/accounts', { cache: 'no-store' }),
        fetch('/api/groups', { cache: 'no-store' }),
      ]);
      const accountsPayload = await accountsResponse.json() as { accounts?: AccountRecord[]; error?: string };
      const groupsPayload = await groupsResponse.json() as { groups?: GroupRecord[]; error?: string };
      if (!accountsResponse.ok) throw new Error(accountsPayload.error ?? '账号读取失败');
      if (!groupsResponse.ok) throw new Error(groupsPayload.error ?? '分组读取失败');
      setAccounts((accountsPayload.accounts ?? []).map(toManagedAccount));
      setGroups(groupsPayload.groups ?? []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '数据读取失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadData(); }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '/' && !isTypingTarget(event.target)) { event.preventDefault(); searchRef.current?.focus(); }
      if (isAdmin && event.key.toLowerCase() === 'n' && !isTypingTarget(event.target)) { event.preventDefault(); setShowAdd(true); }
      if (event.key === 'Escape') { setShowAdd(false); setShowAddGroup(false); setShowPermissions(false); setEditing(null); setDeleting(null); setActiveMenu(''); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isAdmin]);

  async function openPermissions() {
    setShowPermissions(true);
    setSaving(true);
    try {
      const response = await fetch('/api/permissions', { cache: 'no-store' });
      const payload = await response.json() as { users?: PermissionUser[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? '权限读取失败');
      const users = payload.users ?? [];
      setPermissionUsers(users);
      setDirtyPermissionUsers([]);
    } catch (error) { setNotice(error instanceof Error ? error.message : '权限读取失败'); }
    finally { setSaving(false); }
  }

  function updateUserGroups(userId: string, nextGroupIds: string[]) {
    setPermissionUsers((current) => current.map((item) => item.userId === userId ? { ...item, groupIds: nextGroupIds } : item));
    setDirtyPermissionUsers((current) => current.includes(userId) ? current : [...current, userId]);
  }

  async function saveUserPermissions() {
    const targets = permissionUsers.filter((item) => dirtyPermissionUsers.includes(item.userId));
    if (targets.length === 0) return;
    setSaving(true);
    try {
      const responses = await Promise.all(targets.map((target) => fetch('/api/permissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: target.userId, userName: target.userName, groupIds: target.groupIds }) })));
      const failed = responses.find((response) => !response.ok);
      if (failed) { const payload = await failed.json() as { error?: string }; throw new Error(payload.error ?? '权限保存失败'); }
      setDirtyPermissionUsers([]);
      setNotice('分组权限已保存');
    } catch (error) { setNotice(error instanceof Error ? error.message : '权限保存失败'); }
    finally { setSaving(false); }
  }

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const visibleAccounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return accounts
      .filter((account) => !needle || [account.name, account.id, account.region].some((value) => String(value ?? '').toLowerCase().includes(needle)))
      .filter((account) => selectedGroup === 'all' || (selectedGroup === 'ungrouped' ? !account.groupId : account.groupId === selectedGroup))
      .sort((a, b) => String(a.name ?? a.id ?? '').localeCompare(String(b.name ?? b.id ?? ''), 'zh-CN'));
  }, [accounts, query, selectedGroup]);

  const provisionCommand = useMemo(() => buildProvisionCommand(), []);

  async function copyText(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1500);
  }

  async function addGroup(event: FormEvent) {
    event.preventDefault();
    const name = groupName.trim();
    if (!name) return;
    if (groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) { setNotice('分组已存在'); return; }
    setSaving(true);
    try {
      const response = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const payload = await response.json() as { group?: GroupRecord; error?: string };
      if (!response.ok || !payload.group) throw new Error(payload.error ?? '创建失败');
      setGroups((current) => [...current, payload.group as GroupRecord].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-CN')));
      setSelectedGroup(payload.group.groupId);
      setGroupName('');
      setShowAddGroup(false);
      setNotice(`${name} 已创建`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建失败');
    } finally { setSaving(false); }
  }

  async function addAccount(event: FormEvent) {
    event.preventDefault();
    const remark = newAccount.remark.trim();
    const accountId = newAccount.accountId.trim();
    if (!remark || !/^\d{12}$/.test(accountId)) { setNotice('请检查备注和代付账号 ID'); return; }
    if (accounts.some((account) => account.id === accountId)) { setNotice('该账号已经存在'); return; }
    setSaving(true);
    try {
      const response = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...newAccount, remark, accountId }) });
      const payload = await response.json() as { account?: AccountRecord; error?: string };
      if (!response.ok || !payload.account) throw new Error(payload.error ?? '保存失败');
      setAccounts((current) => [...current, toManagedAccount(payload.account as AccountRecord)]);
      setShowAdd(false);
      setNewAccount({ remark: '', accountId: '', region: 'us-east-1', groupId: selectedGroup !== 'all' && selectedGroup !== 'ungrouped' ? selectedGroup : '' });
      setNotice(`${remark} 已添加`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally { setSaving(false); }
  }

  async function changeGroup(accountId: string, groupId: string) {
    const previous = accounts;
    setAccounts((current) => current.map((account) => account.id === accountId ? { ...account, groupId } : account));
    try {
      const response = await fetch('/api/accounts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, groupId }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? '移动失败');
      setNotice('分组已更新');
    } catch (error) {
      setAccounts(previous);
      setNotice(error instanceof Error ? error.message : '移动失败');
    }
  }

  function openEdit(account: ManagedAccount) {
    setActiveMenu('');
    setEditing(account);
    setEditForm({ remark: account.name, region: account.region, groupId: account.groupId });
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !editForm.remark.trim()) return;
    setSaving(true);
    try {
      const response = await fetch('/api/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: editing.id, remark: editForm.remark.trim(), region: editForm.region, groupId: editForm.groupId }),
      });
      const payload = await response.json() as { account?: AccountRecord; error?: string };
      if (!response.ok || !payload.account) throw new Error(payload.error ?? '保存失败');
      const updated = toManagedAccount(payload.account);
      setAccounts((current) => current.map((account) => account.id === updated.id ? updated : account));
      setEditing(null);
      setNotice('已保存');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally { setSaving(false); }
  }

  async function removeAccount() {
    if (!deleting) return;
    setSaving(true);
    try {
      const response = await fetch('/api/accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: deleting.id }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? '删除失败');
      setAccounts((current) => current.filter((account) => account.id !== deleting.id));
      setDeleting(null);
      setNotice('已从平台移除');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败');
    } finally { setSaving(false); }
  }

  function launchConsole(account: ManagedAccount) {
    if (launching) return;
    setLaunching(true);
    setConnecting(account);
    const loginUrl = `/api/console-login?accountId=${encodeURIComponent(account.id)}&roleName=${encodeURIComponent(account.roleName)}`;
    const popup = window.open(loginUrl, '_blank');
    if (popup) popup.opener = null;
    else setNotice('浏览器阻止了新窗口，请允许弹窗');
    window.setTimeout(() => {
      setConnecting(null);
      setLaunching(false);
    }, 1200);
  }

  function groupCount(groupId: string) { return accounts.filter((account) => groupId === 'ungrouped' ? !account.groupId : account.groupId === groupId).length; }
  function groupNameFor(groupId: string) { return groups.find((group) => group.groupId === groupId)?.name ?? '未分组'; }

  return (
    <main className="console-shell">
      <header className="console-header">
        <a className="console-brand" href="#top"><span>N</span><strong>NEXUS</strong><small>AWS 账号管理</small></a>
        <div className="header-search"><span>⌕</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、账号 ID、区域" /><kbd>/</kbd></div>
        <div className="header-actions"><span className="current-user">{userName}</span><button className="icon-button" onClick={() => void loadData()} aria-label="刷新" title="刷新">↻</button>{isAdmin && <button className="permission-button" onClick={() => void openPermissions()}>权限设置</button>}{isAdmin && <button className="add-button" onClick={() => setShowAdd(true)}><span>+</span> 添加账号</button>}</div>
      </header>

      <div className="platform-layout" id="top">
        <aside className="group-sidebar">
          <div className="sidebar-title"><h2>账号分组</h2>{isAdmin && <button onClick={() => setShowAddGroup(true)} aria-label="添加分组">+</button>}</div>
          <nav className="group-list">
            <button className={selectedGroup === 'all' ? 'active' : ''} onClick={() => setSelectedGroup('all')}><span><i className="folder all" />全部账号</span><b>{accounts.length}</b></button>
            {groups.map((group) => <button key={group.groupId} className={selectedGroup === group.groupId ? 'active' : ''} onClick={() => setSelectedGroup(group.groupId)} onDragOver={(event) => { if (isAdmin) event.preventDefault(); }} onDrop={(event) => { if (!isAdmin) return; event.preventDefault(); const accountId = event.dataTransfer.getData('text/account-id'); if (accountId) void changeGroup(accountId, group.groupId); }}><span><i className="folder" />{group.name}</span><b>{groupCount(group.groupId)}</b></button>)}
            {(isAdmin || accounts.some((account) => !account.groupId)) && <button className={selectedGroup === 'ungrouped' ? 'active' : ''} onClick={() => setSelectedGroup('ungrouped')} onDragOver={(event) => { if (isAdmin) event.preventDefault(); }} onDrop={(event) => { if (!isAdmin) return; event.preventDefault(); const accountId = event.dataTransfer.getData('text/account-id'); if (accountId) void changeGroup(accountId, ''); }}><span><i className="folder empty" />未分组</span><b>{groupCount('ungrouped')}</b></button>}
          </nav>
          {isAdmin && <button className="sidebar-add" onClick={() => setShowAddGroup(true)}><span>＋</span>新建分组</button>}
        </aside>

        <section className="console-content">
          <div className="content-head">
            <div><h1>{selectedGroup === 'all' ? '全部账号' : selectedGroup === 'ungrouped' ? '未分组' : groupNameFor(selectedGroup)}</h1><span>{visibleAccounts.length}</span></div>
          </div>

          {loading && <div className="accounts-layout">{[0,1,2,3].map((item) => <div className="account-tile loading-tile" key={item} />)}</div>}
          {!loading && loadError && <div className="inline-state error"><span>!</span><strong>{loadError}</strong><button onClick={() => void loadData()}>重试</button></div>}
          {!loading && !loadError && (
            <div className="accounts-layout">
              {visibleAccounts.map((account, index) => (
                <article className="account-tile clickable note-only" key={account.id} style={{ animationDelay: `${index * 55}ms` }} onClick={() => launchConsole(account)} onKeyDown={(event) => { if (event.key === 'Enter') launchConsole(account); }} onDragStart={(event) => { if (!isAdmin) return; event.dataTransfer.setData('text/account-id', account.id); event.dataTransfer.effectAllowed = 'move'; }} draggable={isAdmin} role="button" tabIndex={0} aria-label={`进入 ${account.name} AWS 控制台`} title={isAdmin ? '点击进入 AWS，拖动可调整分组' : '点击进入 AWS'}>
                  <h2>{account.name}</h2>
                  {isAdmin && <button className="card-menu-button" onClick={(event) => { event.stopPropagation(); setActiveMenu((current) => current === account.id ? '' : account.id); }} onMouseDown={(event) => event.stopPropagation()} aria-label="账号操作">•••</button>}
                  {isAdmin && activeMenu === account.id && <div className="card-menu" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}><button onClick={() => openEdit(account)}>编辑备注</button><button className="danger" onClick={() => { setActiveMenu(''); setDeleting(account); }}>删除记录</button></div>}
                </article>
              ))}
            </div>
          )}
          {!loading && !loadError && visibleAccounts.length === 0 && accounts.length > 0 && <div className="inline-state"><span>⌕</span><strong>没有匹配账号</strong><button onClick={() => setQuery('')}>清除搜索</button></div>}
        </section>
      </div>

      {showAddGroup && <div className="dialog-layer" onMouseDown={(event) => event.target === event.currentTarget && setShowAddGroup(false)}><section className="group-dialog" role="dialog" aria-modal="true"><button className="dialog-close" onClick={() => setShowAddGroup(false)}>×</button><h2>新建分组</h2><form onSubmit={(event) => void addGroup(event)}><label><span>分组名称</span><input autoFocus value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="例如：新代付组" maxLength={50} /></label><div className="dialog-actions"><button type="button" className="cancel" onClick={() => setShowAddGroup(false)}>取消</button><button className="save" disabled={saving || !groupName.trim()}>{saving ? '创建中...' : '创建'}</button></div></form></section></div>}

      {showPermissions && <div className="dialog-layer" onMouseDown={(event) => event.target === event.currentTarget && setShowPermissions(false)}><section className="permission-dialog" role="dialog" aria-modal="true"><button className="dialog-close" onClick={() => setShowPermissions(false)}>×</button><div className="permission-heading"><span>ACCESS CONTROL</span><h2>分组权限</h2><p>勾选用户可以查看和进入的账号分组</p></div><div className="permission-tools"><span>ITSM 用户 {permissionUsers.length}</span><input value={permissionQuery} onChange={(event) => setPermissionQuery(event.target.value)} placeholder="搜索用户" /></div>{permissionUsers.length === 0 ? <div className="permission-empty">ITSM 中暂无启用用户</div> : <div className="permission-matrix-scroll"><table className="permission-matrix"><thead><tr><th>用户</th><th>未分组</th>{groups.map((group) => <th key={group.groupId}>{group.name}</th>)}<th>快捷操作</th></tr></thead><tbody>{permissionUsers.filter((item) => !permissionQuery.trim() || item.userName.toLowerCase().includes(permissionQuery.trim().toLowerCase())).map((item) => { const isPrivileged = item.role === 'admin' || item.role === 'super_admin'; const allGroupIds = ['__ungrouped', ...groups.map((group) => group.groupId)]; const allSelected = isPrivileged || allGroupIds.every((groupId) => item.groupIds.includes(groupId)); return <tr key={item.userId} className={`${isPrivileged ? 'administrator' : ''} ${dirtyPermissionUsers.includes(item.userId) ? 'changed' : ''}`}><th><span>{item.userName.slice(0, 1).toUpperCase()}</span><div><strong>{item.userName}</strong><small>{isPrivileged ? (item.role === 'super_admin' ? '超级管理员 · 全部分组' : '管理员 · 全部分组') : `${item.groupIds.length} 个分组`}</small></div></th><td><input aria-label={`${item.userName} 未分组`} type="checkbox" disabled={isPrivileged} checked={isPrivileged || item.groupIds.includes('__ungrouped')} onChange={() => updateUserGroups(item.userId, item.groupIds.includes('__ungrouped') ? item.groupIds.filter((value) => value !== '__ungrouped') : [...item.groupIds, '__ungrouped'])} /></td>{groups.map((group) => <td key={group.groupId}><input aria-label={`${item.userName} ${group.name}`} type="checkbox" disabled={isPrivileged} checked={isPrivileged || item.groupIds.includes(group.groupId)} onChange={() => updateUserGroups(item.userId, item.groupIds.includes(group.groupId) ? item.groupIds.filter((value) => value !== group.groupId) : [...item.groupIds, group.groupId])} /></td>)}<td><button disabled={isPrivileged} onClick={() => updateUserGroups(item.userId, allSelected ? [] : allGroupIds)}>{isPrivileged ? '全部权限' : allSelected ? '清空' : '全部'}</button></td></tr>; })}</tbody></table></div>}<div className="permission-footer"><span>{dirtyPermissionUsers.length > 0 ? `${dirtyPermissionUsers.length} 位用户待保存` : '权限已同步'}</span><div><button className="cancel" onClick={() => setShowPermissions(false)}>关闭</button><button className="save" disabled={saving || dirtyPermissionUsers.length === 0} onClick={() => void saveUserPermissions()}>{saving ? '保存中...' : '保存权限'}</button></div></div></section></div>}

      {showAdd && (
        <div className="dialog-layer" onMouseDown={(event) => event.target === event.currentTarget && setShowAdd(false)}>
          <section className="account-dialog" role="dialog" aria-modal="true">
            <button className="dialog-close" onClick={() => setShowAdd(false)}>×</button>
            <div className="dialog-title"><h2>添加代付账号</h2><p>CloudShell 命令适用于所有代付账号</p></div>
            <form onSubmit={(event) => void addAccount(event)}>
              <div className="dialog-grid">
                <div className="account-form">
                  <label><span>备注</span><input autoFocus value={newAccount.remark} onChange={(event) => setNewAccount((current) => ({ ...current, remark: event.target.value }))} placeholder="例如：上海 CMA 主账号" maxLength={100} /></label>
                  <label><span>代付账号 ID</span><input value={newAccount.accountId} onChange={(event) => setNewAccount((current) => ({ ...current, accountId: event.target.value.replace(/\D/g, '').slice(0, 12) }))} placeholder="12 位账号 ID" inputMode="numeric" /></label>
                  <label><span>分组</span><select value={newAccount.groupId} onChange={(event) => setNewAccount((current) => ({ ...current, groupId: event.target.value }))}><option value="">未分组</option>{groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}</select></label>
                  <label><span>默认区域</span><select value={newAccount.region} onChange={(event) => setNewAccount((current) => ({ ...current, region: event.target.value }))}>{regions.map((item) => <option key={item}>{item}</option>)}</select></label>
                </div>
                <div className="command-panel ready">
                  <div className="billing-access-steps">
                    <strong>执行前检查</strong>
                    <ol>
                      <li><b>1</b><span>Root 登录代付账号</span></li>
                      <li><b>2</b><a href="https://console.aws.amazon.com/billing/home#/account" target="_blank" rel="noreferrer">打开 AWS 账户设置 ↗</a></li>
                      <li><b>3</b><span>开启「IAM 用户和角色访问账单信息」</span></li>
                    </ol>
                  </div>
                  <div className="command-toolbar"><strong>固定 CloudShell 命令</strong><button type="button" onClick={() => void copyText(provisionCommand, 'command')}>{copied === 'command' ? '已复制' : '复制'}</button></div>
                  <pre><code>{provisionCommand}</code></pre>
                </div>
              </div>
              <div className="dialog-actions"><button type="button" className="cancel" onClick={() => setShowAdd(false)}>取消</button><button className="save" disabled={saving || !/^\d{12}$/.test(newAccount.accountId) || !newAccount.remark.trim()}>{saving ? '保存中...' : '保存账号'}</button></div>
            </form>
          </section>
        </div>
      )}

      {editing && (
        <div className="dialog-layer" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}>
          <section className="edit-dialog" role="dialog" aria-modal="true">
            <button className="dialog-close" onClick={() => setEditing(null)}>×</button>
            <h2>编辑账号</h2>
            <p className="readonly-id">{formatAccountId(editing.id)}</p>
            <form onSubmit={(event) => void saveEdit(event)}>
              <label><span>备注</span><input autoFocus value={editForm.remark} onChange={(event) => setEditForm((current) => ({ ...current, remark: event.target.value }))} maxLength={100} /></label>
              <div className="edit-grid"><label><span>分组</span><select value={editForm.groupId} onChange={(event) => setEditForm((current) => ({ ...current, groupId: event.target.value }))}><option value="">未分组</option>{groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}</select></label><label><span>默认区域</span><select value={editForm.region} onChange={(event) => setEditForm((current) => ({ ...current, region: event.target.value }))}>{regions.map((item) => <option key={item}>{item}</option>)}</select></label></div>
              <div className="dialog-actions"><button type="button" className="cancel" onClick={() => setEditing(null)}>取消</button><button className="save" disabled={saving || !editForm.remark.trim()}>{saving ? '保存中...' : '保存'}</button></div>
            </form>
          </section>
        </div>
      )}

      {deleting && (
        <div className="dialog-layer" onMouseDown={(event) => event.target === event.currentTarget && setDeleting(null)}>
          <section className="delete-dialog" role="alertdialog" aria-modal="true">
            <span className="delete-icon">!</span><h2>删除 {deleting.name}？</h2><p>只会从本平台移除记录，不会删除 AWS 账号、Role 或云资源。</p>
            <div className="dialog-actions"><button className="cancel" onClick={() => setDeleting(null)}>取消</button><button className="delete-confirm" onClick={() => void removeAccount()} disabled={saving}>{saving ? '删除中...' : '删除记录'}</button></div>
          </section>
        </div>
      )}

      {connecting && <div className="connection-layer" role="status"><section className="connection-box"><div className="aws-spinner"><span>aws</span><i /><i /></div><h2>正在打开</h2><p>{connecting.name}</p><div className="progress-line"><i /></div></section></div>}
      {notice && <div className="notice"><span>✓</span>{notice}</div>}
    </main>
  );
}

function toManagedAccount(account: AccountRecord): ManagedAccount { const remark = account.remark ?? account.name ?? account.accountId; return { id:account.accountId,name:remark,organization:remark,region:account.region,groupId:account.groupId ?? '',roleName:'TontianOperationsRole',access:'admin',environment:'production',favorite:false,lastUsed:'' }; }
function formatAccountId(accountId:string){return accountId.replace(/(\d{4})(?=\d)/g,'$1 ')}
function isTypingTarget(target:EventTarget|null){return target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement}
function buildProvisionCommand(){return `set -e

export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

OPS_ACCOUNT_ID="${OPS_ACCOUNT_ID}"
CURRENT_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

if [ "$CURRENT_ACCOUNT_ID" = "$OPS_ACCOUNT_ID" ]; then echo "错误：不能在运维账号执行"; exit 1; fi

cat >/tmp/tontian-trust-policy.json <<EOF_POLICY
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::\${OPS_ACCOUNT_ID}:role/TontianConsoleBrokerRole"},"Action":"sts:AssumeRole"}]}
EOF_POLICY

for ROLE_NAME in TontianOperationsRole TontianAdminRole; do
  if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document file:///tmp/tontian-trust-policy.json
  else
    aws iam create-role --role-name "$ROLE_NAME" --max-session-duration 3600 --assume-role-policy-document file:///tmp/tontian-trust-policy.json
  fi
done

aws iam attach-role-policy --role-name TontianOperationsRole --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
aws iam attach-role-policy --role-name TontianOperationsRole --policy-arn arn:aws:iam::aws:policy/AWSBillingReadOnlyAccess
aws iam attach-role-policy --role-name TontianOperationsRole --policy-arn arn:aws:iam::aws:policy/AWSAccountManagementReadOnlyAccess
cat >/tmp/tontian-organization-operations.json <<'EOF_ORG'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"organizations:MoveAccount","Resource":"*"}]}
EOF_ORG
aws iam put-role-policy --role-name TontianOperationsRole --policy-name TontianOrganizationOperations --policy-document file:///tmp/tontian-organization-operations.json
aws iam attach-role-policy --role-name TontianAdminRole --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
echo "账号接入完成：$CURRENT_ACCOUNT_ID"`;}
