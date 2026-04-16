import { describe, it, expect } from 'vitest';
import { formatEventLine, shouldGroup } from './log-formatter.js';

describe('formatEventLine', () => {
  it('formats JSON data with known fields', () => {
    const line = formatEventLine({
      event: 'step',
      data: JSON.stringify({ message: 'Navigating to page', step: 3 }),
    });
    expect(line).toBe('[step] message=Navigating to page step=3');
  });

  it('formats plain text data', () => {
    const line = formatEventLine({ event: 'status', data: 'running' });
    expect(line).toBe('[status] running');
  });

  it('truncates long plain text', () => {
    const long = 'x'.repeat(200);
    const line = formatEventLine({ event: 'log', data: long });
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(200);
  });

  it('handles empty data', () => {
    expect(formatEventLine({ event: 'ping', data: '' })).toBe('[ping]');
  });

  it('handles tool event JSON', () => {
    const line = formatEventLine({
      event: 'tool_use',
      data: JSON.stringify({ tool: 'screenshot', url: 'https://x.com' }),
    });
    expect(line).toContain('tool=screenshot');
    expect(line).toContain('url=https://x.com');
  });
});

describe('shouldGroup', () => {
  it('groups tool_use and tool_result', () => {
    expect(shouldGroup({ event: 'tool_use', data: '' })).toBe(true);
    expect(shouldGroup({ event: 'tool_result', data: '' })).toBe(true);
  });

  it('does not group step events', () => {
    expect(shouldGroup({ event: 'step', data: '' })).toBe(false);
  });
});
