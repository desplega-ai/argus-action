import { innerType, type SseEvent } from './argus-client.js';

const MAX_PLAIN = 160;

export function formatEventLine(evt: SseEvent): string {
  const tagName = evt.event === 'message' ? (innerType(evt) ?? 'message') : evt.event;
  const tag = `[${tagName}]`;
  const summary = extractSummary(evt.data);
  return summary ? `${tag} ${summary}` : tag;
}

export function shouldGroup(evt: SseEvent): boolean {
  const t = evt.event === 'message' ? innerType(evt) : evt.event;
  return (
    t === 'tool_use' ||
    t === 'tool_result' ||
    t === 'tool_execution_start' ||
    t === 'tool_execution_update' ||
    t === 'tool_execution_end' ||
    t === 'toolcall_start' ||
    t === 'toolcall_delta' ||
    t === 'toolcall_end'
  );
}

function extractSummary(raw: string): string {
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw.length > MAX_PLAIN ? raw.slice(0, MAX_PLAIN) + '...' : raw;
  }
  if (!obj || typeof obj !== 'object') {
    return raw.length > MAX_PLAIN ? raw.slice(0, MAX_PLAIN) + '...' : raw;
  }

  const parts: string[] = [];
  for (const key of ['message', 'step', 'tool', 'url', 'status', 'name'] as const) {
    if (typeof obj[key] === 'string' || typeof obj[key] === 'number') {
      parts.push(`${key}=${obj[key]}`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : raw.slice(0, MAX_PLAIN);
}
