import type { ArgusRunOutcomeResponse, ArgusStatus } from './types.js';

export type RenderArgs = {
  scenario: string;
  outcome: ArgusRunOutcomeResponse;
  sessionId: string;
  uiBaseUrl: string;
  runUrl: string;
  commentKey?: string;
};

export function stickyMarker(scenario: string, commentKey?: string): string {
  const suffix = commentKey && commentKey.length > 0 ? `:${commentKey}` : '';
  return `<!-- argus-action:${scenario}${suffix} -->`;
}

export function verdictFor(status: ArgusStatus): string {
  return status === 'completed' ? '✅ pass' : '❌ fail';
}

export function buildSessionUrl(uiBaseUrl: string, sessionId: string): string {
  return `${uiBaseUrl.replace(/\/$/, '')}/argus?session=${sessionId}`;
}

export function renderCommentBody(args: RenderArgs): string {
  const { scenario, outcome, sessionId, uiBaseUrl, runUrl, commentKey } = args;
  const marker = stickyMarker(scenario, commentKey);
  const verdict = verdictFor(outcome.status);
  const sessionUrl = buildSessionUrl(uiBaseUrl, sessionId);

  const metaParts: string[] = [`Session: [${sessionId}](${sessionUrl})`];
  if (outcome.elapsed_s != null) metaParts.push(`duration: ${outcome.elapsed_s.toFixed(1)}s`);
  const tokensIn = outcome.tokens_in ?? 0;
  const tokensOut = outcome.tokens_out ?? 0;
  if (tokensIn || tokensOut) metaParts.push(`tokens: ${tokensIn + tokensOut}`);
  if (outcome.credits_used != null) metaParts.push(`credits: ${outcome.credits_used}`);
  if (runUrl) metaParts.push(`[CI run](${runUrl})`);

  const reportBody = (outcome.report_md ?? '').trim();
  const errorBody = (outcome.error ?? '').trim();

  let reportSection: string;
  if (reportBody.length > 0) {
    reportSection = `<details open><summary>Agent report</summary>\n\n${reportBody}\n\n</details>`;
  } else if (errorBody.length > 0) {
    reportSection = `<details open><summary>Error</summary>\n\n\`\`\`\n${errorBody}\n\`\`\`\n\n</details>`;
  } else {
    reportSection = '_No report produced._';
  }

  return [
    marker,
    `### ${scenario}: ${verdict}`,
    '',
    metaParts.join(' · '),
    '',
    reportSection,
  ].join('\n');
}

export type OctokitLike = {
  paginate: <T>(fn: unknown, params: unknown) => Promise<T[]>;
  rest: {
    issues: {
      listComments: unknown;
      createComment: (params: unknown) => Promise<{ data: { html_url: string } }>;
      updateComment: (params: unknown) => Promise<{ data: { html_url: string } }>;
    };
  };
};

type IssueComment = { id: number; body?: string | null; html_url: string };

export type UpsertArgs = {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  issueNumber: number;
  marker: string;
  body: string;
  onForbidden?: (message: string) => void;
};

export async function upsertPrComment(args: UpsertArgs): Promise<string> {
  const { octokit, owner, repo, issueNumber, marker, body, onForbidden } = args;
  try {
    const comments = await octokit.paginate<IssueComment>(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const existing = [...comments].reverse().find((c) => (c.body ?? '').includes(marker));
    if (existing) {
      const updated = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      return updated.data.html_url;
    }
    const created = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return created.data.html_url;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) {
      const msg =
        "argus-action: failed to post PR comment (HTTP 403). Consumer workflow likely missing 'permissions: pull-requests: write'. See README.";
      onForbidden?.(msg);
      return '';
    }
    throw err;
  }
}
