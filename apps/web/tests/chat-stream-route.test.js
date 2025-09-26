import { webcrypto as nodeWebcrypto } from 'crypto';
import { TextEncoder } from 'util';

const ensureCrypto = () => {
  if (!global.crypto) {
    Object.defineProperty(global, 'crypto', {
      configurable: true,
      value: nodeWebcrypto
    });
  }
  return global.crypto;
};

describe('app/api/llm/chat_stream route handlers', () => {
  const loadModule = async () => {
    jest.resetModules();
    return import('../app/api/llm/chat_stream/route.js');
  };

  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (global.fetch !== originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('rejects non-object payloads on POST', async () => {
    const mod = await loadModule();
    const req = new Request('http://example.com/api/llm/chat_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"hello"'
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid payload');
  });

  it('requires id query param on GET', async () => {
    const mod = await loadModule();
    const req = new Request('http://example.com/api/llm/chat_stream');
    const res = await mod.GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing id');
  });

  it('responds with 410 for unknown session ids', async () => {
    const mod = await loadModule();
    const req = new Request('http://example.com/api/llm/chat_stream?id=missing');
    const res = await mod.GET(req);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe('expired');
  });

  it('proxies stored payloads to the llm service via streaming', async () => {
    const mod = await loadModule();
    const cryptoObj = ensureCrypto();
    const uuidSpy = jest.spyOn(cryptoObj, 'randomUUID').mockReturnValue('session-123');
    const postReq = new Request('http://example.com/api/llm/chat_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    const postRes = await mod.POST(postReq);
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody).toEqual({ id: 'session-123' });
    uuidSpy.mockRestore();

    const encoder = new TextEncoder();
    const upstreamStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta":"Hello"}\n\n'));
        controller.close();
      }
    });

    global.fetch = jest.fn(async (url, options) => {
      expect(url).toBe('http://llm-service:4007/chat_sse');
      expect(options?.method).toBe('POST');
      const body = JSON.parse(options?.body);
      expect(body.messages[0].content).toBe('hi');
      return new Response(upstreamStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    });

    const getReq = new Request('http://example.com/api/llm/chat_stream?id=session-123');
    const getRes = await mod.GET(getReq);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await getRes.text();
    expect(text).toContain('"delta":"Hello"');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const replay = await mod.GET(getReq);
    expect(replay.status).toBe(410);
  });
});
