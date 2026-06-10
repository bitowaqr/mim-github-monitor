// Fake runtime ctx for tests. Mirrors the Mim package runtime contract:
// data (kv + collections), http (scripted), secrets, ai (scripted), progress
// (recorded), abort, tools.call (recorded). Mock only at system boundaries.

export function memoryData() {
  const kv = new Map()
  const collections = new Map()
  return {
    kv: {
      async get(key) {
        return kv.has(key) ? structuredClone(kv.get(key)) : null
      },
      async set(key, value) {
        kv.set(key, structuredClone(value))
      },
      async delete(key) {
        kv.delete(key)
      },
      async keys() {
        return [...kv.keys()]
      },
    },
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map())
      const store = collections.get(name)
      return {
        async get(id) {
          return store.has(id) ? structuredClone(store.get(id)) : null
        },
        async put(id, value) {
          store.set(id, structuredClone(value))
        },
        async delete(id) {
          store.delete(id)
        },
        async list() {
          return [...store.entries()].map(([id, value]) => ({ id, value: structuredClone(value) }))
        },
      }
    },
  }
}

// Scripted HTTP client: routes are matched in order; a route is
// { match: (input) => boolean, respond: (input, callIndex) => responseSpec }.
// responseSpec: { status?, body?, headers?, error? }.
export function scriptedHttp(routes) {
  const calls = []
  return {
    calls,
    async request(input) {
      calls.push(input)
      const route = routes.find((r) => r.match(input))
      if (!route) throw new Error(`No scripted route for ${input.method || 'GET'} ${input.url}`)
      const spec = typeof route.respond === 'function' ? route.respond(input, calls.length - 1) : route.respond
      if (spec.error) throw spec.error
      const status = spec.status ?? 200
      const headers = new Map(Object.entries(spec.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
      const text = spec.body === undefined ? '' : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body)
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
        json: async () => JSON.parse(text),
        text: async () => text,
      }
    },
  }
}

export function makeCtx({ http, secrets = {}, aiResponses = [], now = '2026-06-10T12:00:00.000Z' } = {}) {
  const data = memoryData()
  const progress = { steps: [], progresses: [], doneMessage: null }
  const toolCalls = []
  const aiCalls = []
  let aiIndex = 0
  let aborted = false

  return {
    package: { id: 'github-monitor', name: 'GitHub Monitor', version: '0.1.0' },
    job: { id: 'test', runId: 'run-test', startedAt: now },
    data,
    http: http ?? scriptedHttp([]),
    secrets: {
      async get(name) {
        if (!(name in secrets)) return null
        return secrets[name]
      },
      async set(name, value) {
        secrets[name] = value
      },
      async delete(name) {
        delete secrets[name]
      },
      async has(name) {
        return name in secrets
      },
    },
    ai: {
      calls: aiCalls,
      async generateObject(input) {
        aiCalls.push(input)
        if (aiIndex >= aiResponses.length) throw new Error('Harness ran out of scripted ai responses')
        const response = aiResponses[aiIndex++]
        return typeof response === 'function' ? response(input) : structuredClone(response)
      },
    },
    progress: {
      records: progress,
      async step(title) {
        progress.steps.push(title)
      },
      async progress(fraction, message) {
        progress.progresses.push({ fraction, message })
      },
      async log() {},
      async done(message) {
        progress.doneMessage = message
      },
    },
    abort: {
      get aborted() {
        return aborted
      },
      throwIfAborted() {
        if (aborted) throw new Error('Aborted')
      },
      trigger() {
        aborted = true
      },
    },
    tools: {
      calls: toolCalls,
      async call(name, params) {
        toolCalls.push({ name, params })
        return { ok: true }
      },
    },
  }
}
