import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildContext, substitute } from './template.js';
import { DEFAULT_PROMPT } from './default-prompt.js';

const SCENARIO_DIR = path.join(__dirname, '..', '.github', 'argus-scenarios');

const gh = {
  ref: 'refs/heads/feat/x',
  sha: 'cafebabe1234',
  runId: 42,
  serverUrl: 'https://github.com',
  repo: { owner: 'acme', repo: 'widgets' },
  payload: { pull_request: { number: 7, head: { ref: 'feat/x', sha: 'cafebabe1234' } } },
};

function ctx(extra: Record<string, string> = {}): Record<string, string> {
  return buildContext({
    baseUrl: 'https://preview.example.com',
    github: gh,
    extraVars: JSON.stringify(extra),
  });
}

describe('shipped scenarios substitute cleanly', () => {
  it('smoke-login.md leaves no unresolved tokens', () => {
    const body = fs.readFileSync(path.join(SCENARIO_DIR, 'smoke-login.md'), 'utf8');
    expect(() => substitute(body, ctx())).not.toThrow();
  });

  it('pr-explore.md substitutes when PR_BODY is provided', () => {
    const body = fs.readFileSync(path.join(SCENARIO_DIR, 'pr-explore.md'), 'utf8');
    expect(() => substitute(body, ctx({ PR_BODY: 'Replaces nav with sidebar.' }))).not.toThrow();
  });

  it('pr-explore.md fails clearly without PR_BODY', () => {
    const body = fs.readFileSync(path.join(SCENARIO_DIR, 'pr-explore.md'), 'utf8');
    expect(() => substitute(body, ctx())).toThrow(/PR_BODY/);
  });

  it('default prompt substitutes with only built-ins', () => {
    expect(() => substitute(DEFAULT_PROMPT, ctx())).not.toThrow();
  });
});
