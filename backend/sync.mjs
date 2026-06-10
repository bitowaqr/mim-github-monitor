// Incremental org sync: repos, issues/PRs (GraphQL search with watermark +
// 1,000-cap bisection), activity events (REST + ETag), ProjectsV2 boards.
// Collections are a disposable cache; bump SCHEMA_VERSION to force re-sync.

import { RateLimitError } from './github.mjs'

export const SCHEMA_VERSION = 2
const SEARCH_PAGE = 100
const SEARCH_CAP = 1000
const BODY_EXCERPT = 2000
const RATE_WAIT_MAX_MS = 90_000
const OPEN_ITEMS_START = '2008-01-01T00:00:00Z'

// Package data ids must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.
// Real keys ('owner/repo#12') live inside the record; ids are derived.
export function safeId(key) {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const slug = key.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 100)
  return `${slug || 'x'}-${hash.toString(36)}`
}

export function searchTimestamp(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid GitHub search timestamp: ${iso}`)
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function buildSearchQuery(org, fromIso, toIso, qualifiers = []) {
  return [`org:${org}`, ...qualifiers, `updated:${searchTimestamp(fromIso)}..${searchTimestamp(toIso)}`, 'sort:updated-asc'].join(' ')
}

export function mapSearchNode(node) {
  if (!node || (node.__typename !== 'Issue' && node.__typename !== 'PullRequest')) return null
  const repo = node.repository?.nameWithOwner
  if (!repo || typeof node.number !== 'number') return null
  return {
    key: `${repo}#${node.number}`,
    type: node.__typename === 'Issue' ? 'issue' : 'pr',
    repo,
    number: node.number,
    title: node.title || '',
    state: node.isDraft ? 'DRAFT' : node.state || '',
    author: node.author?.login || '',
    assignees: (node.assignees?.nodes || []).map((a) => a.login).filter(Boolean),
    labels: (node.labels?.nodes || []).map((l) => ({ name: l.name, color: l.color || '' })),
    milestone: node.milestone?.title || '',
    commentCount: node.comments?.totalCount ?? 0,
    bodyExcerpt: (node.bodyText || '').slice(0, BODY_EXCERPT),
    url: node.url || '',
    createdAt: node.createdAt || '',
    updatedAt: node.updatedAt || '',
    closedAt: node.closedAt || null,
    mergedAt: node.mergedAt || null,
  }
}

const SEARCH_QUERY = `
query($q: String!, $cursor: String) {
  search(type: ISSUE, query: $q, first: ${SEARCH_PAGE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue {
        number title state url createdAt updatedAt closedAt bodyText
        author { login }
        repository { nameWithOwner }
        labels(first: 10) { nodes { name color } }
        assignees(first: 10) { nodes { login } }
        comments { totalCount }
        milestone { title }
      }
      ... on PullRequest {
        number title state url createdAt updatedAt closedAt mergedAt isDraft bodyText
        author { login }
        repository { nameWithOwner }
        labels(first: 10) { nodes { name color } }
        assignees(first: 10) { nodes { login } }
        comments { totalCount }
        milestone { title }
      }
    }
  }
}`

const REPOS_QUERY = `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    repositories(first: 100, after: $cursor, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner name isPrivate isArchived pushedAt
        defaultBranchRef { name }
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN) { totalCount }
      }
    }
  }
}`

const PROJECTS_QUERY = `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    projectsV2(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title number closed updatedAt }
    }
  }
}`

const PROJECT_ITEMS_QUERY = `
query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            __typename
            ... on Issue { number repository { nameWithOwner } }
            ... on PullRequest { number repository { nameWithOwner } }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`

export function repoAllowed(repoFullName, settings) {
  const list = settings.repoList || []
  const short = repoFullName.includes('/') ? repoFullName.split('/')[1] : repoFullName
  const inList = list.includes(repoFullName) || list.includes(short)
  if (settings.repoMode === 'include') return inList
  if (settings.repoMode === 'exclude') return !inList
  return true
}

