// Activity summaries over the local cache. The summarizer never calls GitHub:
// sync first, then read collections, map-reduce through ctx.ai.generateObject,
// and write a markdown report into the workspace.

const BUCKET_THRESHOLD = 120
const MAX_PER_BUCKET = 200

export function gatherActivity({ items, events }, { from, to, user }) {
  const inRange = (iso) => iso && iso >= from && iso <= to
  const matchedItems = items.filter((item) => {
    if (!inRange(item.updatedAt)) return false
    if (user && item.author !== user && !(item.assignees || []).includes(user)) return false
    return true
  })
  const matchedEvents = events.filter((event) => {
    if (!inRange(event.createdAt)) return false
    if (user && event.actor !== user) return false
    return true
  })
  return { items: matchedItems, events: matchedEvents }
}

export function bucketByRepo(activity) {
  const buckets = new Map()
  const ensure = (repo) => {
    if (!buckets.has(repo)) buckets.set(repo, { repo, items: [], events: [] })
    return buckets.get(repo)
  }
  for (const item of activity.items) ensure(item.repo).items.push(item)
  for (const event of activity.events) ensure(event.repo).events.push(event)
  return [...buckets.values()].sort((a, b) => b.items.length + b.events.length - (a.items.length + a.events.length))
}

function itemLine(item) {
  const status = item.mergedAt ? 'merged' : item.state.toLowerCase()
  const people = [item.author, ...(item.assignees || [])].filter(Boolean).join(', ')
  return `[${item.type} ${item.key} ${status}] ${item.title} (${people}; comments: ${item.commentCount}; updated ${item.updatedAt})`
}

function eventLine(event) {
  return `[${event.createdAt}] ${event.actor} @ ${event.repo}: ${event.summary}`
}

export function bucketPrompt(bucket, { from, to, user }) {
  const items = bucket.items.slice(0, MAX_PER_BUCKET).map(itemLine).join('\n')
  const events = bucket.events.slice(0, MAX_PER_BUCKET).map(eventLine).join('\n')
  return [
    `Repository: ${bucket.repo}`,
    `Timeframe: ${from} to ${to}${user ? ` — focus on user ${user}` : ''}`,
    bucket.items.length > MAX_PER_BUCKET || bucket.events.length > MAX_PER_BUCKET
      ? `Note: listing truncated to ${MAX_PER_BUCKET} entries per section.`
      : '',
    items ? `Issues and pull requests:\n${items}` : 'No issue/PR changes.',
    events ? `Activity events:\n${events}` : 'No activity events.',
  ].filter(Boolean).join('\n\n')
}

export const DIGEST_SCHEMA = {
  type: 'object',
  required: ['shipped', 'inProgress', 'discussed', 'stuck'],
  properties: {
    shipped: { type: 'array', items: { type: 'string' }, description: 'Merged/closed work, one line each, mention people and item keys' },
    inProgress: { type: 'array', items: { type: 'string' }, description: 'Open/active work' },
    discussed: { type: 'array', items: { type: 'string' }, description: 'Notable discussions or decisions' },
    stuck: { type: 'array', items: { type: 'string' }, description: 'Stale or blocked-looking work' },
  },
}

export const SYNTHESIS_SCHEMA = {
  type: 'object',
  required: ['headline', 'highlights', 'byRepo'],
  properties: {
    headline: { type: 'string', description: 'One sentence: the shape of the period' },
    highlights: { type: 'array', items: { type: 'string' }, description: '3-8 most important things, cross-repo' },
    byPerson: {
      type: 'array',
      items: {
        type: 'object',
        required: ['login', 'summary'],
        properties: { login: { type: 'string' }, summary: { type: 'string' } },
      },
      description: 'Who did what, one entry per active person (omit when focused on a single user)',
    },
    byRepo: {
      type: 'array',
      items: {
        type: 'object',
        required: ['repo', 'summary'],
        properties: { repo: { type: 'string' }, summary: { type: 'string' } },
      },
    },
    risks: { type: 'array', items: { type: 'string' }, description: 'Stuck/blocked/risky items worth attention' },
  },
}

