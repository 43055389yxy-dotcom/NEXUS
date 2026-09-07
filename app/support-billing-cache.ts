type SnapshotMetadata = {
  lastScanAt: string;
  months: { current: string; previous: string };
  historyMonth?: string;
  accounts: unknown[];
};

export type CachedBillingSnapshot<T> = { snapshot: T; preview?: boolean };
type RequestSnapshot<T> = (body: { action: 'snapshot' | 'scan'; accountId: string; period?: string }) => Promise<{ snapshot?: T; preview?: boolean }>;
const CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export function snapshotIsFresh(snapshot: SnapshotMetadata, now = Date.now(), historyMonth?: string) {
  const age = now - Date.parse(snapshot.lastScanAt);
  if (!Number.isFinite(age) || age < 0 || age >= CACHE_TTL_MS) return false;
  if (historyMonth) return snapshot.historyMonth === historyMonth;
  if (snapshot.historyMonth) return false;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(new Date(now));
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const current = `${year}-${String(month).padStart(2, '0')}`;
  const previous = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
  return snapshot.months.current === current && snapshot.months.previous === previous;
}

function validSnapshot(value: unknown): value is SnapshotMetadata {
  if (!value || typeof value !== 'object') return false;
  const item = value as SnapshotMetadata;
  if (item.historyMonth !== undefined && (typeof item.historyMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.historyMonth))) return false;
  return typeof item.lastScanAt === 'string' && typeof item.months?.current === 'string' && typeof item.months?.previous === 'string' && Array.isArray(item.accounts) && item.accounts.every((account) => {
    const member = account as { id?: unknown; current?: { status?: unknown }; previous?: { status?: unknown }; historical?: { status?: unknown } } | null;
    return member && typeof member.id === 'string' && typeof member.current?.status === 'string' && typeof member.previous?.status === 'string' && (!item.historyMonth || typeof member.historical?.status === 'string');
  });
}

export class SupportBillingCache<T extends SnapshotMetadata> {
  private entries = new Map<string, CachedBillingSnapshot<T>>();
  private pending = new Map<string, Promise<CachedBillingSnapshot<T>>>();
  private failures = new Map<string, { until: number; error: Error }>();

  constructor(
    readonly scope: string,
    private request: RequestSnapshot<T>,
    private onStored?: (accountId: string, value: CachedBillingSnapshot<T>, historyMonth?: string) => void,
  ) {}

  private key(accountId: string) { return `nexus:support-billing:v2:${encodeURIComponent(this.scope)}:${accountId}`; }
  private entryKey(accountId: string, historyMonth?: string) { return historyMonth ? `${accountId}:${historyMonth}` : accountId; }

  get(accountId: string, historyMonth?: string) {
    const id = this.entryKey(accountId, historyMonth);
    const existing = this.entries.get(id);
    if (existing) return existing;
    try {
      const raw = sessionStorage.getItem(this.key(id));
      if (!raw) return undefined;
      const value = JSON.parse(raw) as CachedBillingSnapshot<T>;
      if (validSnapshot(value?.snapshot) && value.snapshot.historyMonth === historyMonth && Date.now() - Date.parse(value.snapshot.lastScanAt) < CACHE_TTL_MS) {
        this.entries.set(id, value);
        return value;
      }
      sessionStorage.removeItem(this.key(id));
    } catch { /* Storage can be unavailable; the in-memory cache still works. */ }
    return undefined;
  }

  put(accountId: string, value: CachedBillingSnapshot<T>, historyMonth?: string) {
    if (!validSnapshot(value.snapshot) || value.snapshot.historyMonth !== historyMonth || !Number.isFinite(Date.parse(value.snapshot.lastScanAt))) return;
    const id = this.entryKey(accountId, historyMonth);
    this.entries.set(id, value);
    this.failures.delete(id);
    try { sessionStorage.setItem(this.key(id), JSON.stringify(value)); }
    catch { /* A full browser cache must not fail an AWS operation. */ }
    this.onStored?.(accountId, value, historyMonth);
  }

  isLoading(accountId: string, historyMonth?: string) { return this.pending.has(this.entryKey(accountId, historyMonth)); }

  load(accountId: string, force = false, historyMonth?: string): Promise<CachedBillingSnapshot<T>> {
    const id = this.entryKey(accountId, historyMonth);
    const pending = this.pending.get(id);
    if (pending) return pending;
    const cached = this.get(accountId, historyMonth);
    if (!force && cached && snapshotIsFresh(cached.snapshot, Date.now(), historyMonth)) return Promise.resolve(cached);
    const failure = this.failures.get(id);
    if (!force && failure && failure.until > Date.now()) return Promise.reject(failure.error);

    const task = Promise.resolve().then(async () => {
      if (!force) {
        const saved = await this.request({ action: 'snapshot', accountId, ...(historyMonth ? { period: historyMonth } : {}) });
        if (saved.snapshot && validSnapshot(saved.snapshot) && saved.snapshot.historyMonth === historyMonth) {
          const value = { snapshot: saved.snapshot, preview: Boolean(saved.preview) };
          this.put(accountId, value, historyMonth);
          if (snapshotIsFresh(value.snapshot, Date.now(), historyMonth)) return value;
        }
      }
      const scanned = await this.request({ action: 'scan', accountId, ...(historyMonth ? { period: historyMonth } : {}) });
      if (!scanned.snapshot || !validSnapshot(scanned.snapshot) || scanned.snapshot.historyMonth !== historyMonth || !Number.isFinite(Date.parse(scanned.snapshot.lastScanAt))) throw new Error('扫描未返回所选月份的有效账单数据');
      const value = { snapshot: scanned.snapshot, preview: Boolean(scanned.preview) };
      this.put(accountId, value, historyMonth);
      return value;
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error : new Error('读取账单失败');
      this.failures.set(id, { until: Date.now() + 60_000, error: reason });
      throw reason;
    }).finally(() => { this.pending.delete(id); });
    this.pending.set(id, task);
    return task;
  }
}
