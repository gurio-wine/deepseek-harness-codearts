import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import {
  buildLoginUrl,
  buildOAuthLoginUrl,
  buildPortalLoginResultUrl,
  expiresFromCredential,
  generateRandomSecret,
  hasActiveCodeartsLogin,
  LOGIN_PLUGIN_NAME,
  LOGIN_PLUGIN_VERSION,
  listenOnCallbackPort,
  MIN_CALLBACK_PORT,
  parseCredentialResponse,
  pollForCredential,
  PORTAL_AUTHORIZE_BASE,
  prepareCodeartsLogin,
  runLoginFlow,
  runOAuthFlow,
  startCallbackServer,
  startOAuthCallbackServer,
  type CodeartsLoginPrepareOptions,
  type CodeartsPendingLogin,
} from '../../src/login.js'
import { generateDpopKeyPair } from '../../src/oauth.js'
import type { CodeArtsCredential } from '../../src/types.js'

describe('generateRandomSecret', () => {
  it('produces 64 lowercase hex chars and differs across calls', () => {
    const a = generateRandomSecret()
    const b = generateRandomSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildLoginUrl', () => {
  it('wraps the redirect into the Huawei auth page', () => {
    const { redirectUrl, loginUrl } = buildLoginUrl(43123, 'ticket-123')
    expect(redirectUrl).toBe(
      'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
        + '?IdeaType=jetbrains'
        + `&auth_callback_url=${encodeURIComponent('http://127.0.0.1:43123/authentication')}`
        + '&plugin-name=snap_jetbrains&plugin-version=26.3.3'
        + '&ticket_id=ticket-123',
    )
    expect(loginUrl).toBe(
      'https://auth.huaweicloud.com/authui/login.html'
        + `?service=${encodeURIComponent(redirectUrl)}`,
    )
  })
})

describe('parseCredentialResponse', () => {
  it('parses the credential branch', () => {
    const c = parseCredentialResponse({
      credential: {
        access: 'AK',
        secret: 'SK',
        securitytoken: 'ST',
        expires_at: '2026-08-15T00:00:00Z',
      },
      domain_id: 'dom', user_id: 'uid', user_name: 'uname',
    })
    expect(c).toEqual({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
      domain_id: 'dom', user_id: 'uid', user_name: 'uname',
    })
  })

  it('parses the result branch (camelCase)', () => {
    const c = parseCredentialResponse({
      result: { accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'ST', expiration: '2026-08-15T00:00:00Z' },
    })
    expect(c).toEqual({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
    })
  })

  it('returns null when a branch is incomplete', () => {
    expect(parseCredentialResponse({ credential: { access: 'AK' } })).toBeNull()
    expect(parseCredentialResponse({})).toBeNull()
  })
})

describe('expiresFromCredential', () => {
  it('parses expires_at and falls back to +24h', () => {
    const parsed: CodeArtsCredential = {
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z',
    }
    expect(expiresFromCredential(parsed)).toBe(Date.parse('2026-08-15T00:00:00Z'))
    expect(expiresFromCredential({ ...parsed, expires_at: 'garbage' })).toBeGreaterThan(Date.now())
  })
})

describe('pollForCredential', () => {
  const complete = JSON.stringify({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-08-15T00:00:00Z' },
  })

  it('returns the first complete credential', async () => {
    const fetcher = vi.fn(async () => new Response(complete, { status: 200 }))
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 3 })
    expect(credential.access_key_id).toBe('AK')
    expect(credential.security_token).toBe('ST')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('skips non-ok responses, unparseable bodies, and incomplete branches', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response('nope', { status: 500 })
      if (calls === 2) return new Response('not json', { status: 200 })
      if (calls === 3) return new Response(JSON.stringify({ credential: { access: 'AK' } }), { status: 200 })
      return new Response(complete, { status: 200 })
    })
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 4 })
    expect(credential.access_key_id).toBe('AK')
    expect(calls).toBe(4)
  })

  it('survives transient network errors', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return new Response(complete, { status: 200 })
    })
    const credential = await pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 2 })
    expect(credential.access_key_id).toBe('AK')
  })

  it('throws when the budget is exhausted', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(pollForCredential('ticket-1', 'secret-1', { fetcher, maxAttempts: 2 }))
      .rejects.toThrow('CodeArts login timed out')
  })

  it('builds the expected endpoint URL with encoded query values', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(pollForCredential('a b', 'c&d', { fetcher, maxAttempts: 1 })).rejects.toThrow()
    const url = new URL(fetcher.mock.calls[0][0] as string)
    expect(url.searchParams.get('ticket_id')).toBe('a b')
    expect(url.searchParams.get('secret')).toBe('c&d')
  })
})

