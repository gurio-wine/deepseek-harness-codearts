import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildLobsteraiLoginUrl,
  createLobsteraiLoginSession,
  exchangeLobsteraiAuthCode,
  hasActiveLobsteraiLogin,
  prepareLobsteraiLogin,
  runLobsteraiLoginFlow,
  type LobsteraiLoginPrepareOptions,
  type LobsteraiPendingLogin,
} from '../../src/lobsterai-oauth.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { LOBSTERAI_CALLBACK_PATH } from '../../src/lobsterai.js'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

const CLIENT_VERSION = '2026.9.4'

/** 一次典型的 exchange 成功响应。 */
function successBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    code: 0,
    msg: 'OK',
    data: {
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresIn: 3600,
      user: { id: 'uid-1', yid: 'yid-1', userId: 'acc-1', nickname: '测试账号' },
      ...overrides,
    },
  })
}

function stubFetch(responder: (url: string, init?: RequestInit) => Response): typeof fetch {
  return vi.fn(async (url: unknown, init?: RequestInit) => responder(String(url), init)) as unknown as typeof fetch
}

/**
 * 启动登录流程并**立即**把结算结果转成一个已处理的 Promise。
 *
 * 为什么需要它：这些用例要先 `await callCallback(...)` 触发回调，
 * 之后才断言结果。而回调一返回，promise 就已经 settle 了 ——
 * 在「已 settle」到「被 await」之间那段窗口里，Node 会把它视为
 * **未处理的拒绝**并让 vitest 报 unhandled error（测试仍全绿，但退出码非 0）。
 *
 * 先挂上 then/catch 把状态取出来，窗口就消失了；断言仍在后面进行，
 * 语义不变（成功解析为 undefined，失败解析为错误对象）。
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
 * `prepareLobsteraiLogin` 的互斥状态是**模块级**的，一条用例留下未结算会话
 * 会污染同文件后续所有用例（它们会拿到 `login-in-progress`），
 * 故每个用例结束都要 cancel 掉自己创建的会话。
 */
const createdSessions: LobsteraiPendingLogin[] = []

/** 为用例登记一个会话（返回同一对象，便于链式使用）。 */
function track(session: LobsteraiPendingLogin): LobsteraiPendingLogin {
  createdSessions.push(session)
  return session
}

/** 用真实 HTTP 请求模拟浏览器回调；返回响应状态码。 */
async function callCallback(loginUrl: string, query: string): Promise<number> {
  // loginUrl 形如
  // https://portal/portal#/login?redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2Fauth%2Fcallback&...
  // 从 redirect_uri 参数里取回真实的本地回调地址最可靠。
  const params = new URLSearchParams(loginUrl.slice(loginUrl.indexOf('?') + 1))
  const callback = new URL(params.get('redirect_uri')!)
  const response = await fetch(`http://127.0.0.1:${callback.port}${callback.pathname}?${query}`)
  return response.status
}

/** 从登录 URL 取回一次性 state（回调时需原样带回）。 */
function stateOf(loginUrl: string): string {
  return new URLSearchParams(loginUrl.slice(loginUrl.indexOf('?') + 1)).get('state')!
}

/** 从登录 URL 的 redirect_uri 里取回本地回调端口。 */
function callbackPort(loginUrl: string): number {
  const params = new URLSearchParams(loginUrl.slice(loginUrl.indexOf('?') + 1))
  return Number(new URL(params.get('redirect_uri')!).port)
}

afterEach(async () => {
  for (const session of createdSessions) session.cancel('用例清理')
  createdSessions.length = 0
  await vi.waitFor(() => { expect(hasActiveLobsteraiLogin()).toBe(false) })
})

describe('createLobsteraiLoginSession', () => {
  it('生成 uuid 与 firstKeyfrom', () => {
    const session = createLobsteraiLoginSession(1700000000000)
    expect(session.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(session.firstKeyfrom).toBe('1700000000000')
  })

  it('两次生成的 uuid 不同（一次性会话）', () => {
    expect(createLobsteraiLoginSession().uuid).not.toBe(createLobsteraiLoginSession().uuid)
  })
})

describe('buildLobsteraiLoginUrl', () => {
  const url = buildLobsteraiLoginUrl(51234, 'state-abc', LOBSTERAI)

  it('指向 portal 的 #/login hash 路由', () => {
    expect(url.startsWith('https://lobsterai.youdao.com/portal#/login?')).toBe(true)
  })

  it('带 source=electron（声明桌面客户端来源）', () => {
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('source')).toBe('electron')
  })

  it('redirect_uri 指向本地回调且格式符合登录页校验要求', () => {
    // main.go:223-225 的注释明确记录：登录页校验 redirect_uri 必须是
    // http://127.0.0.1:{port}/auth/callback 形态。
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('redirect_uri')).toBe(`http://127.0.0.1:51234${LOBSTERAI_CALLBACK_PATH}`)
  })

  it('redirect_uri 被正确百分号编码（手工拼串极易漏掉）', () => {
    // :// 与 : 必须编码，否则登录页会拒绝该 redirect_uri。
    expect(url).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2Fauth%2Fcallback')
  })

  it('state 原样带上（回调时用于比对）', () => {
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('state')).toBe('state-abc')
  })
})

