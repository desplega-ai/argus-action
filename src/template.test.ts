import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePromptBody, buildContext, substitute } from './template.js';
import { DEFAULT_PROMPT } from './default-prompt.js';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-action-test-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('substitute', () => {
  it('replaces known tokens', () => {
    expect(substitute('Hi ${NAME}!', { NAME: 'World' })).toBe('Hi World!');
  });

  it('throws listing every unresolved token in sorted order', () => {
    expect(() => substitute('${ZERO} ${ALPHA} ${ZERO}', {})).toThrow(/ALPHA, ZERO/);
  });

  it('leaves shell-style ${var:-default} untouched', () => {
    const out = substitute('hello ${foo:-bar} ${BASE_URL}', { BASE_URL: 'http://x' });
    expect(out).toBe('hello ${foo:-bar} http://x');
  });

  it('leaves lower-case tokens alone', () => {
    expect(substitute('${foo}', {})).toBe('${foo}');
  });
});

describe('buildContext', () => {
  const gh = {
    ref: 'refs/heads/main',
    sha: 'cafebabe',
    runId: 42,
    serverUrl: 'https://github.com',
    repo: { owner: 'acme', repo: 'widgets' },
    payload: { pull_request: { number: 7, head: { ref: 'feat/x', sha: 'deadbeef' } } },
  };

  it('populates built-ins from GitHub context', () => {
    const ctx = buildContext({ baseUrl: 'https://x', github: gh, extraVars: '{}' });
    expect(ctx).toMatchObject({
      BASE_URL: 'https://x',
      PR_NUMBER: '7',
      BRANCH: 'feat/x',
      COMMIT_SHA: 'deadbeef',
      REPO: 'acme/widgets',
      RUN_URL: 'https://github.com/acme/widgets/actions/runs/42',
    });
  });

  it('falls back to ref-derived branch outside PR context', () => {
    const ctx = buildContext({
      baseUrl: 'https://x',
      github: { ...gh, payload: {} },
      extraVars: '{}',
    });
    expect(ctx.BRANCH).toBe('main');
  });

  it('merges extra_vars over built-ins', () => {
    const ctx = buildContext({
      baseUrl: 'https://x',
      github: gh,
      extraVars: '{"BASE_URL":"https://override","FOO":"bar"}',
    });
    expect(ctx.BASE_URL).toBe('https://override');
    expect(ctx.FOO).toBe('bar');
  });

  it('rejects malformed JSON extra_vars with a clean message', () => {
    expect(() => buildContext({ baseUrl: 'x', github: gh, extraVars: '{bad}' })).toThrow(
      /extra_vars is not valid JSON/,
    );
  });

  it('rejects non-object extra_vars', () => {
    expect(() => buildContext({ baseUrl: 'x', github: gh, extraVars: '[1,2]' })).toThrow(
      /JSON object/,
    );
  });
});

describe('resolvePromptBody', () => {
  it('inline template wins over file and scenario', () => {
    const scenarioDir = path.join(workspace, '.github', 'argus-scenarios');
    fs.mkdirSync(scenarioDir, { recursive: true });
    fs.writeFileSync(path.join(scenarioDir, 'smoke.md'), 'SCENARIO_BODY');
    const result = resolvePromptBody({
      promptTemplate: 'INLINE',
      promptTemplateFile: 'ignored.md',
      scenario: 'smoke',
      workspace,
    });
    expect(result.body).toBe('INLINE');
    expect(result.source).toBe('inline');
  });

  it('reads prompt_template_file relative to workspace', () => {
    const p = path.join(workspace, 'prompts', 'hi.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'FILE_BODY');
    const result = resolvePromptBody({
      promptTemplate: '',
      promptTemplateFile: 'prompts/hi.md',
      scenario: 'smoke',
      workspace,
    });
    expect(result.body).toBe('FILE_BODY');
    expect(result.source).toBe('file');
  });

  it('falls back to scenario file when template inputs are empty', () => {
    const scenarioDir = path.join(workspace, '.github', 'argus-scenarios');
    fs.mkdirSync(scenarioDir, { recursive: true });
    fs.writeFileSync(path.join(scenarioDir, 'smoke.md'), 'SCENARIO_BODY');
    const result = resolvePromptBody({
      promptTemplate: '',
      promptTemplateFile: '',
      scenario: 'smoke',
      workspace,
    });
    expect(result.body).toBe('SCENARIO_BODY');
    expect(result.source).toBe('scenario');
  });

  it('falls back to DEFAULT_PROMPT when nothing is found', () => {
    const notices: string[] = [];
    const result = resolvePromptBody({
      promptTemplate: '',
      promptTemplateFile: '',
      scenario: 'missing',
      workspace,
      onFallbackNotice: (m) => notices.push(m),
    });
    expect(result.body).toBe(DEFAULT_PROMPT);
    expect(result.source).toBe('default');
    expect(notices).toHaveLength(1);
  });
});