describe('startCallbackServer', () => {
  const complete = JSON.stringify({
    credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-08-15T00:00:00Z' },
  })

  async function hit(port: number, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, init)
  }

  it('resolves a direct token callback', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      const response = await hit(server.port, '/authentication?token=abc')
      expect(response.status).toBe(200)
      const result = await server.result
      expect(result.access).toBe('abc')
      expect(result.expires).toBeGreaterThan(Date.now())
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('resolves the fingerprint branch (base64 URL containing a token)', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      const inner = `http://host/cb?access_token=fp-token`
      const fingerprint = Buffer.from(inner).toString('base64')
      const response = await hit(server.port, `/authentication?fingerprint=${encodeURIComponent(fingerprint)}`)
      expect(response.status).toBe(200)
      const result = await server.result
      expect(result.access).toBe('fp-token')
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('resolves the secret branch through polling', async () => {
    const fetcher = vi.fn(async () => new Response(complete, { status: 200 }))
    const server = await startCallbackServer('ticket-1', 'secret-1', { fetcher, maxAttempts: 3 })
    try {
      const response = await hit(server.port, '/authentication?secret=cb-secret')
      expect(response.status).toBe(200)
      const result = await server.result
      const credential = JSON.parse(result.access) as CodeArtsCredential
      expect(credential.access_key_id).toBe('AK')
      expect(credential.security_token).toBe('ST')
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })

  it('answers 404 for foreign paths and 400 for a tokenless callback', async () => {
    const server = await startCallbackServer('ticket-1', 'secret-1', {})
    try {
      expect((await hit(server.port, '/other')).status).toBe(404)
      expect((await hit(server.port, '/authentication')).status).toBe(400)
    } finally {
      await new Promise((resolve) => server.server.close(resolve))
    }
  })
})

describe('runLoginFlow', () => {
  it('opens the login URL, resolves through a direct token callback, and closes the server', async () => {
    const opened: string[] = []
    const flow = runLoginFlow({ openBrowser: (url) => void opened.push(url) })
    // 服务器在 promise 完成后启动；通过流程的 loginUrl 等待端口。
    // 通过从 login URL 中解码端口号来模拟浏览器回调。
    const loginUrl = await waitFor(() => opened[0])
    const service = new URL(loginUrl).searchParams.get('service') as string
    const redirect = new URL(decodeURIComponent(service))
    const callback = new URL(redirect.searchParams.get('auth_callback_url') as string)
    const response = await fetch(`http://127.0.0.1:${callback.port}/authentication?token=from-browser`)
    expect(response.status).toBe(200)
    const result = await flow
    expect(result.access).toBe('from-browser')
    expect(result.loginUrl).toBe(loginUrl)
  })
})

async function waitFor<T>(get: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** 已占用的高位端口（{@link reserveHighPort} 登记，供 {@link closeReservedPort} 释放）。 */
const reservedPorts = new Map<number, ReturnType<typeof createServer>>()

/**
 * 真实占住一个 **≥ {@link MIN_CALLBACK_PORT}** 的随机端口，返回该端口号。
 *
 * 刻意**直接绑定随机高位端口**（与生产代码 `randomCallbackPort()` 同一做法），
 * 而不是循环 `listen(0)` 去采样：Windows 的动态端口范围默认是 1024–14999
 * （`netsh int ipv4 show dynamicport tcp`），且 `listen(0)` 是**顺序分配**的 ——
 * 连开 12 个会得到 3527,3528,…,3538。靠采样拿 ≥10000 的端口，在 Windows 上
 * 几乎必然失败。
 *
 * 随机高位端口也可能落在**系统保留段**（`netsh int ipv4 show
 * excludedportrange protocol=tcp`，实测约 1/40 概率 EACCES），故失败即换端口
 * 重试；这与 `listenOnCallbackPort` 自身的重试策略同源。
 */
async function reserveHighPort(attempts = 20): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT
    const server = createServer()
    const bound = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (bound) {
      reservedPorts.set(port, server)
      return port
    }
    server.close()
  }
  throw new Error(`无法占住任何 ≥${MIN_CALLBACK_PORT} 的端口（保留段过多）`)
}

/** 释放 {@link reserveHighPort} 占住的端口（幂等）。 */
async function closeReservedPort(port: number): Promise<void> {
  const server = reservedPorts.get(port)
  if (server === undefined) return
  reservedPorts.delete(port)
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('buildOAuthLoginUrl', () => {
  it('matches the reverse-engineered portal authorize parameters', () => {
    const pkce = { codeVerifier: 'VERIFIER', codeChallenge: 'CHALLENGE' }
    const url = buildOAuthLoginUrl(43123, pkce, 'a'.repeat(64))
    expect(url).toBe(
      `${PORTAL_AUTHORIZE_BASE}?theme=${'2'}&locale=${'zh-cn'}`
      + '&uri_scheme=codearts-agent&client_id=codearts-agent&port=43123'
      // code_challenge_method 对齐真实插件（SHA-256 而非 S256）。
      + '&code_challenge=CHALLENGE&code_challenge_method=SHA-256'
      + `&ticket_id=${'a'.repeat(64)}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`,
    )
  })
})

describe('startOAuthCallbackServer', () => {
  it('exchanges the authorization code and resolves the stored credential JSON', async () => {
    // 模拟 STS 端点：返回完整凭据。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expiration: '2026-08-15T00:00:00Z',
      },
      refresh_token: 'RT',
    }), { status: 200 }))
    const pkce = { codeVerifier: 'VERIFIER', codeChallenge: 'CHALLENGE' }
    const keyPair = await generateDpopKeyPair()
    const { port, server, result } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, { fetcher: fetcher as unknown as typeof fetch })

    // 以真实 HTTP 请求触发回调：/oauth/callback?code=CODE
    // redirect: 'manual' —— 不自动跟随 307，以便断言重定向本身。
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=CODE`, { redirect: 'manual' })
    expect(res.status).toBe(307)
    // 换取成功后浏览器被 307 重定向到 portal 登录结果页（对齐真实插件）。
    expect(res.headers.get('location')).toBe(buildPortalLoginResultUrl(true))
    const outcome = await result
    const credential = JSON.parse(outcome.access) as Record<string, string>
    expect(credential).toMatchObject({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expires_at: '2026-08-15T00:00:00Z', refresh_token: 'RT', code_verifier: 'VERIFIER',
    })
    await new Promise((resolve) => server.close(resolve))
  })

  it('falls back to the legacy ticket poll when the portal sends a secret callback', async () => {
    // 模拟 snap-manager ticket 端点：返回完整凭据（旧流程回退路径）。
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credential: {
        access: 'AK', secret: 'SK', securitytoken: 'ST',
        expires_at: '2026-08-15T00:00:00Z',
      },
      user_id: 'u-1', user_name: 'tester', domain_id: 'd-1',
    }), { status: 200 }))
    const pkce = { codeVerifier: 'VERIFIER', codeChallenge: 'CHALLENGE' }
    const keyPair = await generateDpopKeyPair()
    const { port, server, result } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, { fetcher: fetcher as unknown as typeof fetch })

    // 以真实 HTTP 请求触发回调：/oauth/callback?secret=<portal secret>&redirect=<portal login 页>
    const redirectTarget = 'https://codearts.huaweicloud.com/portal/login?login_succeed=true&uri_scheme=codearts-agent&locale=zh-cn'
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?secret=PORTAL-SECRET&redirect=${encodeURIComponent(redirectTarget)}`, { redirect: 'manual' })
    expect(res.status).toBe(307)
    // 旧流程回退：立即 307 重定向到 portal 回传的 redirect 地址（对齐真实插件）。
    expect(res.headers.get('location')).toBe(redirectTarget)
    const outcome = await result
    const credential = JSON.parse(outcome.access) as Record<string, string>
    expect(credential.access_key_id).toBe('AK')
    expect(credential.security_token).toBe('ST')
    // 旧流程凭据无 refresh_token → refreshable 由服务层判定为 false。
    expect(credential.refresh_token).toBeUndefined()
    // 轮询请求头使用新式插件名（对齐真实插件的 snap_AIIDE/5.2.0）。
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/login/ticket')
    const headers = init.headers as Record<string, string>
    expect(headers['plugin-name']).toBe(LOGIN_PLUGIN_NAME)
    expect(headers['plugin-version']).toBe(LOGIN_PLUGIN_VERSION)
    await new Promise((resolve) => server.close(resolve))
  })

  it('responds 400 without an authorization code or secret', async () => {
    const pkce = { codeVerifier: 'V', codeChallenge: 'C' }
    const keyPair = await generateDpopKeyPair()
    const { port, server } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, {})
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback`)
    expect(res.status).toBe(400)
    await new Promise((resolve) => server.close(resolve))
  })

  it('listens on a callback port >= 10000 (portal requirement)', async () => {
    const pkce = { codeVerifier: 'V', codeChallenge: 'C' }
    const keyPair = await generateDpopKeyPair()
    const { port, server } = await startOAuthCallbackServer('ticket-123', pkce, keyPair, {})
    expect(port).toBeGreaterThanOrEqual(10_000)
    await new Promise((resolve) => server.close(resolve))
  })
})

describe('runOAuthFlow', () => {
  it('opens the login URL, exchanges the code and returns access/expires/loginUrl', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expiration: '2026-08-15T00:00:00Z',
      },
      refresh_token: 'RT',
    }), { status: 200 }))
    const opened: string[] = []
    const openBrowser = (url: string) => { opened.push(url) }
    // runOAuthFlow 会 await openBrowser 的返回值；同步返回即可。
    const flowPromise = runOAuthFlow({ fetcher: fetcher as unknown as typeof fetch, openBrowser })

    // 等待回调服务器就绪（runOAuthFlow 内部先起服务器再开浏览器）——用短轮询。
    await vi.waitFor(async () => {
      expect(opened.length).toBe(1)
    }, { timeout: 2000 })
    const loginUrl = opened[0]
    const url = new URL(loginUrl)
    const codeChallenge = url.searchParams.get('code_challenge')
    expect(codeChallenge).toBeTruthy()
    // 从打开的 URL 解析端口并发起回调。
    const port = url.searchParams.get('port')
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=CODE`, { redirect: 'manual' })
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(buildPortalLoginResultUrl(true))

    const outcome = await flowPromise
    expect(outcome.loginUrl).toBe(loginUrl)
    expect(outcome.expires).toBe(Date.parse('2026-08-15T00:00:00Z'))
    const credential = JSON.parse(outcome.access) as Record<string, string>
    expect(credential.refresh_token).toBe('RT')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 两段式（prepareCodeartsLogin + awaitCredential）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 启动登录流程并**立即**把结算结果转成一个已处理的 Promise。
 *
 * 为什么需要它：这些用例要先 `await callback(...)` 触发回调，之后才断言结果。
 * 而回调一返回，promise 就已经 settle 了 —— 在「已 settle」到「被 await」
 * 之间那段窗口里，Node 会把它视为**未处理的拒绝**并让 vitest 报 unhandled
 * error（用例仍全绿，但退出码非 0）。先挂上 then/catch 把状态取出来，
 * 窗口就消失了；断言仍在后面进行。
 */
