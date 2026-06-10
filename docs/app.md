# GitHub Monitor App

GitHub Monitor is a read-only Mim app for watching one GitHub organization
across all of its repositories. It indexes repositories, open issues, open pull
requests, recently closed items, recent organization activity, ProjectsV2 board
status, saved views, and AI-generated activity summaries.

The app is intentionally not part of Mim core. It is installed as a package in a
workspace and enabled from Mim's Apps UI.

## Install

Clone the package into a Mim workspace:

```sh
cd {workspace}/packages
git clone https://github.com/bitowaqr/mim-github-monitor github-monitor
```

Then open Mim, go to Apps, enable GitHub Monitor, and open the GitHub view.

## Setup

Open GitHub Monitor settings and configure:

| Setting | Purpose |
| --- | --- |
| GitHub token | Classic personal access token stored in the OS keychain. |
| Organization | GitHub organization login, for example `dark-peak-analytics`. |
| Sync window | How far back recently closed items and activity are retained. |
| Repositories | Optional include/exclude list for narrowing large orgs. |
| Summary model | Optional model override for summaries; blank uses the workspace default. |

Use a classic PAT with these scopes:

| Scope | Why |
| --- | --- |
| `repo` | Reads private repositories, issues, and pull requests. |
| `read:org` | Reads organization metadata. |
| `read:project` or `project` | Reads organization ProjectsV2 board metadata. |

Fine-grained PATs may work for repository issues and pull requests, but classic
PATs are the reliable path for organization ProjectsV2 data.

## What Sync Does

Sync is local, incremental, and safe to rerun.

| Data | Source | Stored in |
| --- | --- | --- |
| Repositories | GitHub GraphQL organization repositories | `repos` collection |
| Issues and PRs | GitHub GraphQL search | `items` collection |
| Activity feed | `GET /orgs/{org}/events` with ETags | `events` collection |
| ProjectsV2 | GitHub GraphQL ProjectsV2 | `projects` collection and item status fields |
| Summaries | Local cache plus workspace AI model | Markdown files under `reports/github/` |

Full sync indexes:

- all currently open issues and pull requests, regardless of age
- recently closed issues and pull requests inside the configured sync window
- repository metadata and open issue/PR totals
- recent org activity events
- open ProjectsV2 boards and item statuses

Incremental sync starts from the stored item watermark and upserts records by
stable IDs. The cache is disposable: deleting package data only means the next
full sync rebuilds it.

## Using The App

The left rail contains built-in views:

| View | Shows |
| --- | --- |
| All items | Synced issue and pull request details. |
| Open issues | Open issues only. |
| Open PRs | Open and draft pull requests. |
| Recently closed | Closed or merged items from the recent window. |
| Activity | Recent organization activity events. |
| Summaries | Controls and history for generated reports. |

The item views support list and board layouts. Filters include type, state,
repository, person, label, project status, and free text. Saved views persist
the current filters, sort order, layout, and board grouping in package kv data.

The detail panel shows the item excerpt, labels, assignees, project status,
comment count, recent repository activity, and a GitHub link.

## Summaries

The summary job reads only local package data. It does not call GitHub while
summarizing.

Inputs:

| Input | Meaning |
| --- | --- |
| Timeframe | This week, last week, last 30 days, or custom dates. |
| User | Optional GitHub login focus. |
| Focus | Optional instruction such as release readiness or blockers. |

Reports are written to:

```text
reports/github/
```

They are ordinary workspace markdown files, so they can be opened, edited, and
committed like other artifacts.

## Permissions

The package manifest asks for:

| Permission | Use |
| --- | --- |
| `http: ["api.github.com"]` | Restricts network calls to GitHub's API host. |
| `secrets: ["github_token"]` | Stores and reads the PAT from the OS keychain. |
| `workspace.read/write` | Writes markdown summary reports. |
| `ai: true` | Generates activity summaries through the workspace model registry. |

The token is never written into package data or report files.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Token validation says a scope is missing | Use a classic PAT with `repo`, `read:org`, and `read:project` or `project`. |
| Repos appear but issue/PR details are empty | Run a full re-sync. The app also shows repo-index totals so the org does not appear empty while item details rebuild. |
| Activity is sparse | GitHub's org events API is recent activity only, not full history. |
| Projects are missing | Confirm the token has `read:project` or `project`; fine-grained PATs can be inconsistent here. |
| Counts look stale | Use Sync, or Save & full re-sync after changing org/repository filters. |

## Current Limits

- Read-only: the app does not create or edit GitHub issues, PRs, or projects.
- Polling only: there are no webhooks because Mim is a local desktop app.
- Activity feed is bounded by GitHub's recent org events API.
- Large orgs may require a longer first full sync; repo include/exclude filters
  are available to narrow the scope.
