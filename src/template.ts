import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_PROMPT } from './default-prompt.js';

export type GitHubContextLike = {
  ref?: string;
  sha?: string;
  runId?: number | string;
  serverUrl?: string;
  repo?: { owner: string; repo: string };
  payload?: {
    pull_request?: {
      number?: number;
      head?: { ref?: string; sha?: string };
    };
  };
};

export type ResolvePromptArgs = {
  promptTemplate: string;
  promptTemplateFile: string;
  scenario: string;
  workspace: string;
  onFallbackNotice?: (message: string) => void;
};

export type ResolvedPrompt = {
  body: string;
  source: 'inline' | 'file' | 'scenario' | 'default';
  path?: string;
};

export function resolvePromptBody(args: ResolvePromptArgs): ResolvedPrompt {
  const { promptTemplate, promptTemplateFile, scenario, workspace, onFallbackNotice } = args;

  if (promptTemplate.trim().length > 0) {
    return { body: promptTemplate, source: 'inline' };
  }

  if (promptTemplateFile.trim().length > 0) {
    const resolved = path.isAbsolute(promptTemplateFile)
      ? promptTemplateFile
      : path.join(workspace, promptTemplateFile);
    return { body: fs.readFileSync(resolved, 'utf8'), source: 'file', path: resolved };
  }

  const scenarioPath = path.join(workspace, '.github', 'argus-scenarios', `${scenario}.md`);
  if (fs.existsSync(scenarioPath)) {
    return { body: fs.readFileSync(scenarioPath, 'utf8'), source: 'scenario', path: scenarioPath };
  }

  onFallbackNotice?.(
    `No prompt_template, prompt_template_file, or scenario file found for "${scenario}". Using built-in DEFAULT_PROMPT.`,
  );
  return { body: DEFAULT_PROMPT, source: 'default' };
}

export type BuildContextArgs = {
  baseUrl: string;
  github: GitHubContextLike;
  extraVars: string;
};

const BUILT_IN_KEYS = ['BASE_URL', 'PR_NUMBER', 'BRANCH', 'COMMIT_SHA', 'REPO', 'RUN_URL'] as const;

export function buildContext(args: BuildContextArgs): Record<string, string> {
  const { baseUrl, github, extraVars } = args;

  const pr = github.payload?.pull_request;
  const prNumber = pr?.number != null ? String(pr.number) : '';
  const branch =
    pr?.head?.ref ??
    (github.ref && github.ref.startsWith('refs/heads/')
      ? github.ref.substring('refs/heads/'.length)
      : github.ref ?? '');
  const commitSha = pr?.head?.sha ?? github.sha ?? '';
  const repo = github.repo ? `${github.repo.owner}/${github.repo.repo}` : '';
  const runUrl =
    github.serverUrl && github.repo && github.runId != null
      ? `${github.serverUrl}/${github.repo.owner}/${github.repo.repo}/actions/runs/${github.runId}`
      : '';

  const builtIns: Record<string, string> = {
    BASE_URL: baseUrl,
    PR_NUMBER: prNumber,
    BRANCH: branch,
    COMMIT_SHA: commitSha,
    REPO: repo,
    RUN_URL: runUrl,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(extraVars);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`extra_vars is not valid JSON: ${message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extra_vars must be a JSON object (e.g. `{"FOO":"bar"}`)');
  }

  const merged: Record<string, string> = { ...builtIns };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    merged[key] = value == null ? '' : String(value);
  }
  return merged;
}

const TOKEN_RE = /\$\{([A-Z0-9_]+)\}/g;

export function substitute(body: string, ctx: Record<string, string>): string {
  const unresolved = new Set<string>();
  const out = body.replace(TOKEN_RE, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) {
      return ctx[key];
    }
    unresolved.add(key);
    return '';
  });
  if (unresolved.size > 0) {
    const names = Array.from(unresolved).sort().join(', ');
    throw new Error(`Prompt template has unresolved \${VAR} tokens: ${names}`);
  }
  return out;
}

export { BUILT_IN_KEYS };