describe('exchangeLobsteraiAuthCode', () => {
  const session = { uuid: 'uuid-1', firstKeyfrom: '1700000000000' }

  it('POST 到 {apiBase}/api/auth/exchange', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = stubFetch((u, init) => {
      seenUrl = u
      seenMethod = init?.method ?? ''
      return new Response(successBody(), { status: 200 })
    })
    await exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher)
    expect(seenUrl).toBe('https://lobsterai-server.youdao.com/api/auth/exchange')
    expect(seenMethod).toBe('POST')
  })

  it('请求体含全部 5 个必需字段', async () => {
    // 缺 firstKeyfrom / uuid 会不会失败未实测，但 Go 原实现是必带的，照抄。
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(successBody(), { status: 200 })
    })
    await exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher)
    expect(body.authCode).toBe('code-1')
    expect(body.firstKeyfrom).toBe('1700000000000')
    expect(body.uuid).toBe('uuid-1')
    expect(body.version).toBe(CLIENT_VERSION)
    expect(typeof body.latestKeyfrom).toBe('string')
  })

  it('latestKeyfrom 为当前时刻（毫秒字符串）', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(successBody(), { status: 200 })
    })
    const before = Date.now()
    await exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher)
    const value = Number(body.latestKeyfrom)
    expect(value).toBeGreaterThanOrEqual(before)
    expect(value).toBeLessThanOrEqual(Date.now())
  })

  it('请求**不带** Authorization 头（换 token 时还没有 token）', async () => {
    let headers: Record<string, string> = {}
    const fetcher = stubFetch((_u, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return new Response(successBody(), { status: 200 })
    })
    await exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher)
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers['User-Agent']).toBe('LobsterAI/0.1.0')
  })

  it('成功时返回完整凭据（含持久化的三个身份字段）', async () => {
    const fetcher = stubFetch(() => new Response(successBody(), { status: 200 }))
    const credential = await exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher)
    expect(credential).toMatchObject({
      access_token: 'AT-1', refresh_token: 'RT-1', uid: 'uid-1',
      user_id: 'acc-1', nickname: '测试账号',
      uuid: 'uuid-1', first_keyfrom: '1700000000000',
    })
    expect(Number(credential.expires_at)).toBeGreaterThan(Date.now())
  })

  it('业务码非 0 时抛错并带上服务端 msg', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 40100, msg: 'token rejected',
    }), { status: 200 }))
    await expect(exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher))
      .rejects.toThrow(/token rejected/)
  })

  it('响应缺 accessToken 时抛错（不落半成品凭据）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { refreshToken: 'RT-only' },
    }), { status: 200 }))
    await expect(exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher))
      .rejects.toThrow(/缺少 accessToken/)
  })

  it('data 为 null 时抛错（凭据失效的典型形态）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ code: 0, data: null }), { status: 200 }))
    await expect(exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher))
      .rejects.toThrow(/data 为空/)
  })

  it('网络失败时抛错并保留底层原因', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    await expect(exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher))
      .rejects.toThrow(/socket hang up/)
  })

  it('响应不是 JSON 时抛错（并带上 HTTP 状态）', async () => {
    const fetcher = stubFetch(() => new Response('<html>502</html>', { status: 502 }))
    await expect(exchangeLobsteraiAuthCode('code-1', session, CLIENT_VERSION, LOBSTERAI, fetcher))
      .rejects.toThrow(/不是 JSON（HTTP 502）/)
  })
})

