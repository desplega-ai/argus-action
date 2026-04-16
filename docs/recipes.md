# Recipes: using argus-action with preview-deployment providers

The action needs a concrete `base_url` to hand to the agent. Most preview-deployment providers (Vercel, Netlify, Cloudflare Pages, etc.) publish the PR preview URL through a GitHub deployment event, a status check, or a PR comment. This document shows how to plumb that URL into `argus-action` for the common providers.

**Two universal rules before any recipe:**

1. The Argus job needs `permissions: pull-requests: write` to post the sticky comment.
2. The preview URL must be **ready before Argus runs**. All providers below take seconds-to-minutes to publish a preview. Gate the Argus job with a "wait for deployment" step rather than racing.

---

## Vercel

Vercel publishes a deployment event per PR. The cleanest pattern is to wait for the `Preview – <project>` deployment, grab its URL, and pass it in.

```yaml
# .github/workflows/argus-vercel.yaml
name: Argus (Vercel preview)

on:
  pull_request:

jobs:
  argus:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      deployments: read
    steps:
      - uses: actions/checkout@v4

      - name: Wait for Vercel preview
        id: vercel
        uses: patrickedqvist/wait-for-vercel-preview@v1.3.2
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          max_timeout: 600
          check_interval: 10

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.vercel.outputs.url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

**Notes**

- `steps.vercel.outputs.url` is the fully-qualified preview URL (e.g. `https://my-app-git-feat-x-acme.vercel.app`).
- If you deploy multiple Vercel projects from one monorepo, add `environment: preview` + a project filter — see the action's own README.
- Prefer a Vercel PR comment parser only if you specifically need the production alias; the deployment event path is more reliable.

### Deployment Protection (bypass)

Vercel previews sit behind **Deployment Protection** by default on Pro/Enterprise plans — the agent hits Vercel's auth wall before your app ever renders. `argus-action` supports **query-param bypass only** today.

1. In Vercel → Project → Settings → Deployment Protection → **Protection Bypass for Automation**, generate a secret.
2. Store it as a repo secret (e.g. `VERCEL_AUTOMATION_BYPASS_SECRET`).
3. Append it to `base_url`. Include `x-vercel-set-bypass-cookie=true` so Vercel issues a redirect with `Set-Cookie` on the first request, and the agent's follow-up navigation inherits the bypass instead of re-hitting the wall on every link click:

```yaml
      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.vercel.outputs.url }}/?x-vercel-protection-bypass=${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}&x-vercel-set-bypass-cookie=true
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

> **Header-based bypass** (sending `x-vercel-protection-bypass` as a request header, keeping the secret out of the URL) is not wired through the action yet — email `t@desplega.ai` if you need it for your workspace.

---

## Netlify

Two flavors. Pick based on whether you deploy from GitHub Actions or via Netlify's own GitHub App.

### A. Netlify GitHub App (most common)

```yaml
      - name: Wait for Netlify preview
        id: netlify
        uses: jakepartusch/wait-for-netlify-action@v1.4
        with:
          site_name: my-netlify-site-name
          max_timeout: 300

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.netlify.outputs.url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

### B. Deploy from inside GitHub Actions

Capture the deploy URL from `nwtgck/actions-netlify` output and pass it through:

```yaml
      - name: Deploy to Netlify
        id: netlify
        uses: nwtgck/actions-netlify@v3
        with:
          publish-dir: ./dist
          deploy-message: 'PR #${{ github.event.pull_request.number }}'
        env:
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.netlify.outputs.deploy-url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

---

## Cloudflare Pages

Cloudflare Pages publishes a deployment event, just like Vercel. Use the generic deployment watcher:

```yaml
      - name: Wait for Cloudflare Pages
        id: cfp
        uses: WalshyDev/cf-pages-await@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          project: my-pages-project
          commitHash: ${{ github.event.pull_request.head.sha }}

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.cfp.outputs.url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

---

## Fly.io (preview apps)

Fly's `superfly/fly-pr-review-apps` emits the app hostname. Use it directly:

