import { describe, it, expect } from 'vitest';
import { formatEventLine } from './log-formatter.js';

describe('formatEventLine', () => {
  it('extracts whitelisted structural fields', () => {
    const line = formatEventLine({
      event: 'step',
      data: JSON.stringify({ step: 3, status: 'running' }),
    });
    expect(line).toBe('[step] step=3 status=running');
  });

  it('omits non-whitelisted fields (message, url) to avoid leaking content', () => {
    const line = formatEventLine({
      event: 'tool_use',
      data: JSON.stringify({
        tool: 'screenshot',
        url: 'https://x.com/secret?token=abc',
        message: 'Navigating to page',
      }),
    });
    expect(line).toBe('[tool_use] tool=screenshot');
    expect(line).not.toContain('message');
    expect(line).not.toContain('url');
  });

  it('emits only the tag when payload is plain text', () => {
    expect(formatEventLine({ event: 'status', data: 'running' })).toBe('[status]');
  });

  it('emits only the tag for long plain text (no raw slice fallback)', () => {
    const long = 'x'.repeat(200);
    expect(formatEventLine({ event: 'log', data: long })).toBe('[log]');
  });

  it('handles empty data', () => {
    expect(formatEventLine({ event: 'ping', data: '' })).toBe('[ping]');
  });

  it('emits only the tag when JSON has no whitelisted fields', () => {
    const line = formatEventLine({
      event: 'custom',
      data: JSON.stringify({ message: 'anything', payload: { secret: 'hunter2' } }),
    });
    expect(line).toBe('[custom]');
  });

  it('uses inner data.type as tag when outer event is "message"', () => {
    const line = formatEventLine({
      event: 'message',
      data: '{"type":"agent_end","some":"x"}',
    });
    expect(line.startsWith('[agent_end]')).toBe(true);
  });
});
