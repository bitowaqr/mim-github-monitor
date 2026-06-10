# GitHub Monitor — a Mim package

Org-wide GitHub overview inside Mim: every issue, pull request, project board,
and activity event across all repositories of an organization, with filtering,
saved views, a board layout, an activity feed, and AI-written "who did what"
summaries for any timeframe.

## Install

Clone into your Mim workspace's `packages/` folder and enable it from the Apps UI:

```sh
cd {workspace}/packages
git clone https://github.com/bitowaqr/mim-github-monitor github-monitor
```

## Setup

1. Open the **GitHub** view in Mim and hit **Settings**.
2. Paste a GitHub **classic personal access token** with scopes
   `repo`, `read:org`, `read:project` (or `project`)
   (create one at github.com/settings/tokens). The token is stored in the OS
   keychain — it never touches a file and is never shown again.
3. Enter your organization name, optionally narrow the repository list, and
   pick a summary model (defaults to the workspace chat model).
4. **Save & full re-sync**.

## What it does

- **Sync** (incremental, resumable): repositories, all currently open issues +
  PRs, recently closed items in the sync window, GraphQL search time-range
  bisection around GitHub's 1,000-result search cap, the org activity feed via
  REST with ETags, and ProjectsV2 board statuses denormalized onto items.
- **Views**: built-ins (all items, open issues, open PRs, recently closed,
  activity feed) plus saved views; list and board layouts; filter by type,
  state, repo, person, label, project status, or free text.
- **Summaries**: "this week, who did what?" — globally or per person, with an
  optional focus note. Large timeframes are map-reduced per repository through
  the workspace AI model; reports land in `reports/github/` as markdown.
- **Chat tool**: `summarizeActivity` lets the workspace agent kick off a
  summary for any timeframe.

## Permissions (manifest)

| Permission | Why |
| --- | --- |
| `http: ["api.github.com"]` | the only host the backend may call |
| `secrets: ["github_token"]` | keychain slot for the PAT |
| `workspace: read/write` | writes summary reports into the workspace |
| `ai: true` | generates summaries via the workspace model registry |

All synced data is a disposable local cache (package collections); deleting it
just means the next sync rebuilds it.

## Development

```sh
npm install
npm test        # vitest — backend logic runs against a fake runtime ctx
```

Backend modules are plain ESM with the runtime `ctx` injected, so everything
(sync engine, bisection, rate-limit handling, summarizer) is unit-tested
without network or Electron. See `docs/plan.md` for the full design.
