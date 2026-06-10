import { describe, it, expect } from 'vitest'
import { RateLimitError } from './github.mjs'
import {
  SCHEMA_VERSION,
  safeId,
  buildSearchQuery,
  searchTimestamp,
  mapSearchNode,
  repoAllowed,
  eventSummary,
  mapEvent,
  syncItemSlice,
  syncEvents,
  runSync,
} from './sync.mjs'
import { makeCtx, memoryData } from '../test/harness.mjs'

const NOW = '2026-06-10T12:00:00.000Z'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/

function issueNode(repo, number, updatedAt, extra = {}) {
  return {
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    state: 'OPEN',
    url: `https://github.com/${repo}/issues/${number}`,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt,
    closedAt: null,
    bodyText: 'body text',
    author: { login: 'alice' },
    repository: { nameWithOwner: repo },
    labels: { nodes: [{ name: 'bug', color: 'f00' }] },
    assignees: { nodes: [{ login: 'bob' }] },
    comments: { totalCount: 3 },
    milestone: { title: 'v1' },
    ...extra,
  }
}

function searchResult(nodes, { issueCount = nodes.length, hasNext = false, cursor = null } = {}) {
  return { search: { issueCount, pageInfo: { hasNextPage: hasNext, endCursor: cursor }, nodes } }
}

describe('safeId', () => {
  it('always matches the package data id constraint', () => {
    const keys = ['acme/repo#12', 'project-3', '../../etc/passwd', '--weird--', 'ümlaut/ßtraße#1', 'x'.repeat(300), '#']
    for (const key of keys) expect(safeId(key)).toMatch(ID_PATTERN)
  })

  it('is stable and collision-resistant across similar keys', () => {
    expect(safeId('acme/repo#12')).toBe(safeId('acme/repo#12'))
    expect(safeId('acme/repo#12')).not.toBe(safeId('acme/repo#13'))
    // Same slug after sanitization, different raw key → hash disambiguates.
    expect(safeId('acme/repo.12')).not.toBe(safeId('acme/repo#12'))
  })
})

