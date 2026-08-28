'use client';

import { useEffect, useMemo, useState } from 'react';
import { cloudAccounts, type AccessLevel, type CloudAccount } from './accounts';

type Filter = 'all' | 'favorite' | AccessLevel;

const accessLabels: Record<AccessLevel, string> = {
  admin: '日常运维',
  billing: '账单只读',
  readonly: '安全审计',
};

const filterLabels: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部账号' },
  { key: 'favorite', label: '常用' },
  { key: 'admin', label: '日常运维' },
  { key: 'billing', label: '账单' },
  { key: 'readonly', label: '审计' },
];

export function CloudAccessDashboard({ userName, userEmail }: { userName: string; userEmail: string }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<CloudAccount | null>(null);
  const [favorites, setFavorites] = useState(() => new Set(
    cloudAccounts.filter((account) => account.favorite).map((account) => account.id),
  ));
  const [launching, setLaunching] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const visibleAccounts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return cloudAccounts.filter((account) => {
      const matchesSearch = !normalized || [
        account.name, account.id, account.organization, account.roleName, account.region,
      ].some((value) => value.toLowerCase().includes(normalized));
      const matchesFilter = filter === 'all'
        || (filter === 'favorite' && favorites.has(account.id))
        || account.access === filter;
      return matchesSearch && matchesFilter;
    });
  }, [favorites, filter, query]);

  function toggleFavorite(accountId: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  async function launchConsole() {
    if (!selected || launching) return;
    setLaunching(true);
    const popup = window.open('about:blank', '_blank');
    if (popup) {
      popup.document.title = '正在连接 AWS...';
      popup.document.body.innerHTML = '<p style="font:16px sans-serif;padding:32px">正在签发临时控制台会话...</p>';
    }

    try {
      const response = await fetch('/api/console-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selected.id,
          roleName: selected.roleName,
          destination: `https://${selected.region}.console.aws.amazon.com/console/home?region=${selected.region}`,
        }),
      });
      const payload = await response.json() as { url?: string; mode?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error ?? '无法生成控制台会话');
      if (popup) popup.location.href = payload.url;
      else window.location.href = payload.url;
      setSelected(null);
      setNotice(payload.mode === 'broker'
        ? '临时会话已签发，正在进入 AWS 控制台。'
        : '演示模式已打开 AWS 预填角色页面。');
    } catch (error) {
      popup?.close();
      setNotice(error instanceof Error ? error.message : '暂时无法打开 AWS 控制台');
    } finally {
      setLaunching(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="side-rail">
        <div className="brand-lockup">
          <div className="brand-mark"><span>N</span></div>
          <div><strong>NEXUS</strong><small>云访问控制台</small></div>
        </div>
        <nav className="side-nav" aria-label="主导航">
          <button className="nav-item active"><span>01</span>账号入口</button>
          <button className="nav-item"><span>02</span>访问记录</button>
          <button className="nav-item"><span>03</span>权限策略</button>
          <button className="nav-item"><span>04</span>平台设置</button>
        </nav>
        <div className="rail-status">
          <div className="status-heading"><i />身份代理</div>
          <strong>演示模式</strong>
          <p>接入内部 STS Broker 后启用一键直达。</p>
        </div>
        <div className="rail-user">
          <div className="avatar">{userName.slice(0, 1).toUpperCase()}</div>
          <div><strong>{userName}</strong><small>{userEmail}</small></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>运维平台</span><b>/</b>云账号访问</div>
          <div className="topbar-actions">
            <span className="security-chip"><i />安全会话正常</span>
            <button className="ghost-button">查看审计日志</button>
          </div>
        </header>

        <div className="content-wrap">
          <section className="hero-panel">
            <div className="hero-copy">
              <p className="eyebrow">CLOUD ACCESS BROKER</p>
              <h1>进入一个账号，<br />不必登录六十次。</h1>
              <p className="hero-note">从统一身份签发短期会话。账号之间保持独立，权限按管理员精确分配。</p>
            </div>
            <div className="hero-metrics">
              <div><span>已接入账号</span><strong>60</strong><small>60 个独立组织</small></div>
              <div><span>本月访问</span><strong>328</strong><small>全部留有审计</small></div>
              <div><span>异常事件</span><strong className="safe-number">0</strong><small>最近 30 天</small></div>
            </div>
          </section>

          <section className="permission-panel">
            <div className="permission-title">
              <div>
                <p className="section-kicker">PRIVILEGE DESIGN</p>
                <h2>权限不常驻，需要时再提升</h2>
              </div>
              <span>3 名管理员 · 3 层防线</span>
            </div>
            <div className="permission-cards">
              <article className="permission-card daily">
                <div className="tier-number">01</div>
                <div><strong>日常运维</strong><small>2 人长期持有</small></div>
                <p>查看资源与账单，执行批准的日常操作。禁止创建资源、IAM 变更和组织操作。</p>
                <span className="tier-state">常驻 · 低风险</span>
              </article>
              <article className="permission-card elevated">
                <div className="tier-number">02</div>
                <div><strong>组织操作</strong><small>按任务临时申请</small></div>
                <p>移动账号、调整组织结构等敏感动作，要求填写原因并由另一人审批。</p>
                <span className="tier-state">15 分钟 · 双人审批</span>
              </article>
              <article className="permission-card privileged">
                <div className="tier-number">03</div>
                <div><strong>特权管理员</strong><small>1 人有申请资格</small></div>
                <p>默认没有全权。二次验证后临时获得管理员会话，到期自动收回并触发审计通知。</p>
                <span className="tier-state">15 分钟 · 二次验证</span>
              </article>
            </div>
          </section>

          <section className="directory-panel">
            <div className="directory-heading">
              <div><p className="section-kicker">ACCOUNT DIRECTORY</p><h2>代付账号目录</h2></div>
              <div className="directory-meta"><span>{visibleAccounts.length}</span> 个可访问账号</div>
            </div>

            <div className="controls">
              <label className="search-box">
                <span>⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索客户、Account ID、角色或区域" aria-label="搜索账号" />
                <kbd>⌘ K</kbd>
              </label>
              <div className="filter-tabs" role="group" aria-label="账号筛选">
                {filterLabels.map((item) => (
                  <button key={item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="account-table">
              <div className="table-head">
                <span>客户与组织</span><span>Account ID</span><span>访问角色</span><span>主要区域</span><span>最近访问</span><span />
              </div>
              <div className="table-body">
                {visibleAccounts.map((account, index) => (
                  <article className="account-row" key={account.id} style={{ animationDelay: `${Math.min(index, 9) * 28}ms` }}>
                    <div className="account-identity">
                      <button className={`star-button ${favorites.has(account.id) ? 'favorite' : ''}`} onClick={() => toggleFavorite(account.id)} aria-label={favorites.has(account.id) ? '取消常用' : '设为常用'}>★</button>
                      <div className="account-monogram">{account.name.slice(0, 1)}</div>
                      <div><strong>{account.name}</strong><small>{account.organization}</small></div>
                    </div>
                    <code>{account.id}</code>
                    <div><span className={`role-badge ${account.access}`}>{accessLabels[account.access]}</span><small className="role-name">{account.roleName}</small></div>
                    <span className="region-label"><i />{account.region}</span>
                    <span className="last-used">{account.lastUsed}</span>
                    <button className="launch-button" onClick={() => setSelected(account)}>进入控制台 <span>↗</span></button>
                  </article>
                ))}
                {visibleAccounts.length === 0 && (
                  <div className="empty-state"><strong>没有匹配的账号</strong><p>换一个客户名称、账号 ID 或筛选条件试试。</p></div>
                )}
              </div>
            </div>
          </section>
        </div>
      </section>

      {selected && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setSelected(null);
        }}>
          <section className="launch-modal" role="dialog" aria-modal="true" aria-labelledby="launch-title">
            <button className="modal-close" onClick={() => setSelected(null)} aria-label="关闭">×</button>
            <p className="section-kicker">NEW AWS SESSION</p>
            <h2 id="launch-title">进入 {selected.name}</h2>
            <p className="modal-intro">平台将为你签发一个短期控制台会话。本次操作会记录到访问审计中。</p>
            <div className="target-card">
              <div className="account-monogram large">{selected.name.slice(0, 1)}</div>
              <div><strong>{selected.organization}</strong><code>{selected.id}</code></div>
              <span className={`role-badge ${selected.access}`}>{accessLabels[selected.access]}</span>
            </div>
            <dl className="session-grid">
              <div><dt>目标角色</dt><dd>{selected.roleName}</dd></div>
              <div><dt>会话有效期</dt><dd>60 分钟</dd></div>
              <div><dt>主要区域</dt><dd>{selected.region}</dd></div>
              <div><dt>操作身份</dt><dd>{userEmail}</dd></div>
            </dl>
            {selected.access === 'admin' && (
              <div className="risk-note"><span>!</span><p><strong>日常运维权限</strong>可操作既有资源，但资源创建、IAM 和组织变更会被策略拒绝。</p></div>
            )}
            <div className="modal-actions">
              <button className="cancel-button" onClick={() => setSelected(null)}>取消</button>
              <button className="confirm-button" onClick={launchConsole} disabled={launching}>
                {launching ? '正在签发会话…' : '确认并进入 AWS'}
              </button>
            </div>
          </section>
        </div>
      )}

      {notice && <div className="toast" role="status"><i />{notice}</div>}
    </main>
  );
}
