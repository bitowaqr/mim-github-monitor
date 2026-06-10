import { describe, it, expect } from 'vitest'
import {
  gatherActivity,
  bucketByRepo,
  bucketPrompt,
  renderReport,
  reportPath,
  runSummarize,
  DIGEST_SCHEMA,
  SYNTHESIS_SCHEMA,
} from './summarize.mjs'
import { makeCtx } from '../test/harness.mjs'

const NOW = '2026-06-10T12:00:00.000Z'
const FROM = '2026-06-01T00:00:00.000Z'
const TO = '2026-06-08T00:00:00.000Z'

function item(repo, number, overrides = {}) {
  return {
    key: `${repo}#${number}`,
    type: 'issue',
    repo,
    number,
    title: `Item ${number}`,
    state: 'OPEN',
    author: 'alice',
    assignees: ['bob'],
    labels: [],
    milestone: '',
    commentCount: 2,
    bodyExcerpt: '',
    url: '',
    createdAt: FROM,
    updatedAt: '2026-06-03T00:00:00.000Z',
    closedAt: null,
    mergedAt: null,
    ...overrides,
  }
}

function event(repo, actor, createdAt = '2026-06-04T00:00:00.000Z') {
  return { key: 'e1', type: 'PushEvent', actor, repo, summary: 'pushed 1 commit(s) to main', createdAt }
}

const SYNTHESIS = {
  headline: 'A focused week shipping the sync engine.',
  highlights: ['acme/app#12 merged'],
  byPerson: [{ login: 'alice', summary: 'shipped sync' }],
  byRepo: [{ repo: 'acme/app', summary: 'sync engine landed' }],
  risks: ['acme/app#9 stale'],
}

describe('gatherActivity', () => {
  it('filters by timeframe', () => {
    const result = gatherActivity(
      {
        items: [item('acme/app', 1), item('acme/app', 2, { updatedAt: '2026-05-01T00:00:00.000Z' })],
        events: [event('acme/app', 'alice'), event('acme/app', 'alice', '2026-06-09T00:00:00.000Z')],
      },
      { from: FROM, to: TO },
    )
    expect(result.items.map((i) => i.number)).toEqual([1])
    expect(result.events).toHaveLength(1)
  })

  it('filters by user via author, assignee, or actor', () => {
    const result = gatherActivity(
      {
        items: [item('acme/app', 1, { author: 'carol', assignees: [] }), item('acme/app', 2, { author: 'alice', assignees: ['carol'] }), item('acme/app', 3)],
        events: [event('acme/app', 'carol'), event('acme/app', 'alice')],
      },
      { from: FROM, to: TO, user: 'carol' },
    )
    expect(result.items.map((i) => i.number)).toEqual([1, 2])
    expect(result.events.map((e) => e.actor)).toEqual(['carol'])
  })
})

describe('bucketByRepo', () => {
  it('groups by repo, busiest first', () => {
    const buckets = bucketByRepo({
      items: [item('acme/a', 1), item('acme/b', 2), item('acme/b', 3)],
      events: [event('acme/b', 'alice')],
    })
    expect(buckets.map((b) => b.repo)).toEqual(['acme/b', 'acme/a'])
    expect(buckets[0].items).toHaveLength(2)
    expect(buckets[0].events).toHaveLength(1)
  })
})