// One rate-limit wait per call site: if GitHub says when to resume and it is
// soon, wait it out once; otherwise surface the error with its reset time.
async function withRateRetry(fn, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RateLimitError && err.resumeAt && err.resumeAt - now() <= RATE_WAIT_MAX_MS) {
      await sleep(Math.max(0, err.resumeAt - now()) + 1000)
      return fn()
    }
    throw err
  }
}

export async function syncRepos(gh, collection, org, settings, opts = {}) {
  let cursor = null
  let count = 0
  do {
    const data = await withRateRetry(() => gh.graphql(REPOS_QUERY, { org, cursor }), opts)
    const conn = data.organization?.repositories
    if (!conn) throw new Error(`GitHub organization not found: ${org}`)
    for (const node of conn.nodes || []) {
      if (!node?.nameWithOwner || !repoAllowed(node.nameWithOwner, settings)) continue
      await collection.put(safeId(node.nameWithOwner), {
        key: node.nameWithOwner,
        name: node.name,
        private: !!node.isPrivate,
        archived: !!node.isArchived,
        defaultBranch: node.defaultBranchRef?.name || '',
        pushedAt: node.pushedAt || '',
        openIssues: node.issues?.totalCount ?? 0,
        openPrs: node.pullRequests?.totalCount ?? 0,
      })
      count++
    }
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null
  } while (cursor)
  return count
}

// Fetch one updated:from..to slice. When the slice exceeds the 1,000-result
// search cap, bisect the time range and recurse — never silently truncate.
// Slices are processed oldest-first so the watermark advances monotonically.
export async function syncItemSlice(gh, org, fromIso, toIso, onPage, opts = {}) {
  const state = { count: 0, truncated: [] }
  await fetchSlice(gh, org, fromIso, toIso, onPage, state, opts, 0)
  return state
}

async function fetchSlice(gh, org, fromIso, toIso, onPage, state, opts, depth) {
  const q = buildSearchQuery(org, fromIso, toIso, opts.qualifiers || [])
  let cursor = null
  let firstPage = true
  do {
    opts.throwIfAborted?.()
    const data = await withRateRetry(() => gh.graphql(SEARCH_QUERY, { q, cursor }), opts)
    const search = data.search
    if (!search) throw new Error('GitHub search returned no data')
    if (firstPage && search.issueCount > SEARCH_CAP) {
      const from = Date.parse(fromIso)
      const to = Date.parse(toIso)
      if (to - from > 2000 && depth < 32) {
        const mid = new Date(from + Math.floor((to - from) / 2))
        const midIso = mid.toISOString()
        const afterMidIso = new Date(mid.getTime() + 1000).toISOString()
        await fetchSlice(gh, org, fromIso, midIso, onPage, state, opts, depth + 1)
        await fetchSlice(gh, org, afterMidIso, toIso, onPage, state, opts, depth + 1)
        return
      }
      // Cannot split further: accept the cap and record the truncation.
      state.truncated.push({ from: fromIso, to: toIso, total: search.issueCount })
    }
    firstPage = false
    const records = (search.nodes || []).map(mapSearchNode).filter(Boolean)
    if (records.length > 0) {
      await onPage(records)
      state.count += records.length
    }
    cursor = search.pageInfo?.hasNextPage ? search.pageInfo.endCursor : null
  } while (cursor)
}