function started<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
}

/**
 * 本文件创建过的会话句柄。
 *
 * `prepareCodeartsLogin` 的互斥状态是**模块级**的，一条用例留下未结算会话
 * 会污染同文件后续所有用例（它们会拿到 `login-in-progress`），
 * 故每个用例结束都要 cancel 掉自己创建的会话。
 */
const createdSessions: CodeartsPendingLogin[] = []

/** 为用例登记一个会话（返回同一对象，便于链式使用）。 */
function track(session: CodeartsPendingLogin): CodeartsPendingLogin {
  createdSessions.push(session)
  return session
}

afterEach(async () => {
  for (const session of createdSessions) session.cancel('用例清理')
  createdSessions.length = 0
  await vi.waitFor(() => { expect(hasActiveCodeartsLogin()).toBe(false) })
})

describe('prepareCodeartsLogin / awaitCredential（两段式）', () => {
  /** 模拟 STS token 端点：返回完整凭据 + refresh_token。 */
  function stsFetcher(): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify({
      credentials: {
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
        expiration: '2026-08-15T00:00:00Z',
      },
      refresh_token: 'RT',
    }), { status: 200 })) as unknown as typeof fetch
  }

  /** prepare 一个会话并断言成功（互斥冲突会让用例直接失败，附带原因）。 */
  async function prepare(
    options: Partial<CodeartsLoginPrepareOptions> = {},
  ): Promise<CodeartsPendingLogin> {
    const outcome = await prepareCodeartsLogin(options)
    if (!outcome.ok) throw new Error(`prepare 失败：${outcome.error} / ${outcome.message}`)
    return track(outcome.session)
  }

  /** 用真实 HTTP 请求模拟浏览器回调；返回响应（不自动跟随 307）。 */
  async function callback(loginUrl: string, query: string): Promise<Response> {
    const port = new URL(loginUrl).searchParams.get('port')
    return fetch(`http://127.0.0.1:${port}/oauth/callback?${query}`, { redirect: 'manual' })
  }

  it('prepare 返回 loginUrl 与 ≥10000 的端口，且**不打开浏览器**', async () => {
    const session = await prepare({ fetcher: stsFetcher() })
    const url = new URL(session.loginUrl)
    expect(url.searchParams.get('port')).toBe(String(session.port))
    // 打开动作已移出流程：prepare 阶段唯一的副作用是起回调服务器，
    // 此刻端口已在监听（能收到请求并给出 400，而不是连接失败）。
    expect(session.port).toBeGreaterThanOrEqual(10_000)
    const response = await callback(session.loginUrl, '')
    expect(response.status).toBe(400)
    // PKCE 挑战与 SHA-256 方法（非 RFC 的 S256）语义不变。
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('code_challenge_method')).toBe('SHA-256')
  })

  it('回调带 code → awaitCredential 换回凭据，且 307 到 portal 结果页', async () => {
    const session = await prepare({ fetcher: stsFetcher(), timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const response = await callback(session.loginUrl, 'code=CODE')
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(buildPortalLoginResultUrl(true))

    const { value } = await settled
    expect(value).toBeDefined()
    expect(value!.loginUrl).toBe(session.loginUrl)
    expect(value!.expires).toBe(Date.parse('2026-08-15T00:00:00Z'))
    const credential = JSON.parse(value!.access) as Record<string, string>
    expect(credential).toMatchObject({
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', refresh_token: 'RT',
    })
    // code_verifier 随凭据持久化（刷新换取时需要它）。
    expect(credential.code_verifier).toBeTruthy()
  })

  it('旧流程 secret 回退：307 到 portal 回传的 redirect 并轮询换取凭据', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      credential: {
        access: 'AK', secret: 'SK', securitytoken: 'ST',
        expires_at: '2026-08-15T00:00:00Z',
      },
    }), { status: 200 })) as unknown as typeof fetch
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const redirectTarget = 'https://codearts.huaweicloud.com/portal/login?login_succeed=true'
    const response = await callback(
      session.loginUrl,
      `secret=PORTAL-SECRET&redirect=${encodeURIComponent(redirectTarget)}`,
    )
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(redirectTarget)

    const { value } = await settled
    const credential = JSON.parse(value!.access) as Record<string, string>
    expect(credential.access_key_id).toBe('AK')
    // 轮询请求头使用新式插件名（对齐真实插件的 snap_AIIDE/5.2.0）。
    const [reqUrl, init] = (fetcher as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
    expect(reqUrl).toContain('/v1/login/ticket')
    expect((init.headers as Record<string, string>)['plugin-name']).toBe(LOGIN_PLUGIN_NAME)
  })

  it('换取失败时 307 到 portal 失败页且 awaitCredential 抛出原因', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant', error_code: 'InvalidPKCE',
    }), { status: 400 })) as unknown as typeof fetch
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const response = await callback(session.loginUrl, 'code=BAD')
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(buildPortalLoginResultUrl(false))
    const { error } = await settled
    expect(String(error)).toMatch(/CodeArts token request failed/)
  })

  it('超时抛出可读错误，并释放回调端口', async () => {
    const session = await prepare({ fetcher: stsFetcher(), timeoutMs: 50 })
    await expect(session.awaitCredential()).rejects.toThrow(/CodeArts OAuth login timed out/)
    // 服务器已关闭：再请求应连接失败。
    await expect(callback(session.loginUrl, 'code=x')).rejects.toThrow()
  })

  it('cancel 释放端口与互斥，并让 awaitCredential 以错误结算', async () => {
    const session = await prepare({ fetcher: stsFetcher(), timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    session.cancel('测试取消')
    const { error } = await settled
    expect(String(error)).toMatch(/测试取消/)
    await vi.waitFor(() => { expect(hasActiveCodeartsLogin()).toBe(false) })
    await expect(callback(session.loginUrl, 'code=x')).rejects.toThrow()
  })

  it('非回调路径返回 404', async () => {
    const session = await prepare({ fetcher: stsFetcher(), timeoutMs: 5000 })
    const response = await fetch(`http://127.0.0.1:${session.port}/other`)
    expect(response.status).toBe(404)
  })

  it('随机端口 listen 失败时换端口重试，而不是整次登录失败', async () => {
    // 回归用例：原 `listenOnCallbackPort` 用 `server.once('error', reject)` 把
    // reject 直接交给整个 Promise，于是**挑选随机端口失败**被当成**登录流程
    // 失败**抛出。实测（Windows 保留段含 12727-12826 等）：全量测试下约 1/12
    // 概率命中，表现为 `Error: listen EACCES: permission denied 127.0.0.1:12815`。
    //
    // 这里用 `listenOnCallbackPort` 的测试注入口确定性地复现「首次挑端口失败」：
    // 先真实占住一个 ≥10000 的端口，让首次尝试必然 EADDRINUSE（与保留段的
    // EACCES 走同一条 error 路径），重试端口则给一个空白端口。
    //
    // ⚠️ 占位端口**必须直接绑定随机的 ≥10000 端口**（与生产代码
    // `randomCallbackPort()` 同一做法），不能靠循环 `listen(0)` 去采样：
    // Windows 的动态端口范围默认是 1024–14999（`netsh int ipv4 show dynamicport
    // tcp`），且 `listen(0)` 是**顺序分配**的（实测连开 12 个得到
    // 3527,3528,…,3538）。采样 30 次几乎必然全部 <10000，`blockedPort` 恒为 0，
    // 断言 `>= MIN_CALLBACK_PORT` 在改动前就必然失败 —— 那是用例取样方式的问题，
    // 不是被测代码（生产侧「端口 <10000 就换随机端口重试」的分支一直是好的）。
    const blockedPort = await reserveHighPort()
    // 重试端口必须是**真实的空白高位端口**，不能写 `() => 0`：`0` 的语义是
    // 「请系统分配」，而系统分配同样落在动态范围（1024–14999）里、通常 <10000，
    // 于是 `listenOnCallbackPort` 会不断 close 重试直到用尽 CALLBACK_PORT_ATTEMPTS
    // 并以「未能获得 ≥10000 的端口」reject —— 用例会以另一种方式失败。
    const freePort = await reserveHighPort()
    await closeReservedPort(freePort)

    const callbackServer = createServer((_req, res) => res.end('ok'))
    try {
      // 首次端口 = 被占用端口（必然 EADDRINUSE），重试端口 = 空白高位端口（必然可用）。
      const port = await listenOnCallbackPort(callbackServer, {
        initialPort: blockedPort,
        pickPort: () => freePort,
      })
      expect(port).toBeGreaterThanOrEqual(MIN_CALLBACK_PORT)
      expect(port).toBe(freePort)
      expect(port).not.toBe(blockedPort)
    } finally {
      await new Promise<void>((resolve) => callbackServer.close(() => resolve()))
      await closeReservedPort(blockedPort)
    }
  })

  it('端口连挑不中时以错误结算（不会无限重试）', async () => {
    // 上限保护：每次都挑同一个被占用的端口 → 有限次后必须 reject，
    // 而不是死循环把宿主的登录入口挂住。
    const blocker = createServer()
    const blockedPort = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const callbackServer = createServer()
    try {
      await expect(listenOnCallbackPort(callbackServer, {
        initialPort: blockedPort,
        pickPort: () => blockedPort,
      })).rejects.toThrow(/EADDRINUSE/)
    } finally {
      await new Promise<void>((resolve) => callbackServer.close(() => resolve()))
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  // ── provider 级互斥：重复点击不得堆积监听端口 ──
  it('已有未结算会话时再次 prepare 返回 login-in-progress（不复用、不新建）', async () => {
    const fetcher = stsFetcher()
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const second = await prepareCodeartsLogin({ fetcher, timeoutMs: 5000 })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('不应成功')
    expect(second.error).toBe('login-in-progress')
    // 没有句柄被交出去 —— 也就不存在第二个监听端口。
    expect('session' in second).toBe(false)

    // 第一次会话未被打扰：回调照常完成并换回凭据。
    const settled = started(first.awaitCredential())
    const response = await callback(first.loginUrl, 'code=CODE')
    expect(response.status).toBe(307)
    const { value } = await settled
    expect(value!.expires).toBe(Date.parse('2026-08-15T00:00:00Z'))
  })

  it('会话结算后互斥释放，可以再次 prepare', async () => {
    const fetcher = stsFetcher()
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(first.awaitCredential())
    await callback(first.loginUrl, 'code=CODE')
    await settled
    await vi.waitFor(() => { expect(hasActiveCodeartsLogin()).toBe(false) })

    const second = await prepareCodeartsLogin({ fetcher, timeoutMs: 5000 })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('互斥未释放')
    track(second.session)
    expect(second.session.port).toBeGreaterThanOrEqual(10_000)
    expect(second.session.loginUrl).not.toBe(first.loginUrl)
  })

  it('cancel 之后互斥同样释放（新会话可建立）', async () => {
    const fetcher = stsFetcher()
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    first.cancel('用户放弃')
    await vi.waitFor(() => { expect(hasActiveCodeartsLogin()).toBe(false) })
    const second = await prepare({ fetcher, timeoutMs: 5000 })
    expect(second.loginUrl).not.toBe(first.loginUrl)
  })

  it('**并发** prepare 只有一个成功（同步占位，杜绝端口堆积）', async () => {
    // 这是回归用例：互斥检查若放在 `await generateDpopKeyPair()` /
    // `await startOAuthCallbackServer()` 之后，并发的三次调用会全部通过判空、
    // 各自起一个监听（lobsterai 侧实测曾三个全部成功）。
    // 故必须在不 await 的情况下连发，才能真正覆盖该窗口。
    const options: CodeartsLoginPrepareOptions = { fetcher: stsFetcher(), timeoutMs: 5000 }
    const outcomes = await Promise.all([
      prepareCodeartsLogin(options),
      prepareCodeartsLogin(options),
      prepareCodeartsLogin(options),
    ])
    const ok = outcomes.filter((o) => o.ok)
    const rejected = outcomes.filter((o) => !o.ok)
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    for (const outcome of rejected) {
      if (outcome.ok) throw new Error('不应成功')
      expect(outcome.error).toBe('login-in-progress')
    }
    if (ok[0]!.ok) track(ok[0]!.session)
  })
})

describe('runOAuthFlow（阻塞式便捷封装）', () => {
  const stsResponse = JSON.stringify({
    credentials: {
      access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST',
      expiration: '2026-08-15T00:00:00Z',
    },
    refresh_token: 'RT',
  })

  it('打开浏览器 → 回调带 code → 返回凭据（两段式的同步包装不变）', async () => {
    const fetcher = vi.fn(async () => new Response(stsResponse, { status: 200 })) as unknown as typeof fetch
    const opened: string[] = []
    const flow = started(runOAuthFlow({ fetcher, openBrowser: (url) => { opened.push(url) } }))
    const loginUrl = await waitFor(() => opened[0])
    const port = new URL(loginUrl).searchParams.get('port')
    const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=CODE`, { redirect: 'manual' })
    expect(response.status).toBe(307)

    const { value } = await flow
    expect(value!.loginUrl).toBe(loginUrl)
    const credential = JSON.parse(value!.access) as Record<string, string>
    expect(credential.refresh_token).toBe('RT')
    // 阻塞式封装跑完即释放会话，不占着互斥。
    await vi.waitFor(() => { expect(hasActiveCodeartsLogin()).toBe(false) })
  })

  it('已有未结算会话时抛出可读错误（不静默复用）', async () => {
    const fetcher = vi.fn(async () => new Response(stsResponse, { status: 200 })) as unknown as typeof fetch
    const prepared = await prepareCodeartsLogin({ fetcher, timeoutMs: 5000 })
    expect(prepared.ok).toBe(true)
    if (prepared.ok) track(prepared.session)
    await expect(runOAuthFlow({ fetcher, openBrowser: () => {}, maxAttempts: 1 }))
      .rejects.toThrow(/已有 CodeArts 登录进行中/)
  })

  it('opener 抛错时会话被取消（不留占用端口的僵尸监听）', async () => {
    const fetcher = vi.fn(async () => new Response(stsResponse, { status: 200 })) as unknown as typeof fetch
    await expect(runOAuthFlow({
      fetcher,
      openBrowser: () => { throw new Error('no browser') },
    })).rejects.toThrow('no browser')
    await vi.waitFor(() => { expect(hasActiveCodeartsLogin()).toBe(false) })
  })
})