describe('buildSearchQuery', () => {
  it('formats GitHub search timestamps without JavaScript milliseconds', () => {
    expect(searchTimestamp('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00Z')
    expect(searchTimestamp('2026-01-01T01:02:03+01:00')).toBe('2026-01-01T00:02:03Z')
  })

  it('builds an oldest-first updated-range query', () => {
    expect(buildSearchQuery('acme', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')).toBe(
      'org:acme updated:2026-01-01T00:00:00Z..2026-01-02T00:00:00Z sort:updated-asc',
    )
  })

  it('adds search qualifiers before the updated range', () => {
    expect(buildSearchQuery('acme', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ['is:open'])).toBe(
      'org:acme is:open updated:2026-01-01T00:00:00Z..2026-01-02T00:00:00Z sort:updated-asc',
    )
  })
})

describe('mapSearchNode', () => {
  it('maps an Issue node into an item record', () => {
    const record = mapSearchNode(issueNode('acme/app', 12, NOW))
    expect(record).toMatchObject({
      key: 'acme/app#12',
      type: 'issue',
      repo: 'acme/app',
      number: 12,
      state: 'OPEN',
      author: 'alice',
      assignees: ['bob'],
      labels: [{ name: 'bug', color: 'f00' }],
      milestone: 'v1',
      commentCount: 3,
      mergedAt: null,
    })
  })

  it('maps a draft PR to state DRAFT and keeps mergedAt', () => {
    const record = mapSearchNode({
      ...issueNode('acme/app', 7, NOW),
      __typename: 'PullRequest',
      state: 'OPEN',
      isDraft: true,
      mergedAt: null,
    })
    expect(record.type).toBe('pr')
    expect(record.state).toBe('DRAFT')
  })

  it('truncates long bodies and rejects unknown nodes', () => {
    const record = mapSearchNode(issueNode('acme/app', 1, NOW, { bodyText: 'y'.repeat(5000) }))
    expect(record.bodyExcerpt).toHaveLength(2000)
    expect(mapSearchNode({ __typename: 'Discussion' })).toBeNull()
    expect(mapSearchNode(null)).toBeNull()
  })
})

describe('repoAllowed', () => {
  it('include mode allows only listed repos (full or short name)', () => {
    const settings = { repoMode: 'include', repoList: ['acme/app', 'tools'] }
    expect(repoAllowed('acme/app', settings)).toBe(true)
    expect(repoAllowed('acme/tools', settings)).toBe(true)
    expect(repoAllowed('acme/other', settings)).toBe(false)
  })

  it('exclude mode blocks listed repos; default allows all', () => {
    expect(repoAllowed('acme/app', { repoMode: 'exclude', repoList: ['acme/app'] })).toBe(false)
    expect(repoAllowed('acme/other', { repoMode: 'exclude', repoList: ['acme/app'] })).toBe(true)
    expect(repoAllowed('acme/anything', {})).toBe(true)
  })
})

describe('syncItemSlice', () => {
  it('pages through a slice under the cap', async () => {
    const gh = {
      async graphql(query, { q, cursor }) {
        if (!cursor) return searchResult([issueNode('acme/a', 1, '2026-06-01T01:00:00.000Z')], { issueCount: 2, hasNext: true, cursor: 'c1' })
        expect(cursor).toBe('c1')
        return searchResult([issueNode('acme/a', 2, '2026-06-02T01:00:00.000Z')], { issueCount: 2 })
      },
    }
    const pages = []
    const result = await syncItemSlice(gh, 'acme', '2026-06-01T00:00:00.000Z', NOW, async (records) => pages.push(records))
    expect(result.count).toBe(2)
    expect(pages.map((p) => p[0].number)).toEqual([1, 2])
  })

  it('bisects over-cap slices and processes the older half first', async () => {
    const from = '2026-01-01T00:00:00.000Z'
    const to = '2026-01-02T00:00:00.000Z'
    const mid = '2026-01-01T12:00:00.000Z'
    const afterMid = '2026-01-01T12:00:01.000Z'
    const gh = {
      async graphql(query, { q }) {
        if (q.includes('2026-01-01T00:00:00Z..2026-01-02T00:00:00Z')) return searchResult([], { issueCount: 1500 })
        if (q.includes('2026-01-01T00:00:00Z..2026-01-01T12:00:00Z')) {
          return searchResult([issueNode('acme/a', 1, '2026-01-01T06:00:00.000Z')])
        }
        if (q.includes('2026-01-01T12:00:01Z..2026-01-02T00:00:00Z')) {
          return searchResult([issueNode('acme/a', 2, '2026-01-01T18:00:00.000Z')])
        }
        throw new Error(`unexpected query: ${q}`)
      },
    }
    const pages = []
    const result = await syncItemSlice(gh, 'acme', from, to, async (records) => pages.push(records))
    expect(result.count).toBe(2)
    expect(result.truncated).toEqual([])
    expect(pages.map((p) => p[0].number)).toEqual([1, 2]) // oldest half first
  })

  it('records truncation when a slice cannot be split further', async () => {
    const from = '2026-01-01T00:00:00.000Z'
    const to = '2026-01-01T00:00:01.000Z' // 1s — below the 2s split floor
    const gh = {
      async graphql() {
        return searchResult([issueNode('acme/a', 1, from)], { issueCount: 1200 })
      },
    }
    const result = await syncItemSlice(gh, 'acme', from, to, async () => {})
    expect(result.truncated).toEqual([{ from, to, total: 1200 }])
    expect(result.count).toBe(1) // still ingests what the cap allows
  })

  it('waits out a near rate-limit reset once, then retries', async () => {
    let calls = 0
    const sleeps = []
    const gh = {
      async graphql() {
        calls++
        if (calls === 1) throw new RateLimitError('limited', 5_000)
        return searchResult([issueNode('acme/a', 1, '2026-06-01T01:00:00.000Z')])
      },
    }
    const result = await syncItemSlice(gh, 'acme', '2026-06-01T00:00:00.000Z', NOW, async () => {}, {
      sleep: async (ms) => sleeps.push(ms),
      now: () => 0,
    })
    expect(calls).toBe(2)
    expect(sleeps).toEqual([6000])
    expect(result.count).toBe(1)
  })

  it('rethrows rate limits with a far reset time', async () => {
    const gh = {
      async graphql() {
        throw new RateLimitError('limited', 10_000_000)
      },
    }
    await expect(
      syncItemSlice(gh, 'acme', '2026-06-01T00:00:00.000Z', NOW, async () => {}, { sleep: async () => {}, now: () => 0 }),
    ).rejects.toBeInstanceOf(RateLimitError)
  })
})

describe('eventSummary / mapEvent', () => {
  it('summarizes common event types', () => {
    expect(
      eventSummary({ type: 'PushEvent', payload: { ref: 'refs/heads/main', commits: [{ message: 'fix: x\nbody' }] } }),
    ).toBe('pushed 1 commit(s) to main: fix: x')
    expect(eventSummary({ type: 'IssuesEvent', payload: { action: 'closed', issue: { number: 3, title: 'T' } } })).toBe(
      'closed issue #3: T',
    )
    expect(
      eventSummary({ type: 'PullRequestReviewEvent', payload: { pull_request: { number: 9 }, review: { state: 'APPROVED' } } }),
    ).toBe('reviewed PR #9 (approved)')
    expect(eventSummary({ type: 'MemberEvent', payload: {} })).toBe('Member')
  })

  it('maps raw events and rejects malformed ones', () => {
    const record = mapEvent({
      id: 9001,
      type: 'PushEvent',
      actor: { login: 'alice' },
      repo: { name: 'acme/app' },
      created_at: NOW,
      payload: { ref: 'refs/heads/main', commits: [] },
    })
    expect(record).toMatchObject({ key: '9001', actor: 'alice', repo: 'acme/app', createdAt: NOW })
    expect(mapEvent({ type: 'PushEvent' })).toBeNull()
  })
})

describe('syncEvents', () => {
  const rawEvent = {
    id: '42',
    type: 'IssuesEvent',
    actor: { login: 'alice' },
    repo: { name: 'acme/app' },
    created_at: '2026-06-09T10:00:00.000Z',
    payload: { action: 'opened', issue: { number: 1, title: 'T' } },
  }

  it('stores fresh events, returns the new etag, and prunes outside the window', async () => {
    const data = memoryData()
    const collection = data.collection('events')
    await collection.put(safeId('old'), { key: 'old', repo: 'acme/app', createdAt: '2026-01-01T00:00:00.000Z' })
    const gh = {
      async rest(path, { etag } = {}) {
        expect(path).toBe('orgs/acme/events?per_page=100')
        expect(etag).toBe('W/"prev"')
        return { status: 200, notModified: false, body: [rawEvent], etag: 'W/"next"' }
      },
    }
    const result = await syncEvents(gh, collection, 'acme', { etag: 'W/"prev"', windowDays: 90, settings: {}, nowIso: NOW })
    expect(result).toEqual({ count: 1, etag: 'W/"next"', notModified: false })
    const rows = await collection.list()
    expect(rows).toHaveLength(1) // the January event got pruned
    expect(rows[0].value.key).toBe('42')
  })

  it('treats 304 as a no-op that keeps the etag', async () => {
    const gh = { async rest() { return { status: 304, notModified: true, body: null, etag: null } } }
    const result = await syncEvents(gh, memoryData().collection('events'), 'acme', {
      etag: 'W/"prev"',
      windowDays: 90,
      settings: {},
      nowIso: NOW,
    })
    expect(result).toEqual({ count: 0, etag: 'W/"prev"', notModified: true })
  })

  it('respects the repo filter', async () => {
    const collection = memoryData().collection('events')
    const gh = { async rest() { return { status: 200, notModified: false, body: [rawEvent], etag: null } } }
    const result = await syncEvents(gh, collection, 'acme', {
      windowDays: 90,
      settings: { repoMode: 'exclude', repoList: ['acme/app'] },
      nowIso: NOW,
    })
    expect(result.count).toBe(0)
  })
})

describe('runSync', () => {
  function fakeGh({ queries = [], searchNodes = [], events = [], failSearch = false, failEvents = false } = {}) {
    return {
      async graphql(query, vars) {
        queries.push(vars.q || query.slice(0, 40))
        if (query.includes('repositories(')) {
          return {
            organization: {
              repositories: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    nameWithOwner: 'acme/app',
                    name: 'app',
                    isPrivate: true,
                    isArchived: false,
                    pushedAt: NOW,
                    defaultBranchRef: { name: 'main' },
                    issues: { totalCount: 4 },
                    pullRequests: { totalCount: 2 },
                  },
                ],
              },
            },
          }
        }
        if (query.includes('search(')) {
          if (failSearch) throw new Error('search exploded')
          if (vars.q.includes('is:closed')) return searchResult([])
          return searchResult(searchNodes)
        }
        if (query.includes('projectsV2(')) {
          return {
            organization: {
              projectsV2: {
                pageInfo: { hasNextPage: false },
                nodes: [{ id: 'P1', title: 'Roadmap', number: 1, closed: false, updatedAt: NOW }],
              },
            },
          }
        }
        if (query.includes('items(first: 100')) {
          return {
            node: {
              items: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    content: { __typename: 'Issue', number: 12, repository: { nameWithOwner: 'acme/app' } },
                    fieldValueByName: { name: 'In progress' },
                  },
                ],
              },
            },
          }
        }
        throw new Error(`unexpected query: ${query.slice(0, 60)}`)
      },
      async rest() {
        if (failEvents) throw new Error('events exploded')
        return {
          status: 200,
          notModified: false,
          body: events,
          etag: 'W/"ev"',
        }
      },
    }
  }

  async function configuredCtx(settings = { org: 'acme' }, syncState = null) {
    const ctx = makeCtx()
    await ctx.data.kv.set('settings', settings)
    if (syncState) await ctx.data.kv.set('syncState', syncState)
    return ctx
  }

  it('syncs repos, items, events, and projects, then persists state', async () => {
    const ctx = await configuredCtx()
    const nodes = [issueNode('acme/app', 12, '2026-06-08T09:00:00.000Z'), issueNode('acme/app', 13, '2026-06-09T09:00:00.000Z')]
    const events = [
      {
        id: '42',
        type: 'IssuesEvent',
        actor: { login: 'alice' },
        repo: { name: 'acme/app' },
        created_at: '2026-06-09T10:00:00.000Z',
        payload: { action: 'opened', issue: { number: 1, title: 'T' } },
      },
    ]
    const summary = await runSync(ctx, fakeGh({ searchNodes: nodes, events }), {}, { nowIso: () => NOW })

    expect(summary).toMatchObject({ org: 'acme', full: true, repos: 1, items: 2, events: 1, projects: 1, errors: [], truncated: [] })

    const state = await ctx.data.kv.get('syncState')
    expect(state.schemaVersion).toBe(SCHEMA_VERSION)
    expect(state.watermark).toBe('2026-06-09T09:00:00.000Z')
    expect(state.eventsEtag).toBe('W/"ev"')
    expect(state.lastSyncAt).toBe(NOW)

    const item = await ctx.data.collection('items').get(safeId('acme/app#12'))
    expect(item.projectStatus).toBe('In progress')
    expect(item.projectTitle).toBe('Roadmap')
    const repo = await ctx.data.collection('repos').get(safeId('acme/app'))
    expect(repo).toMatchObject({ key: 'acme/app', openIssues: 4, openPrs: 2, defaultBranch: 'main' })
  })

  it('resumes from the watermark on incremental syncs', async () => {
    const ctx = await configuredCtx({ org: 'acme' }, { schemaVersion: SCHEMA_VERSION, watermark: '2026-06-05T00:00:00.000Z' })
    const queries = []
    await runSync(ctx, fakeGh({ queries }), {}, { nowIso: () => NOW })
    const searchQ = queries.find((q) => q.startsWith('org:acme updated:'))
    expect(searchQ).toBe('org:acme updated:2026-06-05T00:00:00Z..2026-06-10T12:00:00Z sort:updated-asc')
  })

  it('forces a full window sync when the schema version changed', async () => {
    const ctx = await configuredCtx({ org: 'acme' }, { schemaVersion: 0, watermark: '2026-06-05T00:00:00.000Z' })
    const queries = []
    const summary = await runSync(ctx, fakeGh({ queries }), {}, { nowIso: () => NOW })
    expect(summary.full).toBe(true)
    expect(queries).toContain('org:acme is:open updated:2008-01-01T00:00:00Z..2026-06-10T12:00:00Z sort:updated-asc')
    expect(queries).toContain('org:acme is:closed updated:2026-03-12T12:00:00Z..2026-06-10T12:00:00Z sort:updated-asc')
  })

  it('does not advance the watermark or schema version when the item phase fails', async () => {
    const prior = { schemaVersion: 0, watermark: '2026-06-05T00:00:00.000Z' }
    const ctx = await configuredCtx({ org: 'acme' }, prior)
    const summary = await runSync(ctx, fakeGh({ failSearch: true }), {}, { nowIso: () => NOW })
    expect(summary.errors).toEqual([{ phase: 'items', message: 'search exploded' }])
    const state = await ctx.data.kv.get('syncState')
    expect(state.schemaVersion).toBe(0)
    expect(state.watermark).toBe(prior.watermark)
  })

  it('filters items by the repo settings', async () => {
    const ctx = await configuredCtx({ org: 'acme', repoMode: 'exclude', repoList: ['acme/app'] })
    const summary = await runSync(
      ctx,
      fakeGh({ searchNodes: [issueNode('acme/app', 12, '2026-06-08T09:00:00.000Z')] }),
      {},
      { nowIso: () => NOW },
    )
    expect(summary.items).toBe(0)
    expect(summary.repos).toBe(0)
  })

  it('keeps going when one phase fails and reports it', async () => {
    const ctx = await configuredCtx()
    const summary = await runSync(ctx, fakeGh({ failEvents: true }), {}, { nowIso: () => NOW })
    expect(summary.errors).toEqual([{ phase: 'events', message: 'events exploded' }])
    expect(summary.projects).toBe(1) // later phases still ran
  })

  it('rethrows rate limits so the job surfaces them', async () => {
    const ctx = await configuredCtx()
    const gh = {
      async graphql() {
        throw new RateLimitError('limited', null)
      },
      async rest() {
        throw new RateLimitError('limited', null)
      },
    }
    await expect(runSync(ctx, gh, {}, { nowIso: () => NOW })).rejects.toBeInstanceOf(RateLimitError)
  })

  it('fails fast without an org or when the org does not exist', async () => {
    const noOrg = makeCtx()
    await expect(runSync(noOrg, fakeGh(), {}, { nowIso: () => NOW })).rejects.toThrow(/No organization configured/)

    const ctx = await configuredCtx()
    const gh = { async graphql() { return { organization: null } }, async rest() { return { status: 200, notModified: false, body: [] } } }
    await expect(runSync(ctx, gh, {}, { nowIso: () => NOW })).rejects.toThrow(/organization not found: acme/)
  })
})