export function eventSummary(event) {
  const p = event.payload || {}
  switch (event.type) {
    case 'PushEvent': {
      const head = p.commits?.[0]?.message?.split('\n')[0] || ''
      const ref = (p.ref || '').replace('refs/heads/', '')
      return `pushed ${p.commits?.length ?? p.size ?? 0} commit(s) to ${ref}${head ? `: ${head}` : ''}`
    }
    case 'IssuesEvent':
      return `${p.action || 'updated'} issue #${p.issue?.number}: ${p.issue?.title || ''}`
    case 'PullRequestEvent':
      return `${p.action || 'updated'} PR #${p.pull_request?.number}: ${p.pull_request?.title || ''}`
    case 'IssueCommentEvent':
      return `commented on #${p.issue?.number}: ${p.issue?.title || ''}`
    case 'PullRequestReviewEvent':
      return `reviewed PR #${p.pull_request?.number} (${(p.review?.state || '').toLowerCase()})`
    case 'PullRequestReviewCommentEvent':
      return `review comment on PR #${p.pull_request?.number}`
    case 'CreateEvent':
      return `created ${p.ref_type}${p.ref ? ` ${p.ref}` : ''}`
    case 'DeleteEvent':
      return `deleted ${p.ref_type} ${p.ref || ''}`
    case 'ReleaseEvent':
      return `released ${p.release?.tag_name || ''}`
    case 'ForkEvent':
      return 'forked the repository'
    case 'WatchEvent':
      return 'starred the repository'
    default:
      return event.type.replace(/Event$/, '')
  }
}

export function mapEvent(event) {
  if (!event?.id || !event?.type) return null
  return {
    key: String(event.id),
    type: event.type,
    actor: event.actor?.login || '',
    repo: event.repo?.name || '',
    summary: eventSummary(event).slice(0, 300),
    createdAt: event.created_at || '',
  }
}

export async function syncEvents(gh, collection, org, { etag, windowDays, settings, nowIso }) {
  const result = await gh.rest(`orgs/${org}/events?per_page=100`, { etag })
  if (result.notModified) return { count: 0, etag, notModified: true }
  let count = 0
  for (const raw of Array.isArray(result.body) ? result.body : []) {
    const record = mapEvent(raw)
    if (!record || !repoAllowed(record.repo, settings)) continue
    await collection.put(safeId(record.key), record)
    count++
  }
  // Prune the feed to the sync window.
  const cutoff = new Date(Date.parse(nowIso) - windowDays * 86_400_000).toISOString()
  const existing = await collection.list()
  for (const row of existing) {
    if (row.value?.createdAt && row.value.createdAt < cutoff) await collection.delete(row.id)
  }
  return { count, etag: result.etag || null, notModified: false }
}

export async function syncProjects(gh, data, org, opts = {}) {
  let cursor = null
  const projects = []
  do {
    const result = await withRateRetry(() => gh.graphql(PROJECTS_QUERY, { org, cursor }), opts)
    const conn = result.organization?.projectsV2
    if (!conn) break
    projects.push(...(conn.nodes || []).filter((n) => n && !n.closed))
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null
  } while (cursor)

  const projectsCollection = data.collection('projects')
  const itemsCollection = data.collection('items')
  let statusCount = 0
  for (const project of projects) {
    opts.throwIfAborted?.()
    const statuses = {}
    let itemCursor = null
    do {
      const result = await withRateRetry(() => gh.graphql(PROJECT_ITEMS_QUERY, { id: project.id, cursor: itemCursor }), opts)
      const items = result.node?.items
      if (!items) break
      for (const node of items.nodes || []) {
        const content = node?.content
        const repo = content?.repository?.nameWithOwner
        if (!repo || typeof content.number !== 'number') continue
        statuses[`${repo}#${content.number}`] = node.fieldValueByName?.name || ''
      }
      itemCursor = items.pageInfo?.hasNextPage ? items.pageInfo.endCursor : null
    } while (itemCursor)

    await projectsCollection.put(safeId(`project-${project.number}`), {
      key: `project-${project.number}`,
      title: project.title,
      number: project.number,
      updatedAt: project.updatedAt || '',
      itemCount: Object.keys(statuses).length,
    })

    // Denormalize project status onto synced items for board grouping.
    for (const [itemKey, status] of Object.entries(statuses)) {
      const id = safeId(itemKey)
      const existing = await itemsCollection.get(id)
      if (existing) {
        await itemsCollection.put(id, { ...existing, projectStatus: status, projectTitle: project.title })
        statusCount++
      }
    }
  }
  return { projects: projects.length, statusCount }
}

