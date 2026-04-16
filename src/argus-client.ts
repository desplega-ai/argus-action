import {
  ArgusApiError,
  ArgusRunOutcomeResponse,
  InsufficientCreditsError,
  RunArgusRequest,
  RunArgusResponse,
} from './types.js';

export type StartRunArgs = {
  argusBaseUrl: string;
  apiKey: string;
  body: RunArgusRequest;
};

export async function startRun(args: StartRunArgs): Promise<RunArgusResponse> {
  const { argusBaseUrl, apiKey, body } = args;
  const url = `${trimTrailingSlash(argusBaseUrl)}/api/v1/argus/run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (res.status === 402) {
    throw new InsufficientCreditsError(text);
  }
  if (!res.ok) {
    throw new ArgusApiError(res.status, text, url);
  }
  return JSON.parse(text) as RunArgusResponse;
}

export type SseEvent = { event: string; data: string };

export type StreamEventsArgs = {
  argusBaseUrl: string;
  apiKey: string;
  streamUrl: string;
  onEvent: (evt: SseEvent) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type StreamEventsResult = { sawAgentEnd: boolean };

const STREAM_409_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function streamEvents(args: StreamEventsArgs): Promise<StreamEventsResult> {
  const { argusBaseUrl, apiKey, streamUrl, onEvent } = args;
  const sleep = args.sleep ?? defaultSleep;
  const absoluteUrl = streamUrl.startsWith('http')
    ? streamUrl
    : `${trimTrailingSlash(argusBaseUrl)}${streamUrl.startsWith('/') ? '' : '/'}${streamUrl}`;

  let response: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(absoluteUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' },
    });
    if (r.status === 409) {
      if (attempt >= STREAM_409_BACKOFF_MS.length) {
        return { sawAgentEnd: false };
      }
      await sleep(STREAM_409_BACKOFF_MS[attempt]);
      continue;
    }
    if (!r.ok) {
      throw new ArgusApiError(r.status, await r.text(), absoluteUrl);
    }
    response = r;
    break;
  }

  if (!response?.body) {
    return { sawAgentEnd: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawAgentEnd = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex: number;
      while ((sepIndex = findFrameEnd(buffer)) !== -1) {
        const frame = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex).replace(/^(\r?\n){1,2}/, '');
        const evt = parseSseFrame(frame);
        if (evt) {
          onEvent(evt);
          if (evt.event === 'agent_end') {
            sawAgentEnd = true;
            try {
              await reader.cancel();
            } catch {
              // intentionally ignored: cancel races end-of-stream
            }
            return { sawAgentEnd };
          }
        }
      }
    }
    if (buffer.trim().length > 0) {
      const evt = parseSseFrame(buffer);
      if (evt) {
        onEvent(evt);
        if (evt.event === 'agent_end') sawAgentEnd = true;
      }
    }
  } catch {
    // Mid-stream disconnect — fall through.
  }

  return { sawAgentEnd };
}

function findFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

export function parseSseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine;
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && event === 'message') return null;
  return { event, data: dataLines.join('\n') };
}

export type PollOutcomeArgs = {
  argusBaseUrl: string;
  apiKey: string;
  sessionId: string;
  deadlineMs: number;
  sleep?: (ms: number) => Promise<void>;
};

export async function pollOutcome(args: PollOutcomeArgs): Promise<ArgusRunOutcomeResponse> {
  const { argusBaseUrl, apiKey, sessionId, deadlineMs } = args;
  const sleep = args.sleep ?? defaultSleep;
  const url = `${trimTrailingSlash(argusBaseUrl)}/api/v1/argus/sessions/${sessionId}`;
  let lastError: unknown = null;

  while (true) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.status >= 500) {
        lastError = new ArgusApiError(res.status, await res.text(), url);
      } else if (!res.ok) {
        throw new ArgusApiError(res.status, await res.text(), url);
      } else {
        const outcome = (await res.json()) as ArgusRunOutcomeResponse;
        if (outcome.status && outcome.status !== 'running') {
          return outcome;
        }
      }
    } catch (err) {
      if (err instanceof ArgusApiError && err.status < 500) throw err;
      lastError = err;
    }

    if (Date.now() >= deadlineMs) {
      if (lastError instanceof Error) {
        throw new Error(`pollOutcome deadline exceeded: ${lastError.message}`);
      }
      throw new Error('pollOutcome deadline exceeded while status remained "running"');
    }
    await sleep(1000);
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
