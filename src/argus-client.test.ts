import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  startRun,
  streamEvents,
  pollOutcome,
  parseSseFrame,
  isAgentEnd,
  innerType,
} from './argus-client.js';
import { ArgusApiError, InsufficientCreditsError } from './types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(fn: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(fn as typeof fetch);
}

function makeResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

describe('startRun', () => {
  it('returns parsed response on success', async () => {
    const payload = { session_id: 's1', poll_url: '/p', stream_url: '/s', instance_id: 'i1' };
    mockFetch(async () => makeResponse(200, JSON.stringify(payload)));
    const result = await startRun({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      body: { prompt: 'hi', wait: 'stream' },
    });
    expect(result.session_id).toBe('s1');
    expect(result.stream_url).toBe('/s');
  });

  it('throws InsufficientCreditsError on 402', async () => {
    mockFetch(async () => makeResponse(402, '{"error":"insufficient_credits"}'));
    await expect(
      startRun({
        argusBaseUrl: 'https://api.test',
        apiKey: 'key',
        body: { prompt: 'hi', wait: 'stream' },
      }),
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('throws ArgusApiError on 500', async () => {
    mockFetch(async () => makeResponse(500, 'Internal Server Error'));
    await expect(
      startRun({
        argusBaseUrl: 'https://api.test',
        apiKey: 'key',
        body: { prompt: 'hi', wait: 'stream' },
      }),
    ).rejects.toThrow(ArgusApiError);
  });
});

describe('innerType / isAgentEnd', () => {
  it('returns undefined for non-JSON data', () => {
    expect(innerType({ event: 'message', data: 'hello' })).toBeUndefined();
  });
  it('returns JSON type field', () => {
    expect(innerType({ event: 'message', data: '{"type":"tool_use"}' })).toBe('tool_use');
  });
  it('isAgentEnd matches top-level event', () => {
    expect(isAgentEnd({ event: 'agent_end', data: '' })).toBe(true);
  });
  it('isAgentEnd matches nested JSON type', () => {
    expect(isAgentEnd({ event: 'message', data: '{"type":"agent_end"}' })).toBe(true);
  });
  it('isAgentEnd false otherwise', () => {
    expect(isAgentEnd({ event: 'message', data: '{"type":"turn_end"}' })).toBe(false);
  });
});

describe('parseSseFrame', () => {
  it('parses a typical SSE frame', () => {
    const frame = 'event: step\ndata: {"message":"hello"}';
    const evt = parseSseFrame(frame);
    expect(evt).toEqual({ event: 'step', data: '{"message":"hello"}' });
  });

  it('defaults event to message', () => {
    const frame = 'data: hello';
    const evt = parseSseFrame(frame);
    expect(evt).toEqual({ event: 'message', data: 'hello' });
  });

  it('joins multi-line data', () => {
    const frame = 'data: line1\ndata: line2';
    const evt = parseSseFrame(frame);
    expect(evt?.data).toBe('line1\nline2');
  });

  it('returns null for comment-only frames', () => {
    expect(parseSseFrame(': comment\n: more')).toBeNull();
  });
});

describe('streamEvents', () => {
  const noopSleep = async () => {};

  function makeSseStream(frames: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frames));
        controller.close();
      },
    });
  }

  it('collects events and detects agent_end', async () => {
    const body = 'event: step\ndata: hi\n\nevent: agent_end\ndata: done\n\n';
    mockFetch(async () => new Response(makeSseStream(body), { status: 200 }));
    const events: Array<{ event: string; data: string }> = [];
    const result = await streamEvents({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      streamUrl: '/stream/s1',
      onEvent: (e) => events.push(e),
      sleep: noopSleep,
    });
    expect(result.sawAgentEnd).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('step');
    expect(events[1].event).toBe('agent_end');
  });

  it('detects agent_end packed inside a message-event JSON payload', async () => {
    const body =
      'event: message\ndata: {"type":"connected"}\n\nevent: message\ndata: {"type":"agent_end"}\n\n';
    mockFetch(async () => new Response(makeSseStream(body), { status: 200 }));
    const result = await streamEvents({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      streamUrl: '/stream/s1',
      onEvent: () => {},
      sleep: noopSleep,
    });
    expect(result.sawAgentEnd).toBe(true);
  });

  it('retries on 409 then succeeds', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      if (calls <= 2) return makeResponse(409, 'not ready');
      return new Response(makeSseStream('event: agent_end\ndata: ok\n\n'), { status: 200 });
    });
    const events: Array<{ event: string }> = [];
    const result = await streamEvents({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      streamUrl: '/stream/s1',
      onEvent: (e) => events.push(e),
      sleep: noopSleep,
    });
    expect(result.sawAgentEnd).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up after all 409 retries', async () => {
    mockFetch(async () => makeResponse(409, 'not ready'));
    const result = await streamEvents({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      streamUrl: '/stream/s1',
      onEvent: () => {},
      sleep: noopSleep,
    });
    expect(result.sawAgentEnd).toBe(false);
  });

  it('returns false when stream ends without agent_end', async () => {
    mockFetch(
      async () =>
        new Response(makeSseStream('event: step\ndata: hi\n\n'), { status: 200 }),
    );
    const result = await streamEvents({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      streamUrl: '/stream/s1',
      onEvent: () => {},
      sleep: noopSleep,
    });
    expect(result.sawAgentEnd).toBe(false);
  });
});

