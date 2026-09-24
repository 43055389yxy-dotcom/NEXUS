import { proxyBroker, requireIdentity } from '../broker';

export async function GET() {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  return proxyBroker('/credit-monitor', { method: 'GET' }, user);
}

export async function POST(request: Request) {
  const { user, denied } = await requireIdentity(true);
  if (denied || !user) return denied;
  let body: unknown = {};
  try { body = await request.json(); } catch {}
  return proxyBroker('/credit-monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, user);
}
