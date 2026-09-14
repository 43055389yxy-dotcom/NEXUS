import { proxyBroker, requireIdentity } from '../broker';

export async function GET() {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  return proxyBroker('/apn-monitor', { method: 'GET' }, user);
}

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  let body: unknown = { action: 'refresh' };
  try { body = await request.json(); } catch {}
  return proxyBroker('/apn-monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, user);
}
