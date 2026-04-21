import { innerType, type SseEvent } from './argus-client.js';

const ALLOWED_FIELDS = ['step', 'tool', 'name', 'status'] as const;

export function formatEventLine(evt: SseEvent): string {
  const tagName = evt.event === 'message' ? (innerType(evt) ?? 'message') : evt.event;
  const tag = `[${tagName}]`;
  const summary = extractSummary(evt.data);
  return summary ? `${tag} ${summary}` : tag;
}

function extractSummary(raw: string): string {
  if (!raw) return '';
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return '';
  }
  if (!obj || typeof obj !== 'object') return '';

  const parts: string[] = [];
  for (const key of ALLOWED_FIELDS) {
    const v = obj[key];
    if (typeof v === 'string' || typeof v === 'number') {
      parts.push(`${key}=${v}`);
    }
  }
  return parts.join(' ');
}
