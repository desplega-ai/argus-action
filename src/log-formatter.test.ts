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

  it('groups cope-style tool_execution_* packed in message frames', () => {
    expect(shouldGroup({ event: 'message', data: '{"type":"tool_execution_start"}' })).toBe(true);
    expect(shouldGroup({ event: 'message', data: '{"type":"toolcall_end"}' })).toBe(true);
  });

  it('does not group step events', () => {
    expect(shouldGroup({ event: 'step', data: '' })).toBe(false);
  });
});

describe('formatEventLine (inner-type unwrap)', () => {
  it('uses inner data.type as tag when outer event is "message"', () => {
    const line = formatEventLine({
      event: 'message',
      data: '{"type":"agent_end","some":"x"}',
    });
    expect(line.startsWith('[agent_end]')).toBe(true);
  });
});