export async function runSync(ctx, gh, inputs = {}, { nowIso = () => new Date().toISOString() } = {}) {
  const settings = (await ctx.data.kv.get('settings')) || {}
  if (!settings.org) throw new Error('No organization configured. Open GitHub Monitor settings and set one.')
  const org = settings.org
  const windowDays = settings.syncWindowDays > 0 ? settings.syncWindowDays : 90

  const prior = (await ctx.data.kv.get('syncState')) || {}
  const full = !!inputs.full || prior.schemaVersion !== SCHEMA_VERSION
  const now = nowIso()
  const windowStart = new Date(Date.parse(now) - windowDays * 86_400_000).toISOString()
  const fromIso = full || !prior.watermark ? windowStart : prior.watermark
  const opts = { throwIfAborted: () => ctx.abort?.throwIfAborted?.() }

  const summary = { org, full, items: 0, repos: 0, events: 0, projects: 0, truncated: [], errors: [] }
  let watermark = full ? null : prior.watermark || null
  let itemPhaseOk = true

  await ctx.progress.step('Repositories')
  try {
    summary.repos = await syncRepos(gh, ctx.data.collection('repos'), org, settings, opts)
  } catch (err) {
    if (err instanceof RateLimitError || /organization not found|token/i.test(err.message)) throw err
    summary.errors.push({ phase: 'repos', message: err.message })
  }

  await ctx.progress.step('Issues and pull requests')
  const items = ctx.data.collection('items')
  const ingestItems = async (records) => {
    const allowed = records.filter((r) => repoAllowed(r.repo, settings))
    for (const record of allowed) await items.put(safeId(record.key), record)
    const maxUpdated = allowed.reduce((acc, r) => (r.updatedAt > acc ? r.updatedAt : acc), watermark || '')
    if (maxUpdated && (!watermark || maxUpdated > watermark)) {
      watermark = maxUpdated
      // Persist after the page lands so a crashed run resumes without gaps.
      if (!full) await ctx.data.kv.set('syncState', { ...prior, schemaVersion: SCHEMA_VERSION, watermark })
    }
    await ctx.progress.progress(Math.min(0.2 + summary.items / 2000, 0.8), `${summary.items + allowed.length} items`)
    summary.items += allowed.length
  }
  try {
    if (full) {
      const open = await syncItemSlice(gh, org, OPEN_ITEMS_START, now, ingestItems, { ...opts, qualifiers: ['is:open'] })
      const closed = await syncItemSlice(gh, org, windowStart, now, ingestItems, { ...opts, qualifiers: ['is:closed'] })
      summary.truncated = [...open.truncated, ...closed.truncated]
    } else {
      const slice = await syncItemSlice(gh, org, fromIso, now, ingestItems, opts)
      summary.truncated = slice.truncated
    }
  } catch (err) {
    itemPhaseOk = false
    watermark = prior.watermark || null
    if (err instanceof RateLimitError) throw err
    summary.errors.push({ phase: 'items', message: err.message })
  }

  await ctx.progress.step('Activity')
  try {
    const events = await syncEvents(gh, ctx.data.collection('events'), org, {
      etag: prior.eventsEtag,
      windowDays,
      settings,
      nowIso: now,
    })
    summary.events = events.count
    prior.eventsEtag = events.etag || prior.eventsEtag
  } catch (err) {
    summary.errors.push({ phase: 'events', message: err.message })
  }

  await ctx.progress.step('Project boards')
  try {
    const projects = await syncProjects(gh, ctx.data, org, opts)
    summary.projects = projects.projects
  } catch (err) {
    summary.errors.push({ phase: 'projects', message: err.message })
  }

  await ctx.data.kv.set('syncState', {
    schemaVersion: itemPhaseOk ? SCHEMA_VERSION : prior.schemaVersion,
    watermark: itemPhaseOk ? watermark || now : prior.watermark || null,
    eventsEtag: prior.eventsEtag || null,
    lastSyncAt: now,
    lastSummary: summary,
  })
  await ctx.progress.done(`Synced ${summary.items} items, ${summary.events} events across ${summary.repos} repos`)
  return summary
}
