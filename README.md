# argus-action

Run an [Argus](https://desplega.ai) agent session against a target URL on pull requests and post the resulting report as a sticky PR comment.

One action, two use cases without a rewrite:

- **Deterministic smoke test** — canned prompt, fails the job on non-pass (good for required checks).
- **Exploratory agent run** — "try X, tell us if anything looks broken" (informational; `fail_on: never`).

## Quick start

```yaml
# .github/workflows/argus-smoke.yaml
name: Argus smoke
on:
  pull_request:

jobs:
  argus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: <owner>/argus-action@v1
        with:
          scenario: smoke-login
          base_url: https://preview.example.com/pr-${{ github.event.pull_request.number }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

The only required secret is `ARGUS_API_KEY`. Everything else is an input.

> **Permissions.** The action upserts a PR comment, which requires `pull-requests: write` on the consuming workflow. Without it the action logs a `::warning::` and continues — the job still reflects the agent outcome.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `scenario` | no | `argus` | Scenario identifier. Also used as the sticky-comment marker key. When no scenario file / `prompt_template` / `prompt_template_file` is provided, the built-in `DEFAULT_PROMPT` is used. |
| `base_url` | yes | — | Target URL the agent will exercise. Substituted as `${BASE_URL}` in the prompt. |
| `prompt_template` | no | `''` | Inline prompt body. Overrides `prompt_template_file` and scenario file lookup. |
| `prompt_template_file` | no | `''` | Path (relative to workspace) to a prompt template file. |
| `argus_base_url` | no | `https://api.desplega.ai` | Argus backend base URL. |
| `cope_ui_base_url` | no | derived | UI base URL used in the PR comment's session link. Defaults to `argus_base_url` with a leading `api.` stripped. |
| `extra_vars` | no | `{}` | JSON object of additional `${VAR}` values merged over the built-ins. |
| `wait_mode` | no | `poll` | `poll` (stream + poll outcome) or `no` (fire-and-forget). |
| `timeout_s` | no | `900` | Local wall-clock budget (seconds) for the stream-fallback outcome poll. |
| `behavior_mode` | no | `api` | Argus `behavior_mode`: `autonomous` or `api`. |
| `fail_on` | no | `failed` | `failed` fails the job on non-pass; `never` keeps the job green. |
| `comment_on_pr` | no | `true` | When `true`, upserts a sticky PR comment with the agent report. |
| `comment_key` | no | `''` | Optional discriminator appended to the comment marker. Use when the same scenario runs against multiple `base_url`s on one PR. |
| `github_token` | no | `${{ github.token }}` | Token used to post the PR comment. |

`ARGUS_API_KEY` is read from `env`, **not** from `with:` inputs — following the same convention as `GITHUB_TOKEN`.

## Outputs

| Output | Description |
|--------|-------------|
| `session_id` | Argus session id. |
| `instance_id` | Argus instance id. |
| `poll_url` | Full URL for polling the session outcome. |
| `outcome_status` | Terminal status (`completed \| aborted \| failed \| error \| timed_out`) or empty for `wait_mode=no`. |
| `comment_url` | URL of the upserted PR comment, or empty. |

## Prompt templates and variable substitution

The action resolves the prompt body in this order:

1. `prompt_template` (inline) if non-empty.
2. `prompt_template_file` if non-empty, resolved relative to the workspace.
3. `.github/argus-scenarios/<scenario>.md` if it exists.
4. A built-in default prompt (logged via `::notice::`).

The body is then substituted through a strict `${VAR}` substitutor. Only upper-case tokens `${[A-Z0-9_]+}` are touched — shell-style `${var:-default}` inside example scripts is left alone.

**Built-in variables:**

- `${BASE_URL}` — `base_url` input.
- `${PR_NUMBER}` — pull request number or `''`.
- `${BRANCH}` — PR head ref or current branch.
- `${COMMIT_SHA}` — PR head SHA or `GITHUB_SHA`.
- `${REPO}` — `owner/name`.
- `${RUN_URL}` — URL of the current workflow run.

Add anything else via `extra_vars` (JSON object). Overrides win over built-ins. Any unresolved `${VAR}` tokens fail the action with a message listing every offender.

## Reusable workflow

For consumer repos that prefer `uses: workflow` ergonomics, a reusable workflow is shipped at `.github/workflows/argus-pr.yaml`:

```yaml
jobs:
  argus:
    uses: <owner>/argus-action/.github/workflows/argus-pr.yaml@v1
    with:
      scenario: smoke-login
      base_url: https://preview.example.com/pr-${{ github.event.pull_request.number }}
    secrets:
      ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

The reusable workflow runs at most one instance per `(scenario, comment_key, ref)` tuple (rapid PR pushes cancel in flight).

## Label-gated explore mode

```yaml
on:
  pull_request:
    types: [labeled]

jobs:
  explore:
    if: github.event.label.name == 'run-argus'
    uses: <owner>/argus-action/.github/workflows/argus-pr.yaml@v1
    with:
      scenario: pr-explore
      base_url: https://preview.example.com/pr-${{ github.event.pull_request.number }}
      fail_on: never
      extra_vars: '{"PR_BODY": ${{ toJSON(github.event.pull_request.body) }}}'
    secrets:
      ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

## Troubleshooting

- **`ARGUS_INSUFFICIENT_CREDITS:`** — Workspace is out of credits. Look for this exact prefix in the job log; top up and re-run.
- **401 Unauthorized** — `ARGUS_API_KEY` is missing, mistyped, or revoked.
- **403 when posting the comment** — Consumer workflow is missing `permissions: pull-requests: write`. The action emits a `::warning::` and continues, but no comment appears until the permission is added.
- **No comment appears** — Likely one of: workflow triggered on `push` instead of `pull_request` (no PR context), `comment_on_pr: false`, or the 403 case above.
- **Screenshots look broken on old comments** — Screenshot URLs are S3 presigned URLs with a 7-day expiry. GitHub's camo proxy normally caches images on first render, so fresh comments are unaffected. If you open a stale PR after a week, images may appear broken — re-run the action to refresh.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test -- --run
npm run build
```

The bundled entrypoint at `dist/index.js` is committed — CI fails if `git diff --exit-code dist/` is non-empty after a build.

## Releasing

- Push a semver tag (`v1.2.3`). The `release.yaml` workflow re-points the `v1` moving tag to the pushed SHA so consumers pinned at `@v1` pick up the release.

## Why `action.yml` at the repo root?

This is a dedicated standalone action repo. GitHub Marketplace requires `action.yml` at the repo root, which also gives consumers the shorter `uses: <owner>/argus-action@v1` instead of `<owner>/argus-action/.github/actions/argus-run@v1`. The ticket's `.github/actions/argus-run/` path is preserved as a stub that re-points here — useful if this repo is ever forked into a multi-action monorepo layout.

## License

MIT — see [LICENSE](./LICENSE).
