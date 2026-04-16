---
title: Argus GitHub Action — "Run Argus Session on PR"
date: 2026-04-16
status: completed
owner: taras
planner: taras
topic: argus-github-action
autonomy: autopilot
---

# Argus GitHub Action — "Run Argus Session on PR"

## Overview

Build a reusable, repo-agnostic GitHub Action that wraps `POST /api/v1/argus/run` (the public Bearer-API-key Argus endpoint in cope), tails the agent session's SSE stream into the job log, then posts the agent's final `report_md` as a PR comment. The action ships in this `argus-action` repo and is consumed from other repos as `owner/argus-action@v1`. A single secret (`ARGUS_API_KEY`) is the only requirement; everything else is driven by inputs and a `${VAR}`-substituted prompt template.

One action, two use cases without a rewrite:
- **Deterministic smoke test** — canned prompt, fails the job on non-pass (good for required checks).
- **Exploratory agent run** — "try X, tell us if anything looks broken" (informational; `fail_on=never`).

## Current State Analysis

- The `argus-action` repo (`/Users/taras/Documents/code/argus-action/`) is **brand new and empty** — only a `.git` directory exists. No `package.json`, no `action.yml`, no `.github/`. Everything in this plan is net-new.
- The Argus backend surface we are wrapping lives in the sibling `cope` repo at `/Users/taras/Documents/code/cope/be/api/argus/`:
  - `POST /api/v1/argus/run` — kicks off a session. Bearer auth. Body: `RunArgusRequest`. Response: `RunArgusResponse`.
  - `GET /api/v1/argus/sessions/{session_id}` — poll final outcome. Response: `ArgusRunOutcomeResponse`.
  - `GET /api/v1/argus/sessions/{session_id}/stream` — SSE stream. Terminal event: `agent_end`. Break the loop immediately on that event (the stream otherwise stays open for minutes).
- Reference Python smoke (`be/random_argus_api_v1_smoke.py`) demonstrates:
  - `httpx` for HTTP + SSE (stream `timeout=None`, polling client `timeout=30s`).
  - Early break on `agent_end`.
  - Post-stream outcome poll retries on HTTP ≥500 (backend flushes pydantic validation) and on `status == "running"`, with a **60-second deadline** after the stream closes.
- Today's date: 2026-04-16.

### Key Discoveries

- **Three `wait` modes** on `/run`, producing different response shapes:
  - `wait="no"` → `{session_id, instance_id, poll_url, stream_url=None, outcome=None}` (fire-and-forget).
  - `wait="stream"` → adds `stream_url`, no `outcome`.
  - `wait="poll"` → server-side block up to `timeout_s`, populates `outcome` (or `status="timed_out"`).
