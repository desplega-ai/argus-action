import * as core from '@actions/core';
import * as github from '@actions/github';
import { buildContext, resolvePromptBody, substitute } from './template.js';
import { pollOutcome, startRun, streamEvents } from './argus-client.js';
import { formatEventLine } from './log-formatter.js';
import { innerType } from './argus-client.js';
import { ArgusApiError, InsufficientCreditsError } from './types.js';
import type { ArgusRunOutcomeResponse, ArgusWaitMode } from './types.js';
import {
  buildSessionUrl,
  renderCommentBody,
  stickyMarker,
  upsertPrComment,
} from './comment.js';
import { writeStepSummary } from './step-summary.js';

export type Inputs = {
  scenario: string;
  promptTemplate: string;
  promptTemplateFile: string;
  baseUrl: string;
  argusBaseUrl: string;
  uiBaseUrl: string;
  extraVars: string;
  waitMode: string;
  timeoutS: number;
  failOn: string;
  commentOnPr: boolean;
  commentKey: string;
  githubToken: string;
};

export function readInputs(): Inputs {
  return {
    scenario: core.getInput('scenario') || 'argus',
    promptTemplate: core.getInput('prompt_template'),
    promptTemplateFile: core.getInput('prompt_template_file'),
    baseUrl: core.getInput('base_url', { required: true }),
    argusBaseUrl: core.getInput('argus_base_url') || 'https://api.desplega.ai',
    uiBaseUrl: core.getInput('ui_base_url') || 'https://app.desplega.ai',
    extraVars: core.getInput('extra_vars') || '{}',
    waitMode: core.getInput('wait_mode') || 'poll',
    timeoutS: Number.parseInt(core.getInput('timeout_s') || '900', 10),
    failOn: core.getInput('fail_on') || 'failed',
    commentOnPr: (core.getInput('comment_on_pr') || 'true').toLowerCase() === 'true',
    commentKey: core.getInput('comment_key'),
    githubToken: core.getInput('github_token'),
  };
}

async function run(): Promise<void> {
  try {
    const apiKey = process.env.ARGUS_API_KEY;
    if (!apiKey) {
      core.setFailed(
        'ARGUS_API_KEY is not set. Expose it via env (e.g. `env: { ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }} }`) on the step that invokes this action.',
      );
      return;
    }
    core.setSecret(apiKey);

    const inputs = readInputs();
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

    core.info(`scenario=${inputs.scenario}`);
    core.info(`base_url=${inputs.baseUrl}`);
    core.info(`argus_base_url=${inputs.argusBaseUrl}`);
    core.info(`wait_mode=${inputs.waitMode}`);
    core.info(`timeout_s=${inputs.timeoutS}`);
    core.info(`fail_on=${inputs.failOn}`);
    core.info(`comment_on_pr=${inputs.commentOnPr}`);

    const resolved = resolvePromptBody({
      promptTemplate: inputs.promptTemplate,
      promptTemplateFile: inputs.promptTemplateFile,
      scenario: inputs.scenario,
      workspace,
      onFallbackNotice: (m) => core.notice(m),
    });
    core.info(`prompt source=${resolved.source}${resolved.path ? ` (${resolved.path})` : ''}`);

    const ctx = buildContext({
      baseUrl: inputs.baseUrl,
      github: github.context as unknown as Parameters<typeof buildContext>[0]['github'],
      extraVars: inputs.extraVars,
    });

    const prompt = substitute(resolved.body, ctx);
    core.info(`resolved prompt length=${prompt.length}`);

    const backendWait: ArgusWaitMode = inputs.waitMode === 'no' ? 'no' : 'stream';

    const runResp = await startRun({
      argusBaseUrl: inputs.argusBaseUrl,
      apiKey,
      body: {
        prompt,
        wait: backendWait,
        behavior_mode: 'api',
      },
    });

    core.setOutput('session_id', runResp.session_id);
    core.setOutput('instance_id', runResp.instance_id ?? '');
    core.setOutput('poll_url', runResp.poll_url);

    if (inputs.waitMode === 'no') {
      core.info(`session_id=${runResp.session_id}`);
      core.info(`poll_url=${runResp.poll_url}`);
      core.setOutput('outcome_status', '');
      core.setOutput('comment_url', '');
      return;
    }

    const actionStart = Date.now();
    let outcome: ArgusRunOutcomeResponse;

    if (runResp.stream_url) {
      const { sawAgentEnd } = await streamEvents({
        argusBaseUrl: inputs.argusBaseUrl,
        apiKey,
        streamUrl: runResp.stream_url,
        onEvent: (evt) => {
          const line = formatEventLine(evt);
          const t = evt.event === 'message' ? (innerType(evt) ?? 'message') : evt.event;
          if (t.includes('error')) {
            core.notice(line);
          } else {
            core.info(line);
          }
        },
      });

      const deadlineMs = sawAgentEnd
        ? Date.now() + 60_000
        : actionStart + inputs.timeoutS * 1000;
      outcome = await pollOutcome({
        argusBaseUrl: inputs.argusBaseUrl,
        apiKey,
        sessionId: runResp.session_id,
        deadlineMs,
      });
    } else {
      outcome = await pollOutcome({
        argusBaseUrl: inputs.argusBaseUrl,
        apiKey,
        sessionId: runResp.session_id,
        deadlineMs: actionStart + inputs.timeoutS * 1000,
      });
    }

    core.setOutput('outcome_status', outcome.status);
    core.info(`outcome: status=${outcome.status} elapsed_s=${outcome.elapsed_s ?? '?'}`);

    const uiBaseUrl = inputs.uiBaseUrl.replace(/\/$/, '');
    const sessionUrl = buildSessionUrl(uiBaseUrl, runResp.session_id);
    const runUrl =
      github.context.serverUrl && github.context.repo
        ? `${github.context.serverUrl}/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`
        : '';

    let commentUrl = '';
    const prNumber = github.context.payload.pull_request?.number;
    if (inputs.commentOnPr && prNumber && inputs.githubToken) {
      const marker = stickyMarker(inputs.scenario, inputs.commentKey);
      const body = renderCommentBody({
        scenario: inputs.scenario,
        outcome,
        sessionId: runResp.session_id,
        uiBaseUrl,
        runUrl,
        commentKey: inputs.commentKey,
      });
      const octokit = github.getOctokit(inputs.githubToken);
      commentUrl = await upsertPrComment({
        octokit: octokit as unknown as Parameters<typeof upsertPrComment>[0]['octokit'],
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issueNumber: prNumber,
        marker,
        body,
        onForbidden: (m) => core.warning(m),
      });
    } else if (inputs.commentOnPr && !prNumber) {
      core.notice('argus-action: no pull_request in event context — skipping PR comment.');
    }
    core.setOutput('comment_url', commentUrl);

    await writeStepSummary({ scenario: inputs.scenario, outcome, sessionUrl });

    if (inputs.failOn === 'failed' && outcome.status !== 'completed') {
      core.setFailed(`Argus session ${runResp.session_id}: ${outcome.status}`);
    }
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      core.error(`ARGUS_INSUFFICIENT_CREDITS: ${err.body}`);
      core.setFailed(err.message);
      return;
    }
    if (err instanceof ArgusApiError) {
      core.startGroup('argus-error-body');
      core.info(err.body);
      core.endGroup();
      core.setFailed(err.message);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
  }
}

void run();
