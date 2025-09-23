import { NextResponse } from 'next/server';

const STREAM_SESSIONS = new Map();
const SESSION_TTL_MS = 60_000;
const LLM_SERVICE_BASE = process.env.LLM_SERVICE_BASE || 'http://llm-service:4007';

function scheduleCleanup(id) {
  setTimeout(() => {
    STREAM_SESSIONS.delete(id);
  }, SESSION_TTL_MS).unref?.();
}

export async function POST(request) {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== 'object') {
      return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
    }
    const id = crypto.randomUUID();
    STREAM_SESSIONS.set(id, { payload, createdAt: Date.now() });
    scheduleCleanup(id);
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json({ error: err?.message || 'stream init failed' }, { status: 400 });
  }
}

export async function GET(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'missing id' }, { status: 400 });
  }
  const session = STREAM_SESSIONS.get(id);
  STREAM_SESSIONS.delete(id);
  if (!session) {
    return NextResponse.json({ error: 'expired' }, { status: 410 });
  }
  try {
    const upstream = await fetch(`${LLM_SERVICE_BASE}/chat_sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(session.payload)
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return NextResponse.json({ error: text || 'stream unavailable' }, { status: upstream.status || 502 });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        } catch (err) {
          console.error('[chat_stream] proxy error', err);
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: 'stream interrupted' })}\n\n`));
        } finally {
          controller.close();
        }
      }
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err?.message || 'stream failed' }, { status: 500 });
  }
}

