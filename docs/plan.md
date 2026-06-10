# GitHub Monitor Package — Plan

Status: planned. Built and versioned in its own repository, installed by
cloning into `{workspace}/packages/github-monitor/`. Nothing in this repo
changes for it — the platform APIs it needs (`ctx.http`, `ctx.secrets`,
`runtime.secrets`) shipped with the package runtime.

## Goal

Monitor everything happening across all repositories of one GitHub
organization from inside Mim: issues, pull requests, project boards, and
activity, in a Linear-like surface with filtering, sorting, and saved views —
plus an agent that summarizes activity for a timeframe ("this week, who did
what?"), globally or per user.

## Positioning

- **Not a core feature.** It is an installable package; a workspace that never
  installs it carries zero code for it. This document is the build spec and
  the platform contract it relies on.
- **Read-only v1.** No creating or editing GitHub state from Mim. The fast
  path to value is seeing everything in one place; write flows are a later
  decision.
- **Polling, no webhooks.** Mim is a local desktop app with no public
  endpoint. Conditional requests (ETags) and incremental watermarks make
  polling cheap.

## Decisions

These are made; flag disagreement before milestone 1.

| Decision | Choice | Why |
|---|---|---|
| Auth | Personal access token v1, entered in the package UI via `runtime.secrets.set` | OAuth device flow needs a registered OAuth app (a client ID someone must own and ship). A PAT needs nothing and the keychain path already exists. Device flow can be added later without changing storage. |
| Summary model | Never hardcoded | `ctx.ai.generateObject({ modelId? })` already cascades: explicit id → workspace `config.yaml` chat default → registry default. The package passes its optional `summaryModel` setting (package kv, set in its UI) or nothing at all. |
| Reports | Workspace markdown files under `reports/github/` | Reports are real artifacts: openable, editable, committable, searchable. Package data is cache; prose belongs to the workspace. Requires `workspace.write`. |
| Project boards | In scope (ProjectsV2 via GraphQL), last sync milestone | They were in the original ask. Sequenced last so the board UI is not blocked on the most complex sync path. |
| Sync window | 90 days by default, configurable | Bounds initial sync cost on large orgs; matches the org events API's own retention. |
| Cache | Package data collections, prunable and disposable | A full re-sync must always reproduce state. No migration logic for cache schema changes — bump a `schemaVersion` in kv and re-sync. |

## Manifest

```json
{
  "name": "mim-github-monitor",
  "version": "0.1.0",
  "type": "module",
  "mim": {
    "manifestVersion": 1,
    "id": "github-monitor",
    "name": "GitHub Monitor",
    "icon": "G",
    "description": "Org-wide GitHub issues, PRs, boards, and activity with saved views and AI summaries.",
    "views": [
      { "id": "main", "label": "GitHub", "src": "./ui/index.html", "role": "work" }
    ],
    "backend": "./backend/index.mjs",
    "permissions": {
      "workspace": { "read": true, "write": true },
      "ai": true,
      "http": ["api.github.com"],
      "secrets": ["github_token"]
    },
    "engines": { "mim": "runtime-v1" }
  }
}
```

Jobs (`sync`, `summarize`) and any tools are backend module exports, per the
runtime contract — the manifest stays static.

## Architecture

Four parts: auth, sync engine (job), data layer (package collections + kv),
UI (one Work view), summaries (job writing workspace reports).

### Auth

- One declared secret: `github_token`. The UI's settings panel calls
  `runtime.secrets.set('github_token', value)` / `status()`; the value never
  reaches the iframe again.
- A `validateToken` backend tool reads it via `ctx.secrets.get` and calls
  `GET /user` + a `viewer { login }` GraphQL probe, returning login, token
  type, and detected scopes for display.
- Recommended token: classic PAT with `repo`, `read:org`, `read:project`.
  Fine-grained PATs work for issues/PRs but org-level ProjectsV2 read support
  is inconsistent; the settings panel says so rather than failing cryptically.
- The org to monitor is a plain kv setting (`org`), set in the same panel.

### Sync engine (`sync` job)

Inputs: `{ full?: boolean }`. Incremental by default.

- **Repos.** GraphQL `organization.repositories` (100/page) → `repos`
  collection. Honors an optional repo allow/deny list setting for very large
  orgs.
- **Issues + PRs.** One GraphQL search per window:
  `org:{org} updated:>{watermark}` (search returns both types) → unified
  `items` records. Watermark = max `updatedAt` seen, stored in kv only after
  the page is persisted, so a crashed run resumes without gaps.
  - GraphQL search caps at 1,000 results per query. When a slice exceeds it
    (first sync on a busy org), bisect the time range and recurse — never
    silently truncate.
- **Activity events.** REST `GET /orgs/{org}/events` with stored ETag;
  `304` responses are free against the rate limit. The API serves at most ~300
  recent events — fine for an incremental feed, documented as not a complete
  history. → `events` collection, pruned to the sync window.
- **ProjectsV2** (milestone 7). GraphQL `organization.projectsV2` + items with
  status field values → `projects` collection, and project status denormalized
  onto matching `items` records for board grouping.
- **Budget and failure.** Track GraphQL point cost and REST remaining from
  response headers; back off on `403`/`429` using `retry-after`. Check
  `ctx.abort` between pages. Phases are independent: a failed events phase
  records its error in the run summary without discarding the issues sync.
- **Progress.** `ctx.progress.step('repos')` etc., counts per phase, so the
  runs UI shows real movement.
- **Trigger.** Manual sync button v1; the view auto-starts a sync on open when
  the watermark is older than 15 minutes. No background timer in v1 (packages
  have no scheduler; that is a platform feature, not something to fake here).

### Data layer

Collections (cache — disposable by design):

| Collection | Id | Record |
|---|---|---|
| `repos` | full name | name, private, archived, defaultBranch, pushedAt, openIssuesCount |
| `items` | `{repo}#{number}` | type (`issue`/`pr`), state, title, bodyExcerpt (≤2,000 chars), author, assignees, labels, milestone, commentCount, createdAt, updatedAt, closedAt, mergedAt, url, projectStatus? |
| `events` | event id | type, actor, repo, summary, createdAt |
| `projects` | project id | title, number, fields, item → status map |

kv: `org`, `watermark`, `etags`, `savedViews`, `summaryModel`,
`repoFilter`, `schemaVersion`.

Bodies are stored as excerpts only; full text lives on GitHub one click away.
No secrets in package data, ever — the token exists only in the keychain.

### UI (Linear-like board)

Single `main` Work view, vanilla JS + `/sdk/tokens.css` in the bundled-package
style (no build step), talking to backend through `runtime.call` and
collections through `runtime.data`.

- **Toolbar:** org name, last-sync age, sync button with live job progress
  (`runtime.jobs.on`), settings (token, org, window, repo filter, summary
  model picker fed by `runtime.ai.registry()`).
- **View rail:** built-in views (All, Open issues, Open PRs, Recently closed,
  Activity) plus user-saved views. A saved view = named filter + sort + layout
  in kv.
- **List layout (default):** dense rows — type glyph, repo, number, title,
  labels, assignee, age. Filters: type, state, repo, author, assignee, label,
  project status, free-text. Sort: updated / created / comments.
- **Board layout:** columns grouped by state, assignee, or project status.
- **Detail panel:** body excerpt, labels, linked project status, recent events
  for that item, `Open on GitHub`.
- **Activity view:** the `events` feed, filterable by actor and repo — this is
  also the visual sanity check for summaries.

All filtering/sorting happens client-side over collection records; at the
90-day window even a busy org is a few thousand small records.

### Summaries (`summarize` job)

Inputs: `{ from, to, user?, focus? }` — the UI offers presets (This week, Last
week, Last 30 days) and a user picker built from synced data.

1. If the watermark predates `to`, run a sync phase first.
2. Gather matching `items` and `events` from local collections — the
   summarizer never calls GitHub.
3. Map-reduce when large: bucket by repo, `ctx.ai.generateObject` per bucket
   into a structured digest (shipped, in-review, discussed, stuck), then one
   synthesis pass over the digests. Small datasets skip straight to synthesis.
4. Model: the `summaryModel` kv setting if set, else omit `modelId` and let
   the workspace cascade decide.
5. Write `reports/github/{yyyy-mm-dd}-{slug}.md` via `ctx.files` with
   frontmatter (range, user filter, model used, item counts), record the path
   in the run summary. The UI lists past reports and opens them as Artifacts
   via `runtime.workbench.openArtifact`.

### Testing

Same discipline as this repo: Vitest, co-located tests, mocks only at system
boundaries. The package repo ships a small `test/harness.mjs` that builds a
fake `ctx` (in-memory data, scripted HTTP client, recorded ai calls) since the
runtime normally injects it. HTTP fixtures are captured real GitHub API
responses. The sync engine's watermark/bisect/ETag logic is pure functions
over the injected client — the part most worth testing hard.

## Milestones

1. **Scaffold + auth.** Repo, manifest, settings panel (token via
   `runtime.secrets`, org), `validateToken`, harness, CI.
2. **Sync v1.** Repos + issues/PRs: GraphQL search, watermark, 1,000-cap
   bisection, progress, cancellation, budget/backoff.
3. **List UI.** Built-in views, filters, sort, detail panel, sync button with
   live progress.
4. **Saved views + board layout.**
5. **Activity.** Org events with ETags, feed view, pruning.
6. **Summaries.** Job, map-reduce, model setting, workspace reports, report
   list in UI.
7. **ProjectsV2.** Board sync, project-status grouping and filtering.
8. **Polish.** Repo allow/deny list, stale-sync auto-trigger, rate-limit
   telemetry in settings, README + install docs.

Each milestone ends green and usable; 1–3 is the minimum lovable version.

## Risks

- **GraphQL search 1,000-result cap** — handled by time-range bisection
  (milestone 2, tested).
- **Org events ~300-event ceiling** — accepted; the feed is recent activity,
  not history. Per-repo commit polling is a possible later addition.
- **Huge orgs** — repo allow/deny list plus the 90-day window bound the cache;
  beyond that, first-sync time is the cost and progress reporting makes it
  bearable.
- **Fine-grained PAT gaps around ProjectsV2** — surfaced in the settings
  panel; classic PAT documented as the reliable choice.
- **Rate-limit exhaustion on first sync** — point budgeting + backoff; worst
  case the job pauses and reports when it will resume.