```yaml
      - uses: superfly/fly-pr-review-apps@v1
        id: fly
        with:
          secrets: ${{ secrets.FLY_API_TOKEN }}

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: https://${{ steps.fly.outputs.name }}.fly.dev
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

---

## Render

Render publishes the preview URL via a PR comment. Parse it or, more robustly, use the Render API:

```yaml
      - name: Resolve Render preview
        id: render
        run: |
          URL=$(curl -sS -H "Authorization: Bearer ${{ secrets.RENDER_API_KEY }}" \
            "https://api.render.com/v1/services/${{ secrets.RENDER_SERVICE_ID }}/deploys?limit=1" \
            | jq -r '.[0].deploy.serviceUrl // empty')
          echo "url=$URL" >> "$GITHUB_OUTPUT"

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.render.outputs.url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

---

## Railway

Railway PR environments expose their URL via the Railway CLI:

```yaml
      - name: Resolve Railway preview
        id: railway
        run: |
          npm i -g @railway/cli
          URL=$(railway environment --json | jq -r '.url')
          echo "url=$URL" >> "$GITHUB_OUTPUT"
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.railway.outputs.url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

---

## Generic: any provider that creates a GitHub deployment

If your provider writes to the GitHub Deployments API (most do), `bobheadxi/deployments` + a polling loop works universally without a provider-specific action:

```yaml
      - name: Wait for deployment
        id: wait
        uses: bobheadxi/deployments@v1
        with:
          step: wait-for
          token: ${{ secrets.GITHUB_TOKEN }}
          env: preview
          ref: ${{ github.event.pull_request.head.sha }}
          timeout: 600

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.wait.outputs.url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

---

## Deployment protection (other providers)

The same class of problem — provider-level auth blocking the agent before your app loads — applies to more than just Vercel. Current status:

- **Vercel Deployment Protection** — query-param bypass supported today. See [Vercel § Deployment Protection (bypass)](#deployment-protection-bypass) above.
- **Cloudflare Access (Zero Trust)** — needs `CF-Access-Client-Id` + `CF-Access-Client-Secret` request headers. The action does not pass custom headers through to the agent's browser yet — email `t@desplega.ai` if you need it.
- **Netlify password protection / Cloudflare Pages Access** — same header-only story. Roadmap; email `t@desplega.ai`.

Working around it in the meantime: configure the preview to be public for Argus runs (e.g. a dedicated preview environment without protection), or rely on an app-level login the agent can perform itself — pass credentials via `extra_vars` and write a prompt template that tells the agent to sign in first.

---

## Pulling the preview URL from a PR comment

If your provider posts the URL as a PR comment (and nowhere else), parse it:

```yaml
      - name: Parse preview URL from PR comments
        id: parse
        uses: actions/github-script@v7
        with:
          script: |
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              per_page: 100,
            });
            const regex = /https:\/\/[a-z0-9-]+\.vercel\.app/i; // tweak per provider
            const hit = comments.reverse().map(c => c.body).map(b => b?.match(regex)?.[0]).find(Boolean);
            if (!hit) throw new Error('No preview URL found in PR comments');
            core.setOutput('url', hit);

      - uses: desplega-ai/argus-action@v1
        with:
          scenario: smoke-login
          base_url: ${{ steps.parse.outputs.url }}
        env:
          ARGUS_API_KEY: ${{ secrets.ARGUS_API_KEY }}
```

---

## Tips that apply everywhere

- **Don't run Argus on draft PRs** — add `if: github.event.pull_request.draft == false` on the job.
- **Avoid `workflow_run` chaining** unless you need it — `pull_request` with a wait-for-deployment step is simpler and has PR context available for the sticky comment.
- **`concurrency:`** the job on `github.ref` with `cancel-in-progress: true` so rapid pushes don't fan out and burn credits. The reusable workflow already does this for you.
- **Token authorship for the sticky comment.** The default `${{ github.token }}` posts as `github-actions[bot]`. If you want the comment authored by a named bot, pass a PAT via `github_token:` — note it also needs `pull-requests: write`.
- **Fork PRs.** Secrets are not exposed to fork-opened PRs with the `pull_request` trigger. If you need Argus on fork PRs, gate on a maintainer-applied label (see the label-gated example in the root README) or use `pull_request_target` with the usual caveats.
