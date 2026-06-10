import { describe, it, expect } from 'vitest'
import { createGitHub, headerGet, RateLimitError } from './github.mjs'
import { scriptedHttp } from '../test/harness.mjs'

const TOKEN = 'ghp_test'

describe('createGitHub', () => {
  it('requires a token', () => {
    expect(() => createGitHub({ http: scriptedHttp([]), token: null })).toThrow(/token is not set/i)
  })
})

describe('graphql', () => {
  it('POSTs with auth headers and returns data', async () => {
    const http = scriptedHttp([
      {
        match: (input) => input.url === 'https://api.github.com/graphql',
        respond: { body: { data: { viewer: { login: 'alice' } } } },
      },
    ])
    const gh = createGitHub({ http, token: TOKEN })
    const data = await gh.graphql('query { viewer { login } }', { a: 1 })
    expect(data.viewer.login).toBe('alice')
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0].method).toBe('POST')
    expect(http.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(http.calls[0].headers['x-github-api-version']).toBe('2022-11-28')
    expect(JSON.parse(http.calls[0].body)).toEqual({ query: 'query { viewer { login } }', variables: { a: 1 } })
  })

  it('throws on GraphQL errors with the message', async () => {
    const http = scriptedHttp([
      { match: () => true, respond: { body: { errors: [{ type: 'NOT_FOUND', message: 'no such org' }] } } },
    ])
    const gh = createGitHub({ http, token: TOKEN })
    await expect(gh.graphql('query {}')).rejects.toThrow(/no such org/)
  })

  it('throws RateLimitError on RATE_LIMITED GraphQL errors', async () => {
    const http = scriptedHttp([
      { match: () => true, respond: { body: { errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] } } },
    ])
    const gh = createGitHub({ http, token: TOKEN })
    await expect(gh.graphql('query {}')).rejects.toBeInstanceOf(RateLimitError)
  })

  it('throws when the body has no data', async () => {
    const http = scriptedHttp([{ match: () => true, respond: { body: {} } }])
    const gh = createGitHub({ http, token: TOKEN })
    await expect(gh.graphql('query {}')).rejects.toThrow(/no data/)
  })
})

describe('rest', () => {
  it('GETs a path, returns body and etag, and exposes the raw response', async () => {
    const http = scriptedHttp([
      {
        match: (input) => input.url === 'https://api.github.com/user',
        respond: { body: { login: 'alice' }, headers: { etag: 'W/"abc"', 'x-oauth-scopes': 'repo, read:org' } },
      },
    ])
    const gh = createGitHub({ http, token: TOKEN })
    const result = await gh.rest('/user')
    expect(result.status).toBe(200)
    expect(result.notModified).toBe(false)
    expect(result.body.login).toBe('alice')
    expect(result.etag).toBe('W/"abc"')
    expect(headerGet(result.response, 'x-oauth-scopes')).toBe('repo, read:org')
  })

  it('sends if-none-match and treats 304 as notModified', async () => {
    const http = scriptedHttp([{ match: () => true, respond: { status: 304 } }])
    const gh = createGitHub({ http, token: TOKEN })
    const result = await gh.rest('orgs/acme/events', { etag: 'W/"abc"' })
    expect(http.calls[0].headers['if-none-match']).toBe('W/"abc"')
    expect(result.notModified).toBe(true)
    expect(result.body).toBeNull()
  })

  it('maps 401 to a token error', async () => {
    const http = scriptedHttp([{ match: () => true, respond: { status: 401, body: { message: 'Bad credentials' } } }])
    const gh = createGitHub({ http, token: TOKEN })
    await expect(gh.rest('user')).rejects.toThrow(/rejected the token \(401\)/)
  })

  it('maps 403 + retry-after to RateLimitError with a resume time', async () => {
    const http = scriptedHttp([
      { match: () => true, respond: { status: 403, headers: { 'retry-after': '30' }, body: { message: 'abuse' } } },
    ])
    const gh = createGitHub({ http, token: TOKEN })
    const err = await gh.rest('user').catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.resumeAt).toBeGreaterThan(Date.now())
  })

  it('maps 403 + exhausted primary limit to RateLimitError at the reset epoch', async () => {
    const http = scriptedHttp([
      {
        match: () => true,
        respond: {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1780000000' },
          body: { message: 'API rate limit exceeded' },
        },
      },
    ])
    const gh = createGitHub({ http, token: TOKEN })
    const err = await gh.rest('user').catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.resumeAt).toBe(1780000000 * 1000)
  })

  it('maps plain 403 to an ordinary error', async () => {
    const http = scriptedHttp([
      { match: () => true, respond: { status: 403, body: { message: 'Resource not accessible' } } },
    ])
    const gh = createGitHub({ http, token: TOKEN })
    await expect(gh.rest('user')).rejects.toThrow(/denied the request \(403\): Resource not accessible/)
  })

  it('maps other failures to an error with the status', async () => {
    const http = scriptedHttp([{ match: () => true, respond: { status: 502, body: { message: 'bad gateway' } } }])
    const gh = createGitHub({ http, token: TOKEN })
    await expect(gh.rest('user')).rejects.toThrow(/failed \(502\)/)
  })
})

describe('headerGet', () => {
  it('returns null when the platform strips headers', () => {
    expect(headerGet({ ok: true, status: 200 }, 'etag')).toBeNull()
    expect(headerGet(null, 'etag')).toBeNull()
  })
})