describe('pollOutcome', () => {
  const noopSleep = async () => {};

  it('returns on terminal status', async () => {
    const outcome = { session_id: 's1', status: 'completed', report_md: 'all good' };
    mockFetch(async () => makeResponse(200, JSON.stringify(outcome)));
    const result = await pollOutcome({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      sessionId: 's1',
      deadlineMs: Date.now() + 10_000,
      sleep: noopSleep,
    });
    expect(result.status).toBe('completed');
  });

  it('retries on 5xx then succeeds', async () => {
    let calls = 0;
    const outcome = { session_id: 's1', status: 'completed' };
    mockFetch(async () => {
      calls++;
      if (calls <= 2) return makeResponse(500, 'oops');
      return makeResponse(200, JSON.stringify(outcome));
    });
    const result = await pollOutcome({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      sessionId: 's1',
      deadlineMs: Date.now() + 10_000,
      sleep: noopSleep,
    });
    expect(result.status).toBe('completed');
    expect(calls).toBe(3);
  });

  it('retries on running status', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls++;
      if (calls <= 2) return makeResponse(200, JSON.stringify({ session_id: 's1', status: 'running' }));
      return makeResponse(200, JSON.stringify({ session_id: 's1', status: 'failed' }));
    });
    const result = await pollOutcome({
      argusBaseUrl: 'https://api.test',
      apiKey: 'key',
      sessionId: 's1',
      deadlineMs: Date.now() + 10_000,
      sleep: noopSleep,
    });
    expect(result.status).toBe('failed');
  });

  it('throws on deadline exceeded', async () => {
    mockFetch(async () => makeResponse(200, JSON.stringify({ session_id: 's1', status: 'running' })));
    await expect(
      pollOutcome({
        argusBaseUrl: 'https://api.test',
        apiKey: 'key',
        sessionId: 's1',
        deadlineMs: Date.now() - 1,
        sleep: noopSleep,
      }),
    ).rejects.toThrow(/deadline exceeded/);
  });

  it('throws on non-retryable 4xx', async () => {
    mockFetch(async () => makeResponse(404, 'not found'));
    await expect(
      pollOutcome({
        argusBaseUrl: 'https://api.test',
        apiKey: 'key',
        sessionId: 's1',
        deadlineMs: Date.now() + 10_000,
        sleep: noopSleep,
      }),
    ).rejects.toThrow(ArgusApiError);
  });
});
