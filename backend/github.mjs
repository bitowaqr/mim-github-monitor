// GitHub API client over the package runtime's ctx.http.
// Pure logic over an injected http client so tests run against scripts.

const API = 'https://api.github.com'

export class RateLimitError extends Error {
  constructor(message, resumeAt) {
    super(message)
    this.name = 'RateLimitError'
    this.resumeAt = resumeAt ?? null
  }
}

// ctx.http passes the underlying fetch Response through, which carries
// headers — but the platform HttpResponse interface does not declare them.
// Feature-detect so the package degrades (no ETags, no rate telemetry)
// instead of crashing if the platform ever wraps responses.
export function headerGet(response, name) {
  const headers = response?.headers
  if (headers && typeof headers.get === 'function') return headers.get(name)
  return null
}

async function readBody(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function rateLimitFromResponse(response, body) {
  // Secondary limits send retry-after seconds; primary limits send a reset epoch.
  const retryAfter = Number(headerGet(response, 'retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000
  const remaining = headerGet(response, 'x-ratelimit-remaining')
  const reset = Number(headerGet(response, 'x-ratelimit-reset'))
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) return reset * 1000
  if (typeof body?.message === 'string' && /rate limit/i.test(body.message)) return null
  return undefined // not a rate-limit response
}

export function createGitHub({ http, token }) {
  if (!token) throw new Error('GitHub token is not set. Open GitHub Monitor settings and add a token.')

  const baseHeaders = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'mim-github-monitor',
  }

  async function request(input) {
    const response = await http.request(input)
    if (response.status === 304) return { status: 304, notModified: true, body: null, response }
    const body = await readBody(response)
    if (response.status === 401) throw new Error('GitHub rejected the token (401). Check it in GitHub Monitor settings.')
    if (response.status === 403 || response.status === 429) {
      const resumeAt = rateLimitFromResponse(response, body)
      if (resumeAt !== undefined) {
        throw new RateLimitError(
          `GitHub rate limit hit${resumeAt ? `; resets ${new Date(resumeAt).toISOString()}` : ''}`,
          resumeAt,
        )
      }
      throw new Error(`GitHub denied the request (403): ${body?.message || 'forbidden'}`)
    }
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${body?.message || 'error'}`)
    return { status: response.status, notModified: false, body, response }
  }

  return {
    // GraphQL with rateLimit telemetry appended to every query.
    async graphql(query, variables = {}) {
      const { body } = await request({
        url: `${API}/graphql`,
        method: 'POST',
        headers: { ...baseHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const rateLimited = body.errors.some((e) => e.type === 'RATE_LIMITED')
        const message = body.errors.map((e) => e.message).join('; ')
        if (rateLimited) throw new RateLimitError(`GitHub GraphQL rate limited: ${message}`, null)
        throw new Error(`GitHub GraphQL error: ${message}`)
      }
      if (!body?.data) throw new Error('GitHub GraphQL returned no data')
      return body.data
    },

    // REST GET with optional conditional request. 304s are free against the limit.
    async rest(path, { etag } = {}) {
      const headers = { ...baseHeaders }
      if (etag) headers['if-none-match'] = etag
      const result = await request({ url: `${API}/${path.replace(/^\//, '')}`, headers })
      return {
        status: result.status,
        notModified: result.notModified,
        body: result.body,
        etag: headerGet(result.response, 'etag'),
        response: result.response,
      }
    },
  }
}