describe('bucketPrompt', () => {
  it('lists items and events with a truncation note past the cap', () => {
    const many = Array.from({ length: 250 }, (_, i) => item('acme/a', i))
    const prompt = bucketPrompt({ repo: 'acme/a', items: many, events: [] }, { from: FROM, to: TO, user: 'alice' })
    expect(prompt).toContain('Repository: acme/a')
    expect(prompt).toContain('focus on user alice')
    expect(prompt).toContain('truncated to 200 entries')
    expect(prompt).toContain('No activity events.')
    expect(prompt.match(/\[issue acme\/a#/g)).toHaveLength(200)
  })
})

describe('renderReport / reportPath', () => {
  const meta = { org: 'acme', from: FROM, to: TO, user: 'carol', model: '', itemCount: 3, eventCount: 1, generatedAt: NOW }

  it('renders frontmatter and all sections deterministically', () => {
    const report = renderReport(SYNTHESIS, meta)
    expect(report).toContain('range: 2026-06-01T00:00:00.000Z .. 2026-06-08T00:00:00.000Z')
    expect(report).toContain('user: carol')
    expect(report).toContain('model: workspace default')
    expect(report).toContain('# GitHub activity: acme (2026-06-01 to 2026-06-08) — carol')
    expect(report).toContain(SYNTHESIS.headline)
    expect(report).toContain('## Highlights')
    expect(report).toContain('- **alice** — shipped sync')
    expect(report).toContain('- **acme/app** — sync engine landed')
    expect(report).toContain('## Worth attention')
  })

  it('omits empty sections', () => {
    const report = renderReport({ headline: 'h', highlights: [], byRepo: [] }, { ...meta, user: null })
    expect(report).not.toContain('## By person')
    expect(report).not.toContain('## Worth attention')
    expect(report).not.toContain('user:')
  })

  it('builds a dated, slugged report path', () => {
    expect(reportPath(meta)).toBe('reports/github/2026-06-10-acme-2026-06-01-to-2026-06-08-carol.md')
    expect(reportPath({ ...meta, user: null })).toBe('reports/github/2026-06-10-acme-2026-06-01-to-2026-06-08.md')
  })
})

describe('runSummarize', () => {
  async function seeded(ctx, items, events = []) {
    const itemsCollection = ctx.data.collection('items')
    for (const record of items) await itemsCollection.put(`i-${record.number}`, record)
    const eventsCollection = ctx.data.collection('events')
    for (let i = 0; i < events.length; i++) await eventsCollection.put(`e-${i}`, events[i])
  }

  it('runs a single synthesis pass for small activity and writes the report', async () => {
    const ctx = makeCtx({ aiResponses: [SYNTHESIS] })
    await ctx.data.kv.set('settings', { org: 'acme' })
    await seeded(ctx, [item('acme/app', 12)], [event('acme/app', 'alice')])

    const result = await runSummarize(ctx, { from: '2026-06-01', to: '2026-06-08' }, { nowIso: () => NOW })

    expect(result).toMatchObject({ status: 'complete', headline: SYNTHESIS.headline, itemCount: 1, eventCount: 1 })
    expect(ctx.ai.calls).toHaveLength(1)
    expect(ctx.ai.calls[0].schema).toBe(SYNTHESIS_SCHEMA)
    expect(ctx.ai.calls[0].modelId).toBeUndefined()
    expect(ctx.ai.calls[0].prompt).toContain('acme/app#12')

    const write = ctx.tools.calls.find((c) => c.name === 'fs.write')
    expect(write.params.path).toBe(result.path)
    expect(write.params.content).toContain(SYNTHESIS.headline)

    const reports = await ctx.data.kv.get('reports')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ path: result.path, headline: SYNTHESIS.headline })
  })

  it('map-reduces per repo when activity is large, using the configured model', async () => {
    const digest = { shipped: ['x'], inProgress: [], discussed: [], stuck: [] }
    const ctx = makeCtx({ aiResponses: [digest, digest, SYNTHESIS] })
    await ctx.data.kv.set('settings', { org: 'acme', summaryModel: 'model-x' })
    const items = [
      ...Array.from({ length: 70 }, (_, i) => item('acme/a', i)),
      ...Array.from({ length: 60 }, (_, i) => item('acme/b', 100 + i)),
    ]
    await seeded(ctx, items)

    const result = await runSummarize(ctx, { from: FROM, to: TO }, { nowIso: () => NOW })

    expect(result.itemCount).toBe(130)
    expect(ctx.ai.calls).toHaveLength(3)
    expect(ctx.ai.calls[0].schema).toBe(DIGEST_SCHEMA)
    expect(ctx.ai.calls[0].prompt).toContain('Repository: acme/a') // busiest bucket first
    expect(ctx.ai.calls[1].prompt).toContain('Repository: acme/b')
    expect(ctx.ai.calls[2].schema).toBe(SYNTHESIS_SCHEMA)
    expect(ctx.ai.calls[2].prompt).toContain('Per-repository digests')
    expect(ctx.ai.calls.every((c) => c.modelId === 'model-x')).toBe(true)
  })

  it('threads the focus note into prompts', async () => {
    const ctx = makeCtx({ aiResponses: [SYNTHESIS] })
    await seeded(ctx, [item('acme/app', 12)])
    await runSummarize(ctx, { from: FROM, to: TO, focus: 'deploy readiness' }, { nowIso: () => NOW })
    expect(ctx.ai.calls[0].prompt).toContain('User focus note: deploy readiness')
  })

  it('rejects empty timeframes and bad dates', async () => {
    const ctx = makeCtx()
    await expect(runSummarize(ctx, { from: FROM, to: TO }, { nowIso: () => NOW })).rejects.toThrow(/No synced activity/)
    await expect(runSummarize(ctx, { from: 'yesterday', to: TO }, { nowIso: () => NOW })).rejects.toThrow(/ISO date for "from"/)
    await expect(runSummarize(ctx, { from: FROM }, { nowIso: () => NOW })).rejects.toThrow(/ISO date for "to"/)
  })
})