export function renderReport(synthesis, meta) {
  const lines = [
    '---',
    `range: ${meta.from} .. ${meta.to}`,
    meta.user ? `user: ${meta.user}` : null,
    `org: ${meta.org}`,
    `model: ${meta.model || 'workspace default'}`,
    `items: ${meta.itemCount}`,
    `events: ${meta.eventCount}`,
    `generated: ${meta.generatedAt}`,
    '---',
    '',
    `# GitHub activity: ${meta.org} (${meta.from.slice(0, 10)} to ${meta.to.slice(0, 10)})${meta.user ? ` — ${meta.user}` : ''}`,
    '',
    synthesis.headline,
    '',
    '## Highlights',
    ...(synthesis.highlights || []).map((h) => `- ${h}`),
  ]
  if (synthesis.byPerson?.length) {
    lines.push('', '## By person')
    for (const person of synthesis.byPerson) lines.push(`- **${person.login}** — ${person.summary}`)
  }
  if (synthesis.byRepo?.length) {
    lines.push('', '## By repository')
    for (const repo of synthesis.byRepo) lines.push(`- **${repo.repo}** — ${repo.summary}`)
  }
  if (synthesis.risks?.length) {
    lines.push('', '## Worth attention')
    for (const risk of synthesis.risks) lines.push(`- ${risk}`)
  }
  return lines.filter((l) => l !== null).join('\n') + '\n'
}

export function reportPath(meta) {
  const day = meta.generatedAt.slice(0, 10)
  const slug = [meta.org, meta.from.slice(0, 10), 'to', meta.to.slice(0, 10), meta.user]
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9-]+/g, '-')
  return `reports/github/${day}-${slug}.md`
}

export async function runSummarize(ctx, inputs, { nowIso = () => new Date().toISOString() } = {}) {
  const from = requireIso(inputs.from, 'from')
  const to = requireIso(inputs.to, 'to')
  const user = typeof inputs.user === 'string' && inputs.user ? inputs.user : null
  const focus = typeof inputs.focus === 'string' && inputs.focus.trim() ? inputs.focus.trim().slice(0, 2000) : ''

  const settings = (await ctx.data.kv.get('settings')) || {}
  const modelId = settings.summaryModel || undefined

  await ctx.progress.step('Gathering activity')
  const items = (await ctx.data.collection('items').list()).map((row) => row.value).filter(Boolean)
  const events = (await ctx.data.collection('events').list()).map((row) => row.value).filter(Boolean)
  const activity = gatherActivity({ items, events }, { from, to, user })
  if (activity.items.length === 0 && activity.events.length === 0) {
    throw new Error('No synced activity in that timeframe. Run a sync first or widen the range.')
  }

  const meta = {
    org: settings.org || '',
    from,
    to,
    user,
    model: modelId || '',
    itemCount: activity.items.length,
    eventCount: activity.events.length,
    generatedAt: nowIso(),
  }

  const focusBlock = focus ? `\n\nUser focus note: ${focus}` : ''
  const buckets = bucketByRepo(activity)
  const total = activity.items.length + activity.events.length
  let synthesisInput

  if (total > BUCKET_THRESHOLD && buckets.length > 1) {
    await ctx.progress.step('Summarizing per repository')
    const digests = []
    for (let i = 0; i < buckets.length; i++) {
      ctx.abort?.throwIfAborted?.()
      await ctx.progress.progress(0.15 + (0.55 * i) / buckets.length, buckets[i].repo)
      const digest = await ctx.ai.generateObject({
        modelId,
        system: 'You digest GitHub repository activity. Be concrete: name people, item keys (owner/repo#N), and outcomes. No filler.',
        prompt: `${bucketPrompt(buckets[i], meta)}${focusBlock}`,
        schema: DIGEST_SCHEMA,
      })
      digests.push({ repo: buckets[i].repo, ...digest })
    }
    synthesisInput = `Per-repository digests (JSON):\n${JSON.stringify(digests, null, 1)}`
  } else {
    synthesisInput = buckets.map((bucket) => bucketPrompt(bucket, meta)).join('\n\n---\n\n')
  }

  await ctx.progress.step('Writing summary')
  const synthesis = await ctx.ai.generateObject({
    modelId,
    system: [
      'You write a sharp activity summary for a software organization.',
      'Audience: a lead catching up. Name people and item keys (owner/repo#N).',
      'Plain statements over adjectives; skip anything you would not say out loud in standup.',
      user ? `The summary is about user ${user} specifically.` : 'Cover the whole org; include byPerson.',
    ].join(' '),
    prompt: `Timeframe: ${from} to ${to}.${focusBlock}\n\n${synthesisInput}`,
    schema: SYNTHESIS_SCHEMA,
  })

  const path = reportPath(meta)
  const content = renderReport(synthesis, meta)
  await ctx.tools.call('fs.write', { path, content })

  const reports = (await ctx.data.kv.get('reports')) || []
  reports.unshift({ path, from, to, user, generatedAt: meta.generatedAt, headline: synthesis.headline })
  await ctx.data.kv.set('reports', reports.slice(0, 100))

  await ctx.progress.done(`Report written: ${path}`)
  return { status: 'complete', path, headline: synthesis.headline, itemCount: meta.itemCount, eventCount: meta.eventCount }
}

function requireIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`summarize requires an ISO date for "${label}"`)
  }
  return new Date(Date.parse(value)).toISOString()
}
