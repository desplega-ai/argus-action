export type ArgusWaitMode = 'no' | 'stream' | 'poll';

export type RunArgusRequest = {
  prompt: string;
  wait: ArgusWaitMode;
  behavior_mode?: 'autonomous' | 'api';
  timeout_s?: number;
};

export type RunArgusResponse = {
  session_id: string;
  instance_id?: string | null;
  poll_url: string;
  stream_url?: string | null;
  outcome?: ArgusRunOutcomeResponse | null;
};

export type ArgusStatus =
  | 'running'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'error'
  | 'timed_out';

export type ArgusRunOutcomeResponse = {
  session_id: string;
  status: ArgusStatus;
  report_md?: string | null;
  report_url?: string | null;
  transcript_url?: string | null;
  error?: string | null;
  elapsed_s?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  credits_used?: number | null;
};

export class ArgusApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`Argus API error ${status} at ${url}: ${body.slice(0, 300)}`);
    this.name = 'ArgusApiError';
  }
}

export class InsufficientCreditsError extends Error {
  constructor(public readonly body: string) {
    super('ARGUS_INSUFFICIENT_CREDITS');
    this.name = 'InsufficientCreditsError';
  }
}
