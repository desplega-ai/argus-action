import { describe, it, expect, vi } from 'vitest';
import {
  deriveCopeBaseUrl,
  renderCommentBody,
  stickyMarker,
  upsertPrComment,
  verdictFor,
} from './comment.js';
import type { ArgusRunOutcomeResponse } from './types.js';

const baseOutcome: ArgusRunOutcomeResponse = {
  session_id: 's1',
  status: 'completed',
  report_md: '# hi',
  elapsed_s: 12.3,
  tokens_in: 100,
  tokens_out: 200,
  credits_used: 5,
};

describe('stickyMarker', () => {
  it('collapses to bare scenario without comment_key', () => {
    expect(stickyMarker('smoke-login')).toBe('<!-- argus-action:smoke-login -->');
  });

  it('includes comment_key when provided', () => {
    expect(stickyMarker('smoke-login', 'staging')).toBe(
      '<!-- argus-action:smoke-login:staging -->',
    );
  });
});

describe('verdictFor', () => {
  it('pass for completed', () => {
    expect(verdictFor('completed')).toContain('pass');
  });
  it('fail for anything else', () => {
    for (const s of ['aborted', 'failed', 'error', 'timed_out'] as const) {
      expect(verdictFor(s)).toContain('fail');
    }
  });
});

describe('deriveCopeBaseUrl', () => {
  it('strips api. from argus_base_url', () => {
    expect(deriveCopeBaseUrl('https://api.desplega.ai', '')).toBe('https://desplega.ai');
  });
  it('respects explicit override', () => {
    expect(deriveCopeBaseUrl('https://api.desplega.ai', 'https://ui.test')).toBe(
      'https://ui.test',
    );
  });
  it('leaves non-api hostnames alone', () => {
    expect(deriveCopeBaseUrl('https://staging.example.com', '')).toBe(
      'https://staging.example.com',
    );
  });
});

describe('renderCommentBody', () => {
  it('renders pass with report', () => {
    const body = renderCommentBody({
      scenario: 'smoke',
      outcome: baseOutcome,
      sessionId: 's1',
      copeBaseUrl: 'https://desplega.ai',
      runUrl: 'https://gh.test/run/1',
    });
    expect(body).toContain('<!-- argus-action:smoke -->');
    expect(body).toContain('### smoke: ✅ pass');
    expect(body).toContain('https://desplega.ai/argus/sessions/s1');
    expect(body).toContain('duration: 12.3s');
    expect(body).toContain('tokens: 300');
    expect(body).toContain('credits: 5');
    expect(body).toContain('CI run');
    expect(body).toContain('<details open><summary>Agent report</summary>');
  });

  it('renders fail with error when report missing', () => {
    const body = renderCommentBody({
      scenario: 'smoke',
      outcome: { session_id: 's1', status: 'failed', error: 'boom' },
      sessionId: 's1',
      copeBaseUrl: 'https://desplega.ai',
      runUrl: '',
    });
    expect(body).toContain('### smoke: ❌ fail');
    expect(body).toContain('<summary>Error</summary>');
    expect(body).toContain('boom');
  });

  it('renders no-report fallback', () => {
    const body = renderCommentBody({
      scenario: 'smoke',
      outcome: { session_id: 's1', status: 'timed_out' },
      sessionId: 's1',
      copeBaseUrl: 'https://desplega.ai',
      runUrl: '',
    });
    expect(body).toContain('_No report produced._');
  });

  it('uses comment_key in marker', () => {
    const body = renderCommentBody({
      scenario: 'smoke',
      outcome: baseOutcome,
      sessionId: 's1',
      copeBaseUrl: 'https://desplega.ai',
      runUrl: '',
      commentKey: 'preview',
    });
    expect(body).toContain('<!-- argus-action:smoke:preview -->');
  });
});

describe('upsertPrComment', () => {
  function makeOctokit(options: {
    comments?: Array<{ id: number; body: string; html_url: string }>;
    failListWith?: number;
  }) {
    const comments = options.comments ?? [];
    const createComment = vi.fn(async () => ({ data: { html_url: 'https://gh/pr#new' } }));
    const updateComment = vi.fn(async () => ({ data: { html_url: 'https://gh/pr#upd' } }));
    const listComments = 'LIST';
    const paginate = vi.fn(async () => {
      if (options.failListWith) {
        const e = new Error('forbidden') as Error & { status?: number };
        e.status = options.failListWith;
        throw e;
      }
      return comments;
    });
    return {
      octokit: {
        paginate,
        rest: { issues: { listComments, createComment, updateComment } },
      },
      createComment,
      updateComment,
    };
  }

  it('creates a new comment when no marker found', async () => {
    const { octokit, createComment, updateComment } = makeOctokit({ comments: [] });
    const url = await upsertPrComment({
      octokit,
      owner: 'a',
      repo: 'b',
      issueNumber: 1,
      marker: '<!-- argus-action:smoke -->',
      body: '<!-- argus-action:smoke -->\nhi',
    });
    expect(url).toBe('https://gh/pr#new');
    expect(createComment).toHaveBeenCalledOnce();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('updates existing comment when marker found', async () => {
    const { octokit, createComment, updateComment } = makeOctokit({
      comments: [
        { id: 9, body: 'unrelated', html_url: 'https://gh/0' },
        { id: 10, body: '<!-- argus-action:smoke -->\nold', html_url: 'https://gh/1' },
      ],
    });
    const url = await upsertPrComment({
      octokit,
      owner: 'a',
      repo: 'b',
      issueNumber: 1,
      marker: '<!-- argus-action:smoke -->',
      body: '<!-- argus-action:smoke -->\nnew',
    });
    expect(url).toBe('https://gh/pr#upd');
    expect(updateComment).toHaveBeenCalledOnce();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('handles 403 via onForbidden and returns empty string', async () => {
    const { octokit } = makeOctokit({ failListWith: 403 });
    const warnings: string[] = [];
    const url = await upsertPrComment({
      octokit,
      owner: 'a',
      repo: 'b',
      issueNumber: 1,
      marker: '<!-- argus-action:smoke -->',
      body: 'body',
      onForbidden: (m) => warnings.push(m),
    });
    expect(url).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('pull-requests: write');
  });
});
