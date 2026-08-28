import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ status: 'ok', service: 'nexus' }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
