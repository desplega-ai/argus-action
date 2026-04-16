import * as core from '@actions/core';
import type { ArgusRunOutcomeResponse } from './types.js';
import { verdictFor } from './comment.js';

export type StepSummaryArgs = {
  scenario: string;
  outcome: ArgusRunOutcomeResponse;
  sessionUrl: string;
};

export async function writeStepSummary(args: StepSummaryArgs): Promise<void> {
  const { scenario, outcome, sessionUrl } = args;
  const verdict = verdictFor(outcome.status);
  const line = `**Argus — ${scenario}**: ${verdict} ([session](${sessionUrl}))`;
  await core.summary.addRaw(line + '\n', true).write();
}
