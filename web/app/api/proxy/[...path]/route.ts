import { NextRequest, NextResponse } from 'next/server';

const SERVER = process.env.WA_SERVER_URL || 'http://localhost:10001';

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = `${SERVER}/api/${path.join('/')}`;

  const init: RequestInit = {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const text = await req.text();
    if (text) init.body = text;
  }

  try {
    const res = await fetch(url, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json({ error: 'Server unreachable' }, { status: 503 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