describe('prepareLobsteraiLogin / awaitCredential（两段式）', () => {
  /** prepare 一个会话并断言成功（互斥冲突会让用例直接失败，附带原因）。 */
  async function prepare(
    options: Partial<LobsteraiLoginPrepareOptions> = {},
  ): Promise<LobsteraiPendingLogin> {
    const outcome = await prepareLobsteraiLogin({
      product: LOBSTERAI,
      clientVersion: CLIENT_VERSION,
      ...options,
    })
    if (!outcome.ok) throw new Error(`prepare 失败：${outcome.error} / ${outcome.message}`)
    return track(outcome.session)
  }

  it('prepare 返回 loginUrl 与端口，且**不打开浏览器**', async () => {
    const session = await prepare({ fetcher: stubFetch(() => new Response(successBody(), { status: 200 })) })
    expect(session.loginUrl).toContain('/portal#/login?')
    expect(session.port).toBe(callbackPort(session.loginUrl))
    expect(session.port).toBeGreaterThan(0)
    expect(session.loginUrl).toContain('source=electron')
    // 打开动作已移出流程：prepare 阶段唯一的副作用是起回调服务器，
    // 此刻端口已在监听（能收到请求并给出 400，而不是连接失败）。
    const response = await fetch(
      `http://127.0.0.1:${session.port}${LOBSTERAI_CALLBACK_PATH}?code=&state=${stateOf(session.loginUrl)}`,
    )
    expect(response.status).toBe(400)
  })

  it('回调带 code → awaitCredential 返回凭据', async () => {
    const fetcher = stubFetch(() => new Response(successBody(), { status: 200 }))
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, `code=code-1&state=${stateOf(session.loginUrl)}`)
    expect(status).toBe(200)

    const { value: result } = await settled
    expect(result).toBeDefined()
    expect(result!.loginUrl).toBe(session.loginUrl)
    expect(result!.refreshable).toBe(true)
    expect(result!.expires).toBeGreaterThan(Date.now())
    const credential = JSON.parse(result!.access) as LobsteraiCredential
    expect(credential.access_token).toBe('AT-1')
    expect(credential.uuid).toMatch(/^[0-9a-f-]{36}$/)
    // first_keyfrom 是**会话创建**时刻，latest_keyfrom 是**exchange** 时刻 ——
    // 两者之间隔着「用户在浏览器操作」，故不应相等，只需前者不晚于后者。
    expect(Number(credential.first_keyfrom)).toBeLessThanOrEqual(Number(credential.latest_keyfrom))
    expect(Number(credential.first_keyfrom)).toBeGreaterThan(0)
  })

  it('state 不匹配时回调返回 400（拒绝伪造回调）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 1500,
    })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, 'code=code-1&state=wrong-state')
    expect(status).toBe(400)
    // 该会话不会完成，让超时把它收掉（断言超时错误而非成功）。
    const { error } = await settled
    expect(String(error)).toMatch(/登录超时/)
  })

  it('缺 code 时回调返回 400', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 1500,
    })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, `state=${stateOf(session.loginUrl)}`)
    expect(status).toBe(400)
    const { error } = await settled
    expect(String(error)).toMatch(/登录超时/)
  })

  it('非回调路径返回 404', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 1500,
    })
    const settled = started(session.awaitCredential())
    const response = await fetch(`http://127.0.0.1:${session.port}/other`)
    expect(response.status).toBe(404)
    const { error } = await settled
    expect(String(error)).toMatch(/登录超时/)
  })

  it('exchange 失败时回调返回 500 且 awaitCredential 抛出原因', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      code: 40100, msg: 'token rejected',
    }), { status: 200 }))
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, `code=code-1&state=${stateOf(session.loginUrl)}`)
    expect(status).toBe(500)
    const { error } = await settled
    expect(String(error)).toMatch(/token rejected/)
  })

  it('超时后抛出可读的超时错误', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 50,
    })
    await expect(session.awaitCredential()).rejects.toThrow(/登录超时/)
  })

  it('超时后释放回调端口（不泄漏监听）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 50,
    })
    await expect(session.awaitCredential()).rejects.toThrow()
    // 服务器已关闭：再请求应连接失败。
    await expect(fetch(`http://127.0.0.1:${session.port}${LOBSTERAI_CALLBACK_PATH}?code=x&state=y`))
      .rejects.toThrow()
  })

  it('cancel 释放端口，并让 awaitCredential 以错误结算', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 5000,
    })
    const settled = started(session.awaitCredential())
    session.cancel('测试取消')
    const { error } = await settled
    expect(String(error)).toMatch(/测试取消/)
    await vi.waitFor(() => { expect(hasActiveLobsteraiLogin()).toBe(false) })
    await expect(fetch(`http://127.0.0.1:${session.port}${LOBSTERAI_CALLBACK_PATH}?code=x&state=y`))
      .rejects.toThrow()
  })

  // ── provider 级互斥：重复点击不得堆积监听端口 ──
  it('已有未结算会话时再次 prepare 返回 login-in-progress（不复用、不新建）', async () => {
    const fetcher = stubFetch(() => new Response(successBody(), { status: 200 }))
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const second = await prepareLobsteraiLogin({
      product: LOBSTERAI, clientVersion: CLIENT_VERSION, fetcher, timeoutMs: 5000,
    })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('不应成功')
    expect(second.error).toBe('login-in-progress')
    // 没有句柄被交出去 —— 也就不存在第二个监听端口。
    expect('session' in second).toBe(false)

    // 第一次会话未被打扰：回调照常完成并换回凭据。
    const settled = started(first.awaitCredential())
    const status = await callCallback(first.loginUrl, `code=code-1&state=${stateOf(first.loginUrl)}`)
    expect(status).toBe(200)
    const { value } = await settled
    expect(value!.refreshable).toBe(true)
  })

  it('会话结算后互斥释放，可以再次 prepare', async () => {
    const fetcher = stubFetch(() => new Response(successBody(), { status: 200 }))
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(first.awaitCredential())
    await callCallback(first.loginUrl, `code=code-1&state=${stateOf(first.loginUrl)}`)
    await settled
    await vi.waitFor(() => { expect(hasActiveLobsteraiLogin()).toBe(false) })

    const second = await prepareLobsteraiLogin({
      product: LOBSTERAI, clientVersion: CLIENT_VERSION, fetcher, timeoutMs: 5000,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('互斥未释放')
    track(second.session)
    expect(second.session.port).toBeGreaterThan(0)
  })

  it('cancel 之后互斥同样释放（新会话可建立）', async () => {
    const fetcher = stubFetch(() => new Response(successBody(), { status: 200 }))
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    first.cancel('用户放弃')
    await vi.waitFor(() => { expect(hasActiveLobsteraiLogin()).toBe(false) })
    const second = await prepare({ fetcher, timeoutMs: 5000 })
    expect(second.loginUrl).not.toBe(first.loginUrl)
  })

  it('**并发** prepare 只有一个成功（同步占位，杜绝端口堆积）', async () => {
    // 这是回归用例：互斥检查若放在 `await listenOnRandomPort()` 之后，
    // 并发的三次调用会双双通过判空、各自起一个监听 —— 实测曾三个全部成功。
    // 故必须在不 await 的情况下连发，才能真正覆盖该窗口。
    const opts: LobsteraiLoginPrepareOptions = {
      product: LOBSTERAI,
      clientVersion: CLIENT_VERSION,
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 5000,
    }
    const outcomes = await Promise.all([
      prepareLobsteraiLogin(opts),
      prepareLobsteraiLogin(opts),
      prepareLobsteraiLogin(opts),
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

describe('runLobsteraiLoginFlow（阻塞式便捷封装）', () => {
  it('打开浏览器 → 回调带 code → 返回凭据（两段式的同步包装不变）', async () => {
    const fetcher = stubFetch(() => new Response(successBody(), { status: 200 }))
    let openedUrl = ''
    const flow = started(runLobsteraiLoginFlow({
      product: LOBSTERAI,
      clientVersion: CLIENT_VERSION,
      fetcher,
      openBrowser: (url) => { openedUrl = url },
      timeoutMs: 5000,
    }))
    // 等 openBrowser 被调用（登录 URL 已就绪）后再模拟浏览器回调。
    await vi.waitFor(() => { expect(openedUrl).not.toBe('') })
    const status = await callCallback(openedUrl, `code=code-1&state=${stateOf(openedUrl)}`)
    expect(status).toBe(200)

    const { value: result } = await flow
    expect(result).toBeDefined()
    expect(result!.loginUrl).toBe(openedUrl)
    expect(result!.refreshable).toBe(true)
    const credential = JSON.parse(result!.access) as LobsteraiCredential
    expect(credential.access_token).toBe('AT-1')
  })

  it('超时后抛出可读的超时错误', async () => {
    await expect(runLobsteraiLoginFlow({
      product: LOBSTERAI,
      clientVersion: CLIENT_VERSION,
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      openBrowser: () => {},
      timeoutMs: 50,
    })).rejects.toThrow(/登录超时/)
  })

  it('已有未结算会话时抛出可读错误（不静默复用）', async () => {
    const session = await prepareLobsteraiLogin({
      product: LOBSTERAI,
      clientVersion: CLIENT_VERSION,
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      timeoutMs: 5000,
    })
    expect(session.ok).toBe(true)
    if (session.ok) track(session.session)
    await expect(runLobsteraiLoginFlow({
      product: LOBSTERAI,
      clientVersion: CLIENT_VERSION,
      fetcher: stubFetch(() => new Response(successBody(), { status: 200 })),
      openBrowser: () => {},
      timeoutMs: 5000,
    })).rejects.toThrow(/已有 LobsterAI 登录进行中/)
  })
})
