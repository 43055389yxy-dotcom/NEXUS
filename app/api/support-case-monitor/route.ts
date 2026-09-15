import { NextResponse } from 'next/server';
import { requireIdentity } from '../../auth';
import { proxyBroker } from '../../broker';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const identity = await requireIdentity(true);
    return NextResponse.json(await proxyBroker('/support-case-monitor', identity, { method: 'GET' }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取工单失败';
    return NextResponse.json({ error: message }, { status: message === 'FORBIDDEN' ? 403 : 500 });
  }
}

export async function POST(request: Request) {
  try {
    const identity = await requireIdentity(true);
    const body = await request.json();
    return NextResponse.json(await proxyBroker('/support-case-monitor', identity, { method: 'POST', body: JSON.stringify(body) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '操作失败';
    return NextResponse.json({ error: message }, { status: message === 'FORBIDDEN' ? 403 : 500 });
  }
}