- **Mapping ticket `wait_mode` → backend `wait`:**
  - Ticket `wait_mode=poll` (default) → backend `wait="stream"` + tail SSE + poll outcome (gives the best UX: live job-log progress + accurate final outcome).
  - Ticket `wait_mode=no` → backend `wait="no"`. Print `session_id` + `poll_url` and exit 0.
  - (The ticket's line "Fall back to `wait: 'poll'` when `wait_mode=no`" appears to be a typo — fire-and-forget uses `wait="no"`, per backend schema.)
- **Terminal outcome statuses** (`ArgusRunOutcomeResponse.status`):
  `"running" | "completed" | "aborted" | "failed" | "error" | "timed_out"`. There is **no** `verdict` field — pass/fail is derived from `status`. Treat `completed` as pass; everything else as fail for `fail_on=failed`.
- **Status codes to handle specially:**
  - `402 insufficient_credits` → dedicated grep-able error line, exit 1.
  - `409` (session has no agent_session_id yet) → stream endpoint not ready; retry briefly.
  - `4xx`/`5xx` otherwise → exit 1 with raw body in logs.
- **`behavior_mode` default is `"api"`** (matches ticket default). Literal is `"autonomous" | "api"`.
- **Presigned URL flow:** The backend may emit `report_url` / `transcript_url` (7-day presigned S3) and inline `report_md`. Screenshots are presigned URLs the agent embeds directly into `report_md`. The action does **not** handle uploads — it renders `report_md` verbatim into the PR comment.

## Desired End State

Any GitHub repo can consume this action as:

```yaml
- uses: owner/argus-action@v1
  with:
    scenario: smoke-login
    base_url: https://preview.example.com/pr-123
  env:
    ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

…and on PR runs, a comment containing the agent's rendered report (screenshots inline via presigned URLs) appears on the PR. The action's job log shows streamed SSE progress in real time. Non-pass outcomes fail the job when `fail_on=failed`.

**Deviation from ticket path:** Ticket literally specifies `.github/actions/argus-run/` for the action. Because this repo is a **dedicated standalone action repo** (its name IS `argus-action`), convention is to put `action.yml` at the **repo root** so consumers reference `owner/argus-action@v1` instead of the much uglier `owner/argus-action/.github/actions/argus-run@v1`. Plan uses the repo-root layout. If Taras wants the nested path, swap `/action.yml` for `/.github/actions/argus-run/action.yml` in Phase 1 — no other changes needed.

## Quick Verification Reference

Common commands:
- Build: `npm run build` (ncc bundle)
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Unit tests: `npm test`
- Format: `npm run format`

Key files after implementation:
- `/action.yml` — action manifest
- `/src/main.ts` — entrypoint (orchestrator)
- `/src/template.ts` — `${VAR}` substitution
- `/src/argus-client.ts` — HTTP client + SSE reader
- `/src/comment.ts` — PR comment renderer (sticky by scenario)
- `/dist/index.js` — bundled entrypoint (committed)
- `/.github/workflows/argus-pr.yaml` — reusable workflow
- `/.github/workflows/argus-smoke-example.yaml` — example caller
- `/.github/workflows/argus-explore-on-label.yaml` — example caller
- `/.github/argus-scenarios/smoke-login.md` — example scenario
- `/.github/argus-scenarios/pr-explore.md` — example scenario
- `/README.md` — top-level docs
- `/.github/actions/argus-run/README.md` — action docs (ticket requirement)

## What We're NOT Doing

- No new backend endpoints in cope. Reuse `/api/v1/argus/run` as-is.
- No Argus-instance pinning or provisioning from the action (`auto_provision` is backend-side).
- No cross-PR session deduping / reuse.
- No preview-env auto-discovery (`base_url` is always an explicit input).
- No multiple / streaming / auto-updating PR comments. One sticky comment per scenario, posted once after the run finishes.
- No attachment upload from the action. Screenshots must be presigned URLs already embedded in `report_md` by the agent.
- No shared/CI-owned Argus API key. Each consumer sets their own `ARGUS_API_KEY`.
- No re-hosting of screenshot images. Presigned URLs in `report_md` expire 7 days after generation (per backend schema). GitHub's camo proxy typically caches images on first render, so stale PR comments usually continue to display images; document this as a known limitation rather than attempting local asset rewriting.

## Implementation Approach

**Language: TypeScript + `@vercel/ncc`.** Rationale:
- Standard for published GitHub Actions.
- Native `fetch` (Node 20) handles SSE cleanly via `response.body.getReader()` — simpler than bash+curl piping.
- JSON parsing for `extra_vars`, error surfacing via `@actions/core`, and comment posting via `@actions/github` are all first-class.
- Composite shell was the alternative; rejected because SSE parsing in bash is ugly and `extra_vars` JSON handling would reinvent wheels.

**Pattern: single-file bundle committed at `dist/index.js`.** Standard published-action pattern. A pre-commit/CI check guards "dist is in sync with src".

**Action manifest at repo root.** See Desired End State note. `runs.using: node20`, `runs.main: dist/index.js`, `runs.post` omitted.

**Testing:**
- Unit tests (vitest) for: template substitution (happy path, unresolved tokens, nested braces), outcome→comment rendering (pass/fail/timed_out variants), exit-code policy.
- Integration (manual E2E): run the action against `https://api.desplega.ai` with a real key, both `smoke-login` and a deliberately-failing scenario. Credits are spent — not run on every commit.
- Self-test CI: a workflow that typechecks, lints, unit-tests, and verifies `dist/` is in sync on every PR.

---

## Phase 1: Repo scaffolding + action manifest

### Overview

Lay down a buildable TypeScript action skeleton so subsequent phases have somewhere to add real logic. Ends with a no-op action that prints its inputs and exits 0 — enough to verify the bundle + invocation path work end-to-end in CI.

### Changes Required:

#### 1. Package + build tooling
**Files:** `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc`, `.nvmrc` (`20`), `.gitignore` (exclude `node_modules/`, keep `dist/`)
**Changes:**
- Deps: `@actions/core`, `@actions/github`.
- DevDeps: `typescript`, `@vercel/ncc`, `vitest`, `@types/node`, `eslint`, `@typescript-eslint/{parser,eslint-plugin}`, `prettier`.
- Scripts: `build` (`ncc build src/main.ts -o dist --source-map --license licenses.txt`), `typecheck` (`tsc --noEmit`), `lint`, `test`, `format`.
- `tsconfig.json`: `target: ES2022`, `module: NodeNext`, `strict: true`, `outDir: lib`.

#### 2. Action manifest
**File:** `action.yml` (repo root)
**Changes:**
- Name: `Run Argus Session`, description, branding.
- Inputs mirror the ticket table: `scenario` (required), `prompt_template`, `prompt_template_file` (override path), `base_url` (required), `argus_base_url` (default `https://api.desplega.ai`), `extra_vars` (default `'{}'`), `wait_mode` (default `poll`), `timeout_s` (default `900`), `behavior_mode` (default `api`), `fail_on` (default `failed`), `comment_on_pr` (default `true`), `comment_key` (default `''`, disambiguates sticky comments when the same scenario runs against multiple `base_url`s on one PR), `github_token` (default `${{ github.token }}`).
- Secret pulled from env: `ARGUS_API_KEY` (documented as required env var, **not** an input — prevents accidental logging if callers misuse `with:`).
- Outputs: `session_id`, `instance_id`, `poll_url`, `outcome_status`, `comment_url`.
- `runs.using: node20`, `runs.main: dist/index.js`.

#### 3. Minimal entrypoint
**File:** `src/main.ts`
**Changes:**
- Read all inputs via `@actions/core.getInput`.
- Read `ARGUS_API_KEY` via `process.env`. Fail (`core.setFailed`) with a clear message if missing.
- `core.info` each resolved input except the key; `core.setSecret(apiKey)` before any use.
- Exit 0 (no real work yet).

#### 4. Initial bundle
**File:** `dist/index.js` (generated, committed)
**Changes:** `npm run build` produces and commits the bundled entrypoint. Also commit `dist/licenses.txt`.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `npm run typecheck`
- [x] Lint passes: `npm run lint`
- [x] Unit test harness runs (no tests yet is fine): `npm test -- --run`
- [x] Bundle builds: `npm run build`
- [x] `action.yml` is valid YAML: `node -e "require('js-yaml').load(require('fs').readFileSync('action.yml', 'utf8'))"` (after adding `js-yaml` as devDep) or `python -c "import yaml; yaml.safe_load(open('action.yml'))"`
- [x] `git diff --exit-code dist/` is clean after `npm run build` (dist in sync)

#### Manual Verification:
- [ ] Create a throwaway consumer repo, reference `uses: <owner>/argus-action@<sha>` from a workflow with dummy inputs, confirm the action runs, prints its inputs, and exits 0.
- [ ] Confirm `ARGUS_API_KEY` absence produces a clear, non-generic failure message.

**Implementation Note:** After this phase, pause for Taras to validate the layout choice (root vs `.github/actions/argus-run/`) before wiring real logic into subsequent phases. No commit unless Taras opts in per preference.

---

## Phase 2: Prompt template resolution + `${VAR}` substitution

### Overview

Add pure-function template handling: resolve where the prompt body comes from (inline input > scenario file > built-in fallback), build the substitution context from built-ins + `extra_vars`, and substitute `${VAR}` tokens. Fail loudly on unresolved tokens. Zero network I/O in this phase.

### Changes Required:

#### 1. Template resolution
**File:** `src/template.ts`
**Changes:**
- `resolvePromptBody({ promptTemplate, promptTemplateFile, scenario, workspace }): string`:
  - If `promptTemplate` non-empty → use it.
  - Else if `promptTemplateFile` non-empty → read from that path (relative to `workspace`).
  - Else try `<workspace>/.github/argus-scenarios/<scenario>.md`.
  - Else use built-in `DEFAULT_PROMPT` constant (contains the presigned-URL screenshot instruction verbatim from the ticket's example). Log an `::notice::` when falling back.
- `buildContext({ baseUrl, github, extraVars }): Record<string, string>`:
  - Built-ins: `BASE_URL`, `PR_NUMBER` (from `context.payload.pull_request?.number` or `''`), `BRANCH` (`context.ref.replace('refs/heads/', '')` or head ref for PRs), `COMMIT_SHA`, `REPO` (`owner/name`), `RUN_URL` (`<server_url>/<repo>/actions/runs/<run_id>`).
  - Parse `extraVars` as JSON object; non-object or malformed → throw with a specific error pointing at the input. Merge over built-ins (caller overrides).
- `substitute(body: string, ctx: Record<string, string>): string`:
  - Replace `${KEY}` tokens. Support only `[A-Z0-9_]+` to avoid clashing with shell-style `${var:-default}` inside example scripts.
  - Collect all unresolved tokens, throw a single error listing them.

#### 2. Built-in default prompt
**File:** `src/default-prompt.ts`
**Changes:** Export `DEFAULT_PROMPT` string. Instructs the agent to exercise `${BASE_URL}`, reference `${PR_NUMBER}`/`${BRANCH}`/`${COMMIT_SHA}`/`${RUN_URL}`, render screenshots via presigned URLs as inline markdown images, and report verdict as `pass`/`fail` with a short reason.

#### 3. Wiring in entrypoint
**File:** `src/main.ts`
**Changes:** Call `resolvePromptBody`, `buildContext`, `substitute`. Print resolved prompt length (not the body, to keep logs tidy). On error, `core.setFailed` with the precise reason.

#### 4. Unit tests
**File:** `src/template.test.ts`
**Changes:**
- Happy path with all variables.
- Unresolved token lists all offenders.
- Inline `promptTemplate` wins over file.
- File path resolution works with and without leading slash.
- Malformed `extra_vars` JSON surfaces a clean error.
- Non-UPPER tokens (`${foo}`) are left untouched (no false failures).

### Success Criteria:

#### Automated Verification:
- [x] Unit tests pass: `npm test -- --run`
- [x] Typecheck passes: `npm run typecheck`
- [x] Bundle in sync: `npm run build && git diff --exit-code dist/`

#### Manual Verification:
- [ ] Run the action locally via `node dist/index.js` with `INPUT_*` env vars for a scenario that references unknown `${FOO}` — confirm failure message names `FOO`.
- [ ] Run with `prompt_template` set inline — confirm file path is not consulted.
- [ ] Run with no template and no scenario file — confirm fallback message and that the default prompt kicks in.

**Implementation Note:** Pause after this phase — the template contract is user-visible and worth Taras' eyes on the `DEFAULT_PROMPT` wording.

---

## Phase 3: Argus API client (run + SSE stream + outcome poll)

### Overview

Wire the substituted prompt to the Argus backend. POST `/api/v1/argus/run`, tail the SSE stream into the job log with terminal break on `agent_end`, poll the session endpoint for the final outcome with the pydantic-flush race guard, and surface exit-code policy.

### Changes Required:

#### 1. HTTP + SSE client
**File:** `src/argus-client.ts`
**Changes:**
- `startRun({ argusBaseUrl, apiKey, body }): Promise<RunArgusResponse>`:
  - `POST ${argusBaseUrl}/api/v1/argus/run` with `Authorization: Bearer ${apiKey}`, `Content-Type: application/json`.
  - Body: `{ prompt, wait, behavior_mode }`. `wait` is `"stream"` for ticket `wait_mode=poll`, `"no"` for `wait_mode=no`. **Backend `timeout_s` is NOT sent** — per `RunArgusRequest` schema it is only honored for `wait="poll"`, which we never use. `timeout_s` is used purely as the action's local wall-clock deadline (stream tail + outcome poll combined).
  - On `402` with `{error:"insufficient_credits"}`: throw typed `InsufficientCreditsError`.
  - On any non-2xx: throw typed `ArgusApiError` with status + raw body.
- `streamEvents({ argusBaseUrl, apiKey, streamUrl, onEvent }): Promise<{ sawAgentEnd: boolean }>`:
  - Accept either absolute or relative `streamUrl` (backend returns a path).
  - Use `fetch` with no timeout; read `response.body` via `getReader()`.
  - Parse SSE frames (`event:`, `data:`, blank-line separator).
  - Call `onEvent({ event, data })` per frame.
  - Break (cleanly `reader.cancel()`) on `event === "agent_end"` and resolve with `sawAgentEnd: true`.
  - On `409` when establishing stream (no agent_session_id yet — paused sandbox being resumed can need 30–60s cold-boot): retry with exponential backoff `[1s, 2s, 4s, 8s, 16s, 30s]` (~60s total), then give up and resolve with `sawAgentEnd: false` so the orchestrator can fall through to full-run outcome polling.
  - On mid-stream disconnect without `agent_end`: resolve with `sawAgentEnd: false`.
- `pollOutcome({ argusBaseUrl, apiKey, sessionId, deadlineMs }): Promise<ArgusRunOutcomeResponse>`:
  - `GET ${argusBaseUrl}/api/v1/argus/sessions/${sessionId}`.
  - Retry loop, 1s backoff, until `Date.now() > deadlineMs`:
    - Transport error → continue.
    - HTTP ≥500 → continue.
    - HTTP 2xx + `status === "running"` → continue.
    - HTTP 2xx + terminal status → return.
  - **No default deadline.** Caller supplies it explicitly — see orchestrator wiring for the two distinct call-sites (post-`agent_end` flush window vs full-run fallback window).

#### 2. Types
**File:** `src/types.ts`
**Changes:** Mirror `RunArgusRequest`, `RunArgusResponse`, `ArgusRunOutcomeResponse`, `ArgusStatus` verbatim from `cope/be/api/argus/schemas.py`. Keep as structural types — no runtime validation beyond basic presence checks.

#### 3. SSE event formatter
**File:** `src/log-formatter.ts`
**Changes:**
- `formatEventLine({ event, data }): string` — short one-liner per event: `[event_type] <short summary>`. If `data` is JSON, pull a few well-known fields (`message`, `step`, `tool`, `url`) into the summary; otherwise print first 160 chars.
- In `main.ts`, wrap per-event output in `::group::<event_type>` / `::endgroup::` only for `tool_use`-style events where data is long; plain events go through `core.info`. Use `core.notice` for any `error`-shaped event.

#### 4. Orchestrator wiring
**File:** `src/main.ts`
**Changes:**
- `wait_mode === "no"`:
  - Call `startRun({ wait: "no" })`. Print `session_id` + `poll_url`. Set outputs. Exit 0.
- `wait_mode === "poll"` (default):
  - Record `actionStart = Date.now()`.
  - Call `startRun({ wait: "stream" })`. Set `session_id`/`instance_id`/`poll_url` outputs immediately so downstream steps can consume them even on failure.
  - Tail `streamEvents`, printing each via `formatEventLine`. Receive `{ sawAgentEnd }` from the promise.
  - After stream closes (or 409 fallback), branch on `sawAgentEnd`:
    - `sawAgentEnd === true` → `pollOutcome({ deadlineMs: Date.now() + 60_000 })`. Agent finished; 60s covers only the backend pydantic-flush race.
    - `sawAgentEnd === false` → `pollOutcome({ deadlineMs: actionStart + timeout_s * 1000 })`. Stream failed or disconnected pre-finish; give the agent the full `timeout_s` budget to actually reach a terminal state server-side.
  - Exit-code policy:
    - `fail_on === "failed"` AND `outcome.status !== "completed"` → `core.setFailed` with a short reason line.
    - `wait_mode === "no"` + `fail_on === "failed"`: exit 0 regardless. No outcome to judge.
    - `InsufficientCreditsError` → print `::error::ARGUS_INSUFFICIENT_CREDITS: <body>` (grep-able) and `core.setFailed`.
    - Any other `ArgusApiError` → print raw body under `::group::argus-error-body` and `core.setFailed`.

#### 5. Unit tests
**File:** `src/argus-client.test.ts`, `src/log-formatter.test.ts`
**Changes:**
- Mock `fetch` for `startRun` happy path + 402 + 500.
- `streamEvents` parser test using a canned SSE byte stream including mid-event chunk splits.
- `pollOutcome` tests: 5xx-then-200, running-then-completed, deadline-hit.
- `formatEventLine` snapshot-style tests for common event shapes.

### Success Criteria:

#### Automated Verification:
- [x] Unit tests pass: `npm test -- --run`
- [x] Typecheck passes: `npm run typecheck`
- [x] Bundle in sync: `npm run build && git diff --exit-code dist/`
- [x] Lint passes: `npm run lint`

#### Manual Verification:
- [ ] With a real `ARGUS_API_KEY` against `https://api.desplega.ai`, run the action locally against a known-stable URL (e.g. `https://desplega.ai`). Confirm:
  - SSE events stream to the local terminal in real time.
  - The loop breaks within a few seconds after `agent_end`.
  - The final outcome fetch succeeds and `status === "completed"`.
- [ ] With `wait_mode=no`, confirm the action returns immediately with `session_id` + `poll_url` and no stream tail.
- [ ] With a dummy/invalid API key, confirm 401 response surfaces a clean error.

### QA Spec (optional):

**Approach:** cli-verification
**Test Scenarios:**
- [ ] TC-1: Stream + outcome happy path
  - Steps: `ARGUS_API_KEY=... node dist/index.js` with `INPUT_BASE_URL=https://desplega.ai` and a trivial prompt.
  - Expected: SSE lines print, process exits 0, outcome status is `completed`.
- [ ] TC-2: Insufficient credits path
  - Steps: Use a known-throttled key (or mock via local proxy).
  - Expected: `::error::ARGUS_INSUFFICIENT_CREDITS:` line; exit 1.
- [ ] TC-3: Stream 409 fallback
  - Steps: Simulate by injecting 409 via a local mock; ensure action falls through to `pollOutcome` after 15s.
  - Expected: exit 0 when outcome eventually terminal.

**Implementation Note:** Pause after this phase for Taras to eyeball the SSE log format — it's user-facing and worth a gut check before freezing.

---

## Phase 4: PR comment rendering + step summary

### Overview

Turn the final `ArgusRunOutcomeResponse` into a single sticky PR comment (one per scenario, updated in place on re-runs) and a short verdict line in `$GITHUB_STEP_SUMMARY`.

### Changes Required:

#### 1. Comment rendering
**File:** `src/comment.ts`
**Changes:**
- `renderCommentBody({ scenario, outcome, sessionId, copeBaseUrl, runUrl }): string`:
  - Header line: `### ${scenario}: ${verdict}` where verdict = `✅ pass` for `completed`, `❌ fail` otherwise (emojis are fine here because they're markdown inside a PR comment, not code).
  - Meta line: session link (`${copeBaseUrl}/argus/sessions/${sessionId}`), duration (`elapsed_s`), tokens (`tokens_in + tokens_out`), credits (`credits_used`), triggered-from CI run link.
  - Collapsible `<details><summary>Agent report</summary>\n\n${report_md}\n\n</details>`.
  - Stable marker: HTML comment `<!-- argus-action:${scenario}${commentKey ? ':' + commentKey : ''} -->` at the top — used to find + update prior comment. The optional `comment_key` input disambiguates when the same scenario runs against multiple `base_url`s on one PR (e.g. preview env vs staging). Without `comment_key`, the marker collapses to the ticket's original `<!-- argus-action:${scenario} -->`.
  - If `report_md` empty, surface `error` field; if both empty, include a "no report" line.
- `copeBaseUrl` derivation: default to the `argus_base_url` input with `api.` stripped (e.g. `https://api.desplega.ai` → `https://desplega.ai`). Expose an override input `cope_ui_base_url` for non-prod deploys.

#### 2. Sticky comment upsert
**File:** `src/comment.ts`
**Changes:**
- `upsertPrComment({ octokit, context, marker, body }): Promise<string>` (returns `comment_url`):
  - Skip if `context.payload.pull_request` is missing (e.g. running on push); log an `::notice::` and return empty.
  - List comments via `octokit.paginate(octokit.rest.issues.listComments, ...)` (paginate — PRs with >100 comments otherwise miss the marker and duplicate).
  - Find the most recent one containing `marker` authored by the current token's user (compare via `github.rest.users.getAuthenticated` once and cache).
  - If found → `issues.updateComment`. Else → `issues.createComment`.
  - **403 handling:** if listing/creating/updating returns 403, emit `core.warning("argus-action: failed to post PR comment (HTTP 403). Consumer workflow likely missing 'permissions: pull-requests: write'. See README.")` and resolve with `''` instead of throwing — we still want the job outcome (pass/fail) to reflect the agent run, not the comment-posting permission failure.
  - Return `comment.html_url`.

#### 3. Step summary
**File:** `src/step-summary.ts`
**Changes:**
- `writeStepSummary({ scenario, outcome, sessionUrl })` — short 1-2 line markdown: `**Argus — ${scenario}**: ${verdict}` + session link. Uses `core.summary.addRaw().write()`.

#### 4. Orchestrator wiring
**File:** `src/main.ts`
**Changes:**
- After outcome is final (Phase 3), if `comment_on_pr === true` → `upsertPrComment`. Set `comment_url` output.
- Always `writeStepSummary`.
- On `fail_on=never` + non-pass: still post comment, still exit 0.

#### 5. Unit tests
**File:** `src/comment.test.ts`
**Changes:**
- Rendering: pass / fail / error / timed_out / empty-report variants snapshot.
- `copeBaseUrl` derivation from `argus_base_url`.
- Upsert logic with mocked Octokit: create path, update path, no-PR path.

### Success Criteria:

#### Automated Verification:
- [x] Unit tests pass: `npm test -- --run`
- [x] Typecheck passes: `npm run typecheck`
- [x] Lint passes: `npm run lint`
- [x] Bundle in sync: `npm run build && git diff --exit-code dist/`

#### Manual Verification:
- [ ] In a throwaway test PR, trigger the action and confirm a single sticky comment appears with:
  - Correct header + verdict.
  - Meta line with clickable session URL, duration, tokens, credits.
  - Collapsible report body.
  - Screenshot image (embedded via presigned URL in `report_md`) renders inline **without** the reviewer clicking anything.
- [ ] Re-run the same scenario on the same PR — confirm the comment is **updated in place**, not duplicated.
- [ ] Run a second scenario on the same PR — confirm a **separate** sticky comment appears (different marker).
- [ ] `fail_on=never` with a failing scenario: confirm job stays green AND comment shows fail verdict.
- [ ] `$GITHUB_STEP_SUMMARY` on the run overview page shows the verdict line.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Inline screenshot renders
  - Steps: Run smoke scenario that produces a screenshot; inspect PR comment.
  - Expected: Image visible without clicking; `<details>` open/close still works.
- [ ] TC-2: Sticky update, not duplicate
  - Steps: Run scenario twice on same PR.
  - Expected: Exactly one comment with `<!-- argus-action:smoke-login -->`; `updated_at` moved forward.

**Implementation Note:** Pause after this phase for Taras to eyeball the rendered comment in a live PR — this is the most user-visible artifact of the whole project.

---

## Phase 5: Reusable workflow + example callers + example scenarios

### Overview

Expose the action as a reusable workflow (`workflow_call` + `workflow_dispatch`) for repos that prefer "uses: workflow" ergonomics. Ship two example caller workflows and two example scenario files as living docs that double as this repo's own E2E harness.

### Changes Required:

#### 1. Reusable workflow
**File:** `.github/workflows/argus-pr.yaml`
**Changes:**
- Triggers: `workflow_call` (full input list mirroring action inputs, minus the `github_token` one), `workflow_dispatch` (same inputs, no secrets).
- Secrets: `ARGUS_API_KEY` declared as `required: true` under `workflow_call.secrets`.
- **Workflow-level `concurrency:` block:** `group: argus-${{ inputs.scenario }}${{ inputs.comment_key && format('-{0}', inputs.comment_key) || '' }}-${{ github.ref }}`, `cancel-in-progress: true`. Rapid PR pushes (push + immediate fixup) otherwise queue multiple Argus runs on stale commits and burn credits. Scenario + `comment_key` are in the group so parallel scenarios/keys on one PR don't cancel each other.
- One job `run`:
  - `runs-on: ubuntu-latest`
  - `permissions: { contents: read, pull-requests: write }` (for comment upsert).
  - `steps`: `actions/checkout@v4`, then `uses: ./` (when called from this repo) or `uses: <owner>/argus-action@v1` (documented but not used here — the workflow file here defaults to `./` and README shows the `@v1` form for external consumers).
  - Pass inputs through 1:1; inject `ARGUS_API_KEY` via `env`.

#### 2. Example caller — smoke
**File:** `.github/workflows/argus-smoke-example.yaml`
**Changes:**
- Triggers: `workflow_dispatch` + optionally `pull_request` with a comment explaining it's an example.
- Calls `./.github/workflows/argus-pr.yaml` with `scenario: smoke-login`, `base_url` pulled from a job-level env var (commented examples showing: output from another job, hardcoded staging URL, secret).
- `fail_on: failed` (default; shows smoke-test shape).

#### 3. Example caller — explore on label
**File:** `.github/workflows/argus-explore-on-label.yaml`
**Changes:**
- Trigger: `pull_request` with `types: [labeled]`.
- `if: github.event.label.name == 'run-argus'` guard.
- Calls reusable workflow with `scenario: pr-explore`, `fail_on: never`, `wait_mode: poll`, `extra_vars: '{"PR_BODY": ${{ toJSON(github.event.pull_request.body) }}}'` (note `toJSON` for safe embedding).

#### 4. Example scenarios
**Files:** `.github/argus-scenarios/smoke-login.md`, `.github/argus-scenarios/pr-explore.md`
**Changes:**
- `smoke-login.md`: follows the ticket's example verbatim — opens `${BASE_URL}`, attempts login, reports pass/fail, instructs screenshot-as-presigned-URL.
- `pr-explore.md`: instructs agent to read `${PR_BODY}`, derive a likely user flow from it, exercise it against `${BASE_URL}`, report anything broken. Includes the same screenshot/presigned-URL instruction.

### Success Criteria:

#### Automated Verification:
- [x] All three workflow YAMLs parse as valid workflow syntax: `npx @github/actionlint-action` locally, or `actionlint` via pre-commit.
- [x] YAML parses: `python -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/argus-pr.yaml', '.github/workflows/argus-smoke-example.yaml', '.github/workflows/argus-explore-on-label.yaml']]"`
- [x] Scenario files parse as markdown + contain all referenced `${VAR}` tokens that the action will substitute: `npm test -- --run scenarios.test.ts` (a new test that runs each scenario through `substitute()` with built-ins + expected extras and asserts no unresolved tokens).

#### Manual Verification:
- [ ] On a test PR: manually trigger `argus-smoke-example` via `workflow_dispatch`, confirm sticky comment appears.
- [ ] On a test PR: apply `run-argus` label, confirm `argus-explore-on-label` fires and posts a comment.
- [ ] Remove + re-apply label, confirm comment is updated (not duplicated).

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Label-gated explore
  - Steps: Create PR, apply `run-argus` label.
  - Expected: Workflow runs, comment appears with explore report referencing PR body.
- [ ] TC-2: `workflow_dispatch` manual smoke
  - Steps: UI → Actions → argus-smoke-example → Run workflow with `base_url=https://desplega.ai`.
  - Expected: Job green, comment with `smoke-login: ✅ pass`.

**Implementation Note:** Pause after this phase for Taras to run the two examples on a real test PR against `api.desplega.ai` before moving to CI + docs.

---

## Phase 6: Self-test CI + docs + release hygiene

### Overview

Protect the repo from regressions (dist drift, lint/typecheck breakage, YAML invalidity), document the action for consumers, and set up tagging discipline (`v1` moving tag + semver tags).

### Changes Required:

#### 1. Self-test CI
**File:** `.github/workflows/ci.yaml`
**Changes:**
- Triggers: `pull_request`, `push` to `main`.
- Job `verify`:
  - `actions/setup-node@v4` with `node-version-file: .nvmrc`.
  - `npm ci`
  - `npm run lint`
  - `npm run typecheck`
  - `npm test -- --run`
  - `npm run build`
  - `git diff --exit-code dist/` — fail if bundle is stale.
- Job `actionlint`: `rhysd/actionlint@v1` (or equivalent) across all workflows + the action's own `action.yml`.

#### 2. Live integration smoke (optional, label-gated)
**File:** `.github/workflows/ci-integration.yaml`
**Changes:**
- Trigger: `pull_request` with `types: [labeled]`, `if: github.event.label.name == 'test-action-live'`.
- Uses this repo's own action against `https://desplega.ai` with a trivial scenario. Requires `ARGUS_API_KEY` secret in this repo's settings. Opt-in to avoid spending credits on every commit.

#### 3. README
**File:** `README.md`
**Changes:**
- Quick start: minimal consumer snippet (`uses: owner/argus-action@v1` with `scenario` + `base_url` + `ARGUS_API_KEY`).
- Inputs table (sourced from `action.yml`).
- Outputs table.
- Scenario file conventions (`.github/argus-scenarios/<name>.md`) + built-in fallback note.
- Variable substitution rules (built-ins list, `extra_vars` usage, unresolved-token failure).
- Reusable workflow usage snippet.
- Label-gated explore-mode snippet.
- **Required permissions for consumer workflows:** explicit block showing `permissions: { contents: read, pull-requests: write }`. Without `pull-requests: write`, comment posting returns 403 — the action logs a `::warning::` and continues, but consumers will see no comment.
- Troubleshooting section: 402 insufficient_credits, 401 auth, 403 missing `pull-requests: write`, missing PR context (running on `push` instead of `pull_request`), screenshots not rendering (presigned URL expired past 7 days — GitHub camo proxy normally caches on first render, so the fix is to view the comment within the window).
- **Marketplace note:** `action.yml` sits at the repo root specifically so this action is publishable to GitHub Marketplace (which requires root-level manifests). This is the primary reason for deviating from the ticket's `.github/actions/argus-run/` path.

#### 4. Action-level README (ticket requirement)
**File:** `.github/actions/argus-run/README.md` (stub that re-points to root README) — satisfies the ticket's explicit requirement without duplicating content.
**Changes:** Single line: "See repo root [`README.md`](../../../README.md)."

#### 5. Release automation
**File:** `.github/workflows/release.yaml`
**Changes:**
- Trigger: `push` of tags matching `v*.*.*`.
- Job: re-point `v1` major tag to the pushed SHA using `actions/publish-action` or a simple `git tag -f v1 && git push --force origin v1` script. Document the flow in README.

#### 6. Licensing + metadata
**Files:** `LICENSE` (MIT unless Taras prefers otherwise), `CODEOWNERS`, `CHANGELOG.md` (initial `## v1.0.0 — 2026-04-16`).

### Success Criteria:

#### Automated Verification:
- [ ] `ci.yaml` passes on its own first PR: `gh run watch` after pushing.
- [x] `actionlint` finds no issues: `actionlint` locally.
- [x] Bundle-drift guard works: `echo "// noise" >> src/main.ts && npm run build` produces a diff that CI would catch. (Revert the noise after testing.)
- [x] YAML lint across workflows passes: `yamllint .github/workflows/`.

#### Manual Verification:
- [ ] Tag `v1.0.0`, confirm release workflow moves `v1` to the new SHA.
- [ ] Consume the action from a separate test repo via `uses: <owner>/argus-action@v1` — confirm it works without any repo-local pinning.
- [ ] README renders correctly on github.com (relative links, code blocks, table formatting).

**Implementation Note:** Final phase. After verification, Taras decides when to publish `v1`. No commit per phase unless preference was set.

---

## Testing Strategy

**Unit (vitest):**
- `template.ts` — substitution + resolution edge cases.
- `argus-client.ts` — `fetch`-mocked success/failure/retry paths for all three methods.
- `log-formatter.ts` — event shape → log-line snapshots.
- `comment.ts` — render variants + octokit-mocked upsert.
- `scenarios.test.ts` — ensure shipped scenario files + default prompt render with expected context with zero unresolved tokens.

**Integration (manual, credit-costing):**
- E2E against `https://api.desplega.ai` with `ARGUS_API_KEY`:
  - `smoke-login` on a known stable URL → pass.
  - A deliberately-impossible scenario (e.g. "log in with user that doesn't exist") + `fail_on=never` → comment shows fail, job green.
  - Invalid API key → grep-able 401 error in logs, job red.
  - `wait_mode=no` → session_id printed, job exits 0.

**CI:**
- Lint + typecheck + unit tests + bundle-drift on every PR.
- `actionlint` on every PR.
- Label-gated live integration test (`test-action-live`) for maintainer-triggered credit-spending smoke.

---

## Manual E2E

Run from a throwaway consumer repo (or `workflow_dispatch` on this repo's example workflows), with a real `ARGUS_API_KEY` in repo secrets. Each command line below is the concrete `gh` or browser action:

1. **Happy-path smoke.**
   - `gh workflow run argus-smoke-example.yaml -f base_url=https://desplega.ai`
   - Expect: comment `smoke-login: ✅ pass` on the PR with inline screenshots; job green.
2. **Failing smoke (required-check shape).**
   - Point `base_url` at a URL that guarantees failure (e.g. a non-existent subdomain).
   - `fail_on: failed` (default).
   - Expect: `smoke-login: ❌ fail`; job red; `$GITHUB_STEP_SUMMARY` shows fail line.
3. **Explore on label, informational.**
   - Apply `run-argus` label to a PR.
   - Expect: `pr-explore` comment with exploratory report; job green even on issues found (`fail_on: never`).
4. **Fire-and-forget.**
   - `gh workflow run argus-pr.yaml -f scenario=smoke-login -f base_url=https://desplega.ai -f wait_mode=no`
   - Expect: job prints `session_id` + `poll_url`, no stream tail, no PR comment, exit 0.
5. **Insufficient credits.**
   - Use a throttled test key or simulate via a sandboxed `argus_base_url`.
   - Expect: `::error::ARGUS_INSUFFICIENT_CREDITS:` line in log; job red.
6. **Overridden `argus_base_url`.**
   - `gh workflow run argus-pr.yaml -f scenario=smoke-login -f base_url=https://desplega.ai -f argus_base_url=https://staging-api.desplega.ai`
   - Expect: identical behavior to prod against the staging backend.
7. **Sticky-comment update.**
   - Run smoke twice in a row.
   - Expect: exactly one comment with marker `<!-- argus-action:smoke-login -->`, `updated_at` advanced.
8. **Two scenarios coexist.**
   - Run `smoke-login` then `pr-explore` on the same PR.
   - Expect: two distinct sticky comments, one per marker.

---

## References

- **Backend endpoint:** `/Users/taras/Documents/code/cope/be/api/argus/public.py`
- **Request/response schemas:** `/Users/taras/Documents/code/cope/be/api/argus/schemas.py`
- **Python smoke reference (SSE early-break + poll race):** `/Users/taras/Documents/code/cope/be/random_argus_api_v1_smoke.py`
- **Manual E2E playbook for the backend endpoint:** `/Users/taras/Documents/code/cope/e2e/argus-api.md`
- **GitHub Actions TypeScript template conventions:** `actions/typescript-action` (publicly published by GitHub)
- **`@vercel/ncc`:** https://github.com/vercel/ncc (for single-file bundling)
- **Ticket (source of truth):** pasted in full into this plan's invocation.

---

## Review Errata

_Reviewed: 2026-04-16 by Claude (desplega:reviewing, autopilot)_

### Resolved (applied to plan body)

- [x] **C1 — Outcome-poll deadline now branches on whether `agent_end` was seen.** Phase 3 updated: `streamEvents` returns `{ sawAgentEnd }`; `pollOutcome` requires caller-supplied `deadlineMs`; orchestrator passes 60s when `sawAgentEnd` is true (flush race only), and `actionStart + timeout_s * 1000` when it is false (full run budget for the fallback path).
- [x] **I1 — Consumer permissions documented + runtime 403 guidance.** Phase 4 `upsertPrComment` catches 403 and emits a `core.warning` pointing at the missing `permissions: pull-requests: write`. Phase 6 README quick-start now includes the explicit permissions block and a troubleshooting entry.
- [x] **I2 — Sticky marker now keyed on `scenario + comment_key`.** Added `comment_key` input (default `''`) to Phase 1 action manifest. Phase 4 marker becomes `<!-- argus-action:${scenario}${commentKey ? ':' + commentKey : ''} -->`. Collapses to the original form when `comment_key` is empty (ticket-compatible default).
- [x] **I3 — `timeout_s` is no longer sent to the backend.** Phase 3 `startRun` body is `{ prompt, wait, behavior_mode }`. `timeout_s` is used purely as the action's local wall-clock budget and feeds directly into C1's run-fallback deadline.
- [x] **I4 — `concurrency:` guard added to reusable workflow.** Phase 5 now specifies `group: argus-${inputs.scenario}${inputs.comment_key ? '-' + inputs.comment_key : ''}-${github.ref}` with `cancel-in-progress: true`. Parallel scenarios / comment_keys on one PR don't cancel each other; rapid pushes to the same ref do.
- [x] **I5 — 409 retry budget extended to ~60s exponential backoff.** Phase 3 `streamEvents`: `[1s, 2s, 4s, 8s, 16s, 30s]` before falling through. Accommodates paused-sandbox cold-boot. When it does fall through, C1's run-fallback deadline takes over rather than the 60s flush window.

### Resolved (auto-fixed)

- [x] **M1 — Frontmatter missing `planner` + `topic` per template convention.** Added.
- [x] **M2 — `wait_mode=no` + `fail_on=failed` behavior unspecified.** Added explicit "exit 0 regardless; no outcome to judge" line in Phase 3 exit-code policy.
- [x] **M3 — Presigned URL 7-day expiry not documented.** Added to "What We're NOT Doing" with note on GitHub camo proxy caching behavior.
- [x] **Pagination for listComments.** Folded into the I1 fix on Phase 4 `upsertPrComment` — now uses `octokit.paginate` so PRs with >100 comments don't miss the sticky marker.

### Remaining minor findings (not auto-applied — optional polish)

- [ ] **M4 — No pre-commit hook for dist rebuild.** `git diff --exit-code dist/` in CI catches forgotten rebuilds, but only after push. Consider adding husky + a `pre-commit` that runs `npm run build && git add dist/`. Low-priority.
- [ ] **M5 — Comment listing pagination not addressed.** Phase 4's `listComments` call doesn't paginate. PRs with >100 comments would miss the sticky marker and duplicate. Use `octokit.paginate(octokit.rest.issues.listComments, ...)`.
- [ ] **M6 — Template substitutor edge case.** Add explicit test that `${VAR:-default}` (shell-style defaulting) inside example scripts is left untouched by the `${KEY}` substitutor.
- [ ] **M7 — Rationale for env-var-vs-input secret could be tighter.** The "prevents accidental logging" reason is weak because `core.setSecret(getInput('argus_api_key'))` would mask it anyway. Stronger reasons: (a) GitHub convention (e.g. `GITHUB_TOKEN` via env), (b) easier multi-step composition where several steps need the same secret.
- [ ] **M8 — Several Manual E2E steps lack concrete commands.** TC-2/3/5/7/8 describe actions in prose. Adding specific `gh` commands (or explicit UI click paths) would make them runnable without interpretation.
- [ ] **M9 — Mention Marketplace publishing requirement in Phase 6.** `action.yml` at repo root is a hard requirement for Marketplace listing — another strong reason for the root-layout deviation from the ticket. Documenting this reinforces the design choice.

### Sanity-check of flagged deviations

- **Action at repo root vs `.github/actions/argus-run/`:** rationale is sound — standalone action repos consistently use root placement, and Marketplace publishing requires it (see M9). Recommendation unchanged: keep root layout, note the ticket path in Phase 6's README as the "if you fork into a multi-action monorepo" alternative.
- **`ARGUS_API_KEY` via env vs input:** rationale as-stated is weak (see M7), but the *outcome* is still correct. The convention alignment with `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` is the real reason. Recommendation: keep env-var, strengthen the rationale in the code comment / README.

### Coverage against ticket acceptance criteria

| AC | Where addressed | Status |
|---|---|---|
| Reusable workflow + composite action, CI green | Phase 5 + Phase 6 | ✓ |
| Two example workflows | Phase 5 | ✓ |
| Two example scenarios | Phase 5 | ✓ |
| E2E with only `ARGUS_API_KEY` | Manual E2E section | ✓ |
| PR comment with inline screenshots | Phase 4 + E2E TC-1 | ✓ (subject to C1/I5 on reliability) |
| Streamed SSE events in job log | Phase 3 | ✓ |
| `fail_on=never` verified on failing scenario | Testing Strategy + E2E | ✓ |
| 402 `insufficient_credits` grep-able | Phase 3 + E2E TC-5 | ✓ |
| `argus_base_url` override works identically | E2E TC-6 | ✓ |

No acceptance criterion is left uncovered. C1/I1–I5 are correctness and robustness gaps *within* already-covered areas.
