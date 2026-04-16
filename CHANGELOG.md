# Changelog

## v1.0.0 — 2026-04-16

- Initial release.
- Wraps `POST /api/v1/argus/run` with Bearer auth.
- Streams SSE events into the job log and breaks on `agent_end`.
- Polls the session endpoint for final outcome with a pydantic-flush race guard.
- Posts a sticky PR comment per scenario (`<!-- argus-action:<scenario>[:<comment_key>] -->`).
- Writes verdict to `$GITHUB_STEP_SUMMARY`.
- Ships reusable workflow `argus-pr.yaml` plus two example caller workflows and two example scenarios.
- Special-cases 402 `insufficient_credits` with a grep-able error line; 403 from comment posting emits a `::warning::` without failing the job.
