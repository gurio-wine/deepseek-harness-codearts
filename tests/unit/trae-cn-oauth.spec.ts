import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRAE_CN_ACCESS_TOKEN_PARAMS,
  TRAE_CN_DEVICE_ID_PARAMS,
  TRAE_CN_REFRESH_TOKEN_PARAMS,
  TRAE_CN_USER_ID_PARAMS,
  applyTraeCnRefresh,
  buildTraeCnCredential,
  buildTraeCnLoginUrl,
  completeTraeCnCallback,
  exchangeTraeCnToken,
  generateTraeCnHex32,
  hasActiveTraeCnLogin,
  isTraeCnExpired,
  isTraeCnRefreshable,
  looksLikeTraeCnJwt,
  machineIdToDecimalDeviceId,
  parseTraeCnCredential,
  parseTraeCnTokenPayload,
  prepareTraeCnLogin,
  readTraeCnJwtUserId,
  redactTraeCnCallbackUrl,
  runTraeCnLoginFlow,
  serializeTraeCnCredential,
  traeCnAccessHeaders,
  traeCnCredentialExpiresAtMs,
  type TraeCnCredential,
  type TraeCnLoginPrepareOptions,
  type TraeCnPendingLogin,
} from '../../src/trae-cn-oauth.js'
import {
  TRAE_CN,
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_EXCHANGE_TOKEN_PATH,
  type TraeCnProduct,
} from '../../src/trae-cn-product.js'

/** 造一个带 `exp`（秒）的假 JWT；只需 base64url 可解，不需要真签名。 */
function makeJwt(payload: Record<string, unknown>, expSeconds?: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({
    ...expSeconds === undefined ? {} : { exp: expSeconds },
    ...payload,
  })).toString('base64url')
  return `${header}.${body}.signature`
}

/** 一个 2 小时后过期、带 user_id 的 access token。 */
function futureJwt(extra: Record<string, unknown> = {}): string {
  return makeJwt({ user_id: 'u-1', ...extra }, Math.floor(Date.now() / 1000) + 7200)
}

/** ExchangeToken 成功响应（字段名按候选表的主形态）。 */
function exchangeSuccess(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    Code: 0,
    Result: {
      Token: futureJwt(),
      RefreshToken: 'RT-NEW',
      UserID: 'u-1',
      ...overrides,
    },
  }), { status: 200 })
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
 * 先挂上 then/catch 把状态取出来，窗口就消失了；断言仍在后面进行。
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
 * `prepareTraeCnLogin` 的互斥状态是**模块级**的，一条用例留下未结算会话
 * 会污染同文件后续所有用例（它们会拿到 `login-in-progress`），
 * 故每个用例结束都要 cancel 掉自己创建的会话。
 */
const createdSessions: TraeCnPendingLogin[] = []

/** 为用例登记一个会话（返回同一对象，便于链式使用）。 */
function track(session: TraeCnPendingLogin): TraeCnPendingLogin {
  createdSessions.push(session)
  return session
}

/** 从登录 URL 取回本地回调端口。 */
function callbackPort(loginUrl: string): number {
  const params = new URLSearchParams(loginUrl.slice(loginUrl.indexOf('?') + 1))
  return Number(new URL(params.get('auth_callback_url')!).port)
}

/** 用真实 HTTP 请求模拟浏览器回调；返回响应状态码。 */
async function callCallback(loginUrl: string, query: string): Promise<number> {
  const response = await fetch(
    `http://127.0.0.1:${callbackPort(loginUrl)}${TRAE_CN_CALLBACK_PATH}?${query}`,
  )
  return response.status
}

afterEach(async () => {
  for (const session of createdSessions) session.cancel('用例清理')
  createdSessions.length = 0
  await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })
})

describe('trae-cn 产品配置常量', () => {
  it('clientId / 端点 / 回调路径为编译期常量', () => {
    expect(TRAE_CN.clientId).toBe('ono9krqynydwx5')
    expect(TRAE_CN.apiBase).toBe('https://api.trae.cn')
    expect(TRAE_CN.portalBase).toBe('https://www.trae.cn')
    expect(TRAE_CN_CALLBACK_PATH).toBe('/authorize')
    expect(TRAE_CN_EXCHANGE_TOKEN_PATH).toBe('/cloudide/api/v3/trae/oauth/ExchangeToken')
  })

  it('product.id 为 trae-cn（带连字符，对齐用户叫法）', () => {
    expect(TRAE_CN.id).toBe('trae-cn')
  })

  it('服务名显式指定为 traeCnAuth（不从带连字符的 id 机械派生）', () => {
    // 机械派生会得到 'trae-cnAuth'；显式声明是「provider 名」与
    // 「JS 服务标识符」解耦的关键，这条断言锁住解耦本身。
    expect(TRAE_CN.serviceName).toBe('traeCnAuth')
    expect(TRAE_CN.serviceName).not.toBe(`${TRAE_CN.id}Auth`)
  })

  it('凭据 ref 前缀与默认 ref 就位', () => {
    expect(TRAE_CN.defaultCredentialRef).toBe('TRAE_CN_ACCESS_TOKEN')
    expect(TRAE_CN.accountCredentialRefPrefix).toBe('TRAE_CN_ACCOUNT')
  })
})

describe('generateTraeCnHex32 / machineIdToDecimalDeviceId', () => {
  it('生成 32 位小写十六进制', () => {
    const value = generateTraeCnHex32()
    expect(value).toMatch(/^[0-9a-f]{32}$/)
  })

  it('两次生成不同（一次性随机）', () => {
    expect(generateTraeCnHex32()).not.toBe(generateTraeCnHex32())
  })

  it('machineId 折算成 16 位十进制设备号', () => {
    const deviceId = machineIdToDecimalDeviceId('f'.repeat(32))
    expect(deviceId).toMatch(/^\d{16}$/)
    // 取十进制表示的低 16 位（128 位全 1 = 340282366920938463463374607431768211455）。
    expect(deviceId).toBe('4607431768211455')
  })

  it('非法 machineId 退化为全零而不是抛错', () => {
    // 设备号形态问题不该让整个登录流程失败。
    expect(machineIdToDecimalDeviceId('')).toBe('0'.repeat(16))
    expect(machineIdToDecimalDeviceId('zzz')).toBe('0'.repeat(16))
  })
})

describe('buildTraeCnLoginUrl', () => {
  const url = buildTraeCnLoginUrl(51234, TRAE_CN, 'a'.repeat(32), 'b'.repeat(32))

  it('指向门户的 /authorization 端点', () => {
    expect(url.startsWith('https://www.trae.cn/authorization?')).toBe(true)
  })

  it('带 clientID（注意登录 URL 用 camelCase 小写 d）', () => {
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('clientID')).toBe('ono9krqynydwx5')
  })

  it('auth_callback_url 指向本地 loopback 且被正确百分号编码', () => {
    // :// 与 : 必须编码，否则登录页会拒绝该回调地址。
    expect(url).toContain('auth_callback_url=http%3A%2F%2F127.0.0.1%3A51234%2Fauthorize')
  })

  it('machine_id 与 device_id 是本次登录的随机 hex32', () => {
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect(params.get('machine_id')).toBe('a'.repeat(32))
    expect(params.get('device_id')).toBe('b'.repeat(32))
  })

  it('随机形态复核：两次构造的 machine_id 不同', () => {
    const other = buildTraeCnLoginUrl(1, TRAE_CN, generateTraeCnHex32(), generateTraeCnHex32())
    const params = new URLSearchParams(other.slice(other.indexOf('?') + 1))
    expect(params.get('machine_id')).not.toBe('a'.repeat(32))
  })
})

describe('redactTraeCnCallbackUrl（T5 校准用，保留参数名、脱敏值）', () => {
  it('保留全部参数名（校准所需的信息就是名字）', () => {
    const redacted = redactTraeCnCallbackUrl(
      'http://127.0.0.1:1234/authorize?refreshToken=SECRETVALUE123456&machine_id=abc&state=xyz',
    )
    expect(redacted).toContain('refreshToken=')
    expect(redacted).toContain('machine_id=abc')
    expect(redacted).toContain('state=xyz')
  })

  it('token 类参数的值被压成前缀 + 长度（原值不出现在结果里）', () => {
    const secret = 'SUPERSECRETREFRESHTOKENVALUE'
    const redacted = redactTraeCnCallbackUrl(`http://127.0.0.1:1/authorize?refreshToken=${secret}`)
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain('refreshToken=SUPERS…')
    expect(redacted).toContain(`(len=${secret.length})`)
  })

  it('**默认脱敏**：未知参数名同样被脱敏（fail-closed，白名单之外一律压掉）', () => {
    // 这是刻意的设计选择：回调里出现什么参数名恰恰是未知的（T5 要校准的东西），
    // 黑名单只能挡住想得到的名字，一个叫 weird_param 的未知参数完全可能就是凭据。
    const redacted = redactTraeCnCallbackUrl(
      'http://127.0.0.1:1/authorize?weird_param=SUPERSECRETVALUE&another=ALSOSECRET',
    )
    expect(redacted).not.toContain('SUPERSECRETVALUE')
    expect(redacted).not.toContain('ALSOSECRET')
    // 参数名仍保留 —— 校准靠它。
    expect(redacted).toContain('weird_param=SUPERS…(len=16)')
    expect(redacted).toContain('another=ALSOSE…(len=10)')
  })

  it('白名单内的非机密值原样保留（machine_id / device_id 正是要看的）', () => {
    const redacted = redactTraeCnCallbackUrl(
      'http://127.0.0.1:1/authorize?machine_id=deadbeef&device_id=0000123456789012&state=st-1',
    )
    expect(redacted).toContain('machine_id=deadbeef')
    expect(redacted).toContain('device_id=0000123456789012')
    expect(redacted).toContain('state=st-1')
  })

  it('白名单内的超长值截断并标出长度', () => {
    const long = 'x'.repeat(200)
    const redacted = redactTraeCnCallbackUrl(`http://127.0.0.1:1/authorize?machine_id=${long}`)
    expect(redacted).toContain('(len=200)')
    expect(redacted).not.toContain(long)
  })

  it('无 query 时明确标注（而不是返回空串）', () => {
    expect(redactTraeCnCallbackUrl('http://127.0.0.1:1/authorize')).toContain('(无 query 参数)')
  })

  it('URL 无法解析时不回显原串（原串可能带 token）', () => {
    // 'http://' 前缀下 '[' 是非法主机字符，构造 URL 会抛错。
    const redacted = redactTraeCnCallbackUrl('http://[?refreshToken=LEAK')
    expect(redacted).not.toContain('LEAK')
    expect(redacted).toContain('无法解析')
  })
})

describe('凭据五件套：序列化往返与判定', () => {
  const credential: TraeCnCredential = {
    access_token: futureJwt(),
    refresh_token: 'RT-1',
    user_id: 'u-1',
    client_id: 'ono9krqynydwx5',
    device_id: '0000123456789012',
    machine_id: 'a'.repeat(32),
    device_id_source: 'aha',
    expires_at: String(Date.now() + 7200_000),
    nickname: '测试账号',
  }

  it('五件套全部字段经 JSON 往返后不变', () => {
    const parsed = parseTraeCnCredential(serializeTraeCnCredential(credential))
    expect(parsed).toEqual(credential)
    // 逐项点出五件套，防止将来有人「顺手」删掉其中一个字段而测试仍绿。
    expect(parsed).toMatchObject({
      refresh_token: 'RT-1',
      user_id: 'u-1',
      client_id: 'ono9krqynydwx5',
      device_id: '0000123456789012',
      machine_id: 'a'.repeat(32),
    })
  })

  it('access_token 是账号池反查身份所需的字段（缺它判为损坏）', () => {
    expect(parseTraeCnCredential(JSON.stringify({ refresh_token: 'RT' }))).toBeUndefined()
  })

  it('其余字段缺失不判为损坏（老凭据 / 降级凭据仍可用）', () => {
    const parsed = parseTraeCnCredential(JSON.stringify({ access_token: 'AT' }))
    expect(parsed?.access_token).toBe('AT')
  })

  it('损坏 JSON 返回 undefined 而不抛错', () => {
    expect(parseTraeCnCredential('{ 损坏')).toBeUndefined()
  })

  it('refreshable 以 refresh_token 长度判定', () => {
    expect(isTraeCnRefreshable(credential)).toBe(true)
    expect(isTraeCnRefreshable({ ...credential, refresh_token: '' })).toBe(false)
  })

  it('过期时间优先取 expires_at', () => {
    const at = Date.now() + 7200_000
    expect(traeCnCredentialExpiresAtMs({ ...credential, expires_at: String(at) })).toBe(at)
  })

  it('expires_at 缺失时回退解析 access token 的 JWT exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = makeJwt({}, exp)
    expect(traeCnCredentialExpiresAtMs({ ...credential, access_token: token, expires_at: '' }))
      .toBe(exp * 1000)
  })

  it('秒级时间戳按秒解析（兼容两种量纲）', () => {
    const seconds = Math.floor(Date.now() / 1000) + 3600
    expect(traeCnCredentialExpiresAtMs({ ...credential, expires_at: String(seconds) }))
      .toBe(seconds * 1000)
  })

  it('无法解析过期时间时不判定过期（与另外两条协议线一致）', () => {
    expect(isTraeCnExpired({ ...credential, access_token: 'not-a-jwt', expires_at: '' })).toBe(false)
  })

  it('已过期凭据判定为过期', () => {
    expect(isTraeCnExpired({ ...credential, expires_at: String(Date.now() - 1000) })).toBe(true)
  })
})

describe('readTraeCnJwtUserId', () => {
  it('按 user_id / userId / uid / sub 依次尝试', () => {
    expect(readTraeCnJwtUserId(makeJwt({ user_id: 'a' }))).toBe('a')
    expect(readTraeCnJwtUserId(makeJwt({ userId: 'b' }))).toBe('b')
    expect(readTraeCnJwtUserId(makeJwt({ uid: 'c' }))).toBe('c')
    expect(readTraeCnJwtUserId(makeJwt({ sub: 'd' }))).toBe('d')
  })

  it('非 JWT 返回空串', () => {
    expect(readTraeCnJwtUserId('opaque-token')).toBe('')
    expect(readTraeCnJwtUserId('')).toBe('')
  })
})

describe('traeCnAccessHeaders', () => {
  const credential = buildTraeCnCredential({
    accessToken: 'AT-1',
    refreshToken: 'RT-1',
    userId: 'u-1',
    clientId: 'ono9krqynydwx5',
    deviceId: '0000123456789012',
    deviceIdSource: 'aha',
    machineId: 'a'.repeat(32),
  })

  it('用 Cloud-IDE-JWT 方案（不是 Bearer）', () => {
    const headers = traeCnAccessHeaders(credential)
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT-1')
    expect(headers.Authorization).not.toContain('Bearer')
  })

  it('三个 token 头同值（网关接受等价鉴权，三个都带）', () => {
    const headers = traeCnAccessHeaders(credential)
    expect(headers['X-Ide-Token']).toBe('AT-1')
    expect(headers['X-Cloudide-Token']).toBe('AT-1')
  })

  it('不带腾讯系归属头与 LobsterAI 头', () => {
    const headers = traeCnAccessHeaders(credential)
    for (const absent of ['X-Domain', 'X-Product-Code', 'X-LobsterAI-Client-Version']) {
      expect(headers, absent).not.toHaveProperty(absent)
    }
  })

  it('Accept 可切换（供后续流式对话复用）', () => {
    expect(traeCnAccessHeaders(credential, 'text/event-stream').Accept).toBe('text/event-stream')
  })
})

describe('parseTraeCnTokenPayload', () => {
  it('从 Result 信封里取令牌（大小写两种风格都收）', () => {
    const payload = parseTraeCnTokenPayload({ Code: 0, Result: { Token: 'AT', RefreshToken: 'RT' } })
    expect(payload).toMatchObject({ accessToken: 'AT', refreshToken: 'RT' })
  })

  it('裸载荷（无信封）也能解析', () => {
    const payload = parseTraeCnTokenPayload({ AccessToken: 'AT2', refresh_token: 'RT2' })
    expect(payload).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2' })
  })

  it('业务码非 0 时返回 undefined', () => {
    expect(parseTraeCnTokenPayload({ Code: 401, Message: 'token rejected' })).toBeUndefined()
  })

  it('无 code 字段不视为失败（部分组件返回裸载荷）', () => {
    expect(parseTraeCnTokenPayload({ Token: 'AT' })?.accessToken).toBe('AT')
  })

  it('从 User 子对象里取 userId / deviceId / nickname', () => {
    const payload = parseTraeCnTokenPayload({
      Token: 'AT',
      User: { userId: 'u-9', deviceId: '0000999988887777', nickname: '昵称' },
    })
    expect(payload).toMatchObject({ userId: 'u-9', deviceId: '0000999988887777', nickname: '昵称' })
  })

  it('完全没有 access token 时返回 undefined', () => {
    expect(parseTraeCnTokenPayload({ Code: 0, Result: { RefreshToken: 'RT' } })).toBeUndefined()
  })

  it('非对象输入返回 undefined', () => {
    expect(parseTraeCnTokenPayload(null)).toBeUndefined()
    expect(parseTraeCnTokenPayload('str')).toBeUndefined()
  })
})

describe('exchangeTraeCnToken（续期）', () => {
  it('POST 到 {apiBase}/cloudide/api/v3/trae/oauth/ExchangeToken', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = stubFetch((url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      return exchangeSuccess()
    })
    await exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher)
    expect(seenUrl).toBe('https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(seenMethod).toBe('POST')
  })

  it('请求体含四个必需字段且大小写与协议一致', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return exchangeSuccess()
    })
    await exchangeTraeCnToken({ refreshToken: 'RT-1', userId: 'u-9' }, TRAE_CN, fetcher)
    expect(body).toEqual({
      ClientID: 'ono9krqynydwx5',
      ClientSecret: '-',
      RefreshToken: 'RT-1',
      UserID: 'u-9',
    })
  })

  it('请求**不带** Authorization（续期时还没有新 token）', async () => {
    let headers: Record<string, string> = {}
    const fetcher = stubFetch((_u, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return exchangeSuccess()
    })
    await exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher)
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers).not.toHaveProperty('X-Ide-Token')
  })

  it('成功时返回新 access token（JWT）', async () => {
    const payload = await exchangeTraeCnToken(
      { refreshToken: 'RT', userId: 'u-1' }, TRAE_CN,
      stubFetch(() => exchangeSuccess()),
    )
    expect(payload.accessToken.split('.')).toHaveLength(3)
    expect(payload.refreshToken).toBe('RT-NEW')
  })

  it('缺 refresh_token 时立刻抛错（不发请求）', async () => {
    const fetcher = stubFetch(() => exchangeSuccess())
    await expect(exchangeTraeCnToken({ refreshToken: '', userId: 'u-1' }, TRAE_CN, fetcher))
      .rejects.toThrow(/缺少 refresh_token/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('网络失败抛普通错误并保留底层原因（不判终态）', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    await expect(exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher))
      .rejects.toThrow(/socket hang up/)
  })

  it('HTTP 401 抛错并带上状态码（供上层判终态）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ Code: 401, Message: 'unauthorized' }), { status: 401 }))
    await expect(exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher))
      .rejects.toThrow(/HTTP 401/)
  })

  it('HTTP 500 抛错（可重试，不判终态）', async () => {
    const fetcher = stubFetch(() => new Response('boom', { status: 500 }))
    await expect(exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher))
      .rejects.toThrow(/HTTP 500/)
  })

  it('响应不是 JSON 时抛错并带上状态码', async () => {
    const fetcher = stubFetch(() => new Response('<html>502</html>', { status: 502 }))
    await expect(exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher))
      .rejects.toThrow(/不是 JSON（HTTP 502）/)
  })

  it('业务码非 0 时抛错并带上服务端 message', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      Code: 40001, Message: 'refresh token expired',
    }), { status: 200 }))
    await expect(exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher))
      .rejects.toThrow(/refresh token expired/)
  })

  it('找不到 access token 时把**实际顶层键名**带进错误（T5 校准的抓手）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      Code: 0, Result: { WeirdFieldName: 'x' },
    }), { status: 200 }))
    await expect(exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher))
      .rejects.toThrow(/顶层键：Code,Result/)
  })
})

describe('applyTraeCnRefresh', () => {
  const base = buildTraeCnCredential({
    accessToken: futureJwt(),
    refreshToken: 'RT-OLD',
    userId: 'u-1',
    clientId: 'ono9krqynydwx5',
    deviceId: '0000123456789012',
    deviceIdSource: 'aha',
    machineId: 'a'.repeat(32),
    nickname: '旧昵称',
  })

  it('更新令牌与过期时间', () => {
    const exp = Math.floor(Date.now() / 1000) + 1800
    const next = applyTraeCnRefresh(base, {
      accessToken: makeJwt({ user_id: 'u-1' }, exp), refreshToken: 'RT-NEW', userId: '', deviceId: '', nickname: '',
    })
    expect(next.refresh_token).toBe('RT-NEW')
    expect(next.access_token).not.toBe(base.access_token)
    expect(next.expires_at).toBe(String(exp * 1000))
  })

  it('响应未返回新 refreshToken 时沿用旧值（覆盖成空串会让下次续期直接失败）', () => {
    const next = applyTraeCnRefresh(base, {
      accessToken: 'AT-2', refreshToken: '', userId: '', deviceId: '', nickname: '',
    })
    expect(next.refresh_token).toBe('RT-OLD')
  })

  it('五件套里的身份字段一律沿用旧值', () => {
    const next = applyTraeCnRefresh(base, {
      accessToken: 'AT-2', refreshToken: 'RT-NEW', userId: 'OTHER', deviceId: 'OTHER', nickname: '新昵称',
    })
    expect(next.user_id).toBe('u-1')
    expect(next.device_id).toBe('0000123456789012')
    expect(next.client_id).toBe('ono9krqynydwx5')
    expect(next.machine_id).toBe('a'.repeat(32))
    // 昵称同理保留旧的（续期响应不带账号对象）。
    expect(next.nickname).toBe('旧昵称')
  })

  it('user_id 为空时被响应回填（降级凭据在首次续期后自愈）', () => {
    const degraded = { ...base, user_id: '', device_id: '' }
    const next = applyTraeCnRefresh(degraded, {
      accessToken: 'AT-2', refreshToken: '', userId: 'u-filled', deviceId: 'dev-filled', nickname: '',
    })
    expect(next.user_id).toBe('u-filled')
    expect(next.device_id).toBe('dev-filled')
  })

  it('过期时间由新 token 的 JWT exp 派生', () => {
    const exp = Math.floor(Date.now() / 1000) + 999
    const next = applyTraeCnRefresh(base, {
      accessToken: makeJwt({}, exp), refreshToken: '', userId: '', deviceId: '', nickname: '',
    })
    expect(next.expires_at).toBe(String(exp * 1000))
  })
})

describe('completeTraeCnCallback（回调 → 凭据）', () => {
  const session = { machineId: 'a'.repeat(32) }

  function callbackUrl(query: string): URL {
    return new URL(`http://127.0.0.1:1234${TRAE_CN_CALLBACK_PATH}?${query}`)
  }

  it('主路径：回调 query 带 refreshToken → 调 ExchangeToken 换 access', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return exchangeSuccess()
    })
    const credential = await completeTraeCnCallback(
      callbackUrl('refreshToken=RT-CB&userId=u-cb'), session, TRAE_CN, fetcher,
    )
    expect(body.RefreshToken).toBe('RT-CB')
    expect(body.UserID).toBe('u-cb')
    expect(credential.refresh_token).toBe('RT-NEW')
    expect(credential.access_token.split('.')).toHaveLength(3)
  })

  it('userId 缺失时从 refreshToken 的 JWT 声明里取', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return exchangeSuccess()
    })
    await completeTraeCnCallback(
      callbackUrl(`refreshToken=${makeJwt({ user_id: 'from-jwt' })}`), session, TRAE_CN, fetcher,
    )
    expect(body.UserID).toBe('from-jwt')
  })

  it('设备号：回调带 deviceId 时标记来源为 aha', async () => {
    const credential = await completeTraeCnCallback(
      callbackUrl('refreshToken=RT&deviceId=0000123456789012'),
      session, TRAE_CN, stubFetch(() => exchangeSuccess()),
    )
    expect(credential.device_id).toBe('0000123456789012')
    expect(credential.device_id_source).toBe('aha')
  })

  it('设备号：回调未带时回退 machine_id 十进制，**并标记来源**（不静默伪造）', async () => {
    const credential = await completeTraeCnCallback(
      callbackUrl('refreshToken=RT'), session, TRAE_CN, stubFetch(() => exchangeSuccess()),
    )
    expect(credential.device_id).toMatch(/^\d{16}$/)
    expect(credential.device_id_source).toBe('machine-id-fallback')
  })

  it('exchange 响应带设备号时优先用它（比 machine_id 兜底更接近真实来源）', async () => {
    const credential = await completeTraeCnCallback(
      callbackUrl('refreshToken=RT'), session, TRAE_CN,
      stubFetch(() => exchangeSuccess({ DeviceID: '0000111122223333' })),
    )
    expect(credential.device_id).toBe('0000111122223333')
    expect(credential.device_id_source).toBe('aha')
  })

  it('凭据里的 machine_id 是本次登录的 machineId', async () => {
    const credential = await completeTraeCnCallback(
      callbackUrl('refreshToken=RT'), session, TRAE_CN, stubFetch(() => exchangeSuccess()),
    )
    expect(credential.machine_id).toBe('a'.repeat(32))
  })

  it('回调完全不带 refreshToken 时抛错，且错误里带上脱敏后的实际参数', async () => {
    const error = await completeTraeCnCallback(
      callbackUrl('weird_param=SECRETLEAK&state=xyz'), session, TRAE_CN, stubFetch(() => exchangeSuccess()),
    ).catch((e: unknown) => e as Error)
    expect(error.message).toMatch(/未携带 refreshToken/)
    // 参数名保留（校准用），敏感值不出现在错误里。
    expect(error.message).toContain('weird_param=')
    expect(error.message).not.toContain('SECRETLEAK')
    expect(error.message).toContain('state=xyz')
  })

  it('候选参数表：同义写法也能被识别（每张表都验一遍）', async () => {
    const tables: Array<readonly string[]> = [
      TRAE_CN_REFRESH_TOKEN_PARAMS,
      TRAE_CN_USER_ID_PARAMS,
      TRAE_CN_DEVICE_ID_PARAMS,
      TRAE_CN_ACCESS_TOKEN_PARAMS,
    ]
    // 每张表都必须非空且首项是主路径（顺序本身就是「哪个最可能是真的」的记录）。
    for (const table of tables) {
      expect(table.length).toBeGreaterThan(0)
      expect(table[0]!.length).toBeGreaterThan(0)
    }
    expect(TRAE_CN_REFRESH_TOKEN_PARAMS[0]).toBe('refreshToken')
    // 备选写法 refresh_token 同样可用。
    const credential = await completeTraeCnCallback(
      callbackUrl('refresh_token=RT-SNAKE'), session, TRAE_CN, stubFetch(() => exchangeSuccess()),
    )
    expect(credential.refresh_token).toBe('RT-NEW')
  })

  it('回调直接给 access token 时跳过 ExchangeToken（次要路径）', async () => {
    const fetcher = stubFetch(() => exchangeSuccess())
    const credential = await completeTraeCnCallback(
      callbackUrl(`refreshToken=RT&accessToken=${futureJwt({ user_id: 'u-direct' })}`),
      session, TRAE_CN, fetcher,
    )
    expect(fetcher).not.toHaveBeenCalled()
    expect(readTraeCnJwtUserId(credential.access_token)).toBe('u-direct')
    expect(credential.user_id).toBe('u-direct')
  })

  it('**JWT 形态校验**：名叫 token 但非 JWT 的参数不被当作 access token', async () => {
    // 回归点：参数名 `token` 完全可能是 CSRF 串等无关值。若不做形态校验，
    // 它会被静默当成 access token 存下 —— 登录「成功」但之后每次请求都 401。
    // 正确行为是忽略它，照常走主路径（refreshToken → ExchangeToken）。
    let called = false
    const fetcher = stubFetch(() => {
      called = true
      return exchangeSuccess()
    })
    const credential = await completeTraeCnCallback(
      callbackUrl('refreshToken=RT&token=not-a-jwt-at-all'), session, TRAE_CN, fetcher,
    )
    expect(called).toBe(true)
    expect(credential.access_token).not.toBe('not-a-jwt-at-all')
    expect(credential.access_token.split('.')).toHaveLength(3)
  })

  it('looksLikeTraeCnJwt 只认三段点分且 payload 可解的串', () => {
    expect(looksLikeTraeCnJwt(futureJwt())).toBe(true)
    expect(looksLikeTraeCnJwt('not-a-jwt')).toBe(false)
    expect(looksLikeTraeCnJwt('a.b')).toBe(false)
    // 三段但 payload 不是合法 base64url JSON。
    expect(looksLikeTraeCnJwt('a.!!!!.c')).toBe(false)
  })
})

describe('prepareTraeCnLogin / awaitCredential（两段式）', () => {
  /** prepare 一个会话并断言成功（互斥冲突会让用例直接失败，附带原因）。 */
  async function prepare(
    options: Partial<TraeCnLoginPrepareOptions> = {},
  ): Promise<TraeCnPendingLogin> {
    const outcome = await prepareTraeCnLogin({ product: TRAE_CN, ...options })
    if (!outcome.ok) throw new Error(`prepare 失败：${outcome.error} / ${outcome.message}`)
    return track(outcome.session)
  }

  it('prepare 返回 loginUrl 与端口，且**不打开浏览器**', async () => {
    const session = await prepare({ fetcher: stubFetch(() => exchangeSuccess()) })
    expect(session.loginUrl).toContain('https://www.trae.cn/authorization?')
    expect(session.port).toBe(callbackPort(session.loginUrl))
    expect(session.port).toBeGreaterThan(0)
    // 端口已在监听：空 refreshToken 的回调得到 500（参数缺失），而不是连接失败。
    const status = await callCallback(session.loginUrl, 'state=x')
    expect(status).toBe(500)
  })

  it('回调带 refreshToken → awaitCredential 返回五件套凭据', async () => {
    const fetcher = stubFetch(() => exchangeSuccess())
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, 'refreshToken=RT-CB&userId=u-cb&deviceId=0000123456789012')
    expect(status).toBe(200)

    const { value: result } = await settled
    expect(result).toBeDefined()
    expect(result!.loginUrl).toBe(session.loginUrl)
    expect(result!.refreshable).toBe(true)
    expect(result!.expires).toBeGreaterThan(Date.now())
    const credential = JSON.parse(result!.access) as TraeCnCredential
    expect(credential).toMatchObject({
      refresh_token: 'RT-NEW',
      user_id: 'u-cb',
      client_id: 'ono9krqynydwx5',
      device_id: '0000123456789012',
      device_id_source: 'aha',
    })
    // machine_id 是本次登录随机生成的 hex32，与登录 URL 里的一致。
    const params = new URLSearchParams(session.loginUrl.slice(session.loginUrl.indexOf('?') + 1))
    expect(credential.machine_id).toBe(params.get('machine_id'))
    expect(credential.machine_id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('回调诊断钩子收到**每条**回调的脱敏 URL（含参数名，T5 校准用）', async () => {
    const seen: string[] = []
    const session = await prepare({
      fetcher: stubFetch(() => exchangeSuccess()),
      timeoutMs: 5000,
      onCallbackDebug: (message) => seen.push(message),
    })
    const settled = started(session.awaitCredential())
    await callCallback(session.loginUrl, 'refreshToken=SUPERSECRETVALUE&deviceId=0000123456789012')
    await settled
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('refreshToken=')
    expect(seen[0]).toContain('deviceId=0000123456789012')
    // 敏感值脱敏：原始 refreshToken 不得出现在日志里。
    expect(seen[0]).not.toContain('SUPERSECRETVALUE')
  })

  it('非回调路径返回 404', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => exchangeSuccess()),
      timeoutMs: 1500,
    })
    const settled = started(session.awaitCredential())
    const response = await fetch(`http://127.0.0.1:${session.port}/other`)
    expect(response.status).toBe(404)
    // 该会话不会完成，让超时把它收掉（断言超时错误而非成功）。
    const { error } = await settled
    expect(String(error)).toMatch(/登录超时/)
  })

  it('exchange 失败时回调返回 500 且 awaitCredential 抛出原因', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      Code: 40001, Message: 'refresh token expired',
    }), { status: 200 }))
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, 'refreshToken=RT')
    expect(status).toBe(500)
    const { error } = await settled
    expect(String(error)).toMatch(/refresh token expired/)
  })

  it('超时后抛出可读的超时错误', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => exchangeSuccess()),
      timeoutMs: 50,
    })
    await expect(session.awaitCredential()).rejects.toThrow(/登录超时/)
  })

  it('超时后释放回调端口（不泄漏监听）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => exchangeSuccess()),
      timeoutMs: 50,
    })
    await expect(session.awaitCredential()).rejects.toThrow()
    await expect(fetch(`http://127.0.0.1:${session.port}${TRAE_CN_CALLBACK_PATH}?refreshToken=x`))
      .rejects.toThrow()
  })

  it('cancel 释放端口，并让 awaitCredential 以错误结算', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => exchangeSuccess()),
      timeoutMs: 5000,
    })
    const settled = started(session.awaitCredential())
    session.cancel('测试取消')
    const { error } = await settled
    expect(String(error)).toMatch(/测试取消/)
    await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })
    await expect(fetch(`http://127.0.0.1:${session.port}${TRAE_CN_CALLBACK_PATH}?refreshToken=x`))
      .rejects.toThrow()
  })

  // ── provider 级互斥：重复点击不得堆积监听端口 ──
  it('互斥（串行）：已有未结算会话时再次 prepare 返回 login-in-progress', async () => {
    const fetcher = stubFetch(() => exchangeSuccess())
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const second = await prepareTraeCnLogin({ product: TRAE_CN, fetcher, timeoutMs: 5000 })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('不应成功')
    expect(second.error).toBe('login-in-progress')
    // 没有句柄被交出去 —— 也就不存在第二个监听端口。
    expect('session' in second).toBe(false)

    // 第一次会话未被打扰：回调照常完成并换回凭据。
    const settled = started(first.awaitCredential())
    const status = await callCallback(first.loginUrl, 'refreshToken=RT-CB')
    expect(status).toBe(200)
    const { value } = await settled
    expect(value!.refreshable).toBe(true)
  })

  it('互斥（并发）：三个并发 prepare 只有一个成功（同步占位，杜绝端口堆积）', async () => {
    // 这是回归用例：互斥检查若放在 `await listenOnRandomPort()` 之后，
    // 并发的三次调用会各自通过判空、各自起一个监听。
    // 故必须在不 await 的情况下连发，才能真正覆盖该窗口。
    const opts: TraeCnLoginPrepareOptions = {
      product: TRAE_CN,
      fetcher: stubFetch(() => exchangeSuccess()),
      timeoutMs: 5000,
    }
    const outcomes = await Promise.all([
      prepareTraeCnLogin(opts),
      prepareTraeCnLogin(opts),
      prepareTraeCnLogin(opts),
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

  it('互斥（释放）：会话结算后可再次 prepare', async () => {
    const fetcher = stubFetch(() => exchangeSuccess())
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(first.awaitCredential())
    await callCallback(first.loginUrl, 'refreshToken=RT-CB')
    await settled
    await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })

    const second = await prepareTraeCnLogin({ product: TRAE_CN, fetcher, timeoutMs: 5000 })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('互斥未释放')
    track(second.session)
    expect(second.session.port).toBeGreaterThan(0)
  })

  it('互斥（取消释放）：cancel 之后新会话可建立', async () => {
    const fetcher = stubFetch(() => exchangeSuccess())
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    first.cancel('用户放弃')
    await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })
    const second = await prepare({ fetcher, timeoutMs: 5000 })
    expect(second.loginUrl).not.toBe(first.loginUrl)
  })
})

describe('runTraeCnLoginFlow（阻塞式便捷封装）', () => {
  it('打开浏览器 → 回调带 refreshToken → 返回凭据', async () => {
    const fetcher = stubFetch(() => exchangeSuccess())
    let openedUrl = ''
    const flow = started(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher,
      openBrowser: (url) => { openedUrl = url },
      timeoutMs: 5000,
    }))
    // 等 openBrowser 被调用（登录 URL 已就绪）后再模拟浏览器回调。
    await vi.waitFor(() => { expect(openedUrl).not.toBe('') })
    const status = await callCallback(openedUrl, 'refreshToken=RT-CB')
    expect(status).toBe(200)

    const { value: result } = await flow
    expect(result).toBeDefined()
    expect(result!.loginUrl).toBe(openedUrl)
    expect(result!.refreshable).toBe(true)
    const credential = JSON.parse(result!.access) as TraeCnCredential
    expect(credential.refresh_token).toBe('RT-NEW')
  })

  it('超时后抛出可读的超时错误', async () => {
    await expect(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher: stubFetch(() => exchangeSuccess()),
      openBrowser: () => {},
      timeoutMs: 50,
    })).rejects.toThrow(/登录超时/)
  })

  it('已有未结算会话时抛出可读错误（不静默复用）', async () => {
    const session = await prepareTraeCnLogin({
      product: TRAE_CN,
      fetcher: stubFetch(() => exchangeSuccess()),
      timeoutMs: 5000,
    })
    expect(session.ok).toBe(true)
    if (session.ok) track(session.session)
    await expect(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher: stubFetch(() => exchangeSuccess()),
      openBrowser: () => {},
      timeoutMs: 5000,
    })).rejects.toThrow(/已有 Trae CN 登录进行中/)
  })

  it('打开浏览器失败时会话被释放（不占端口到超时）', async () => {
    await expect(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher: stubFetch(() => exchangeSuccess()),
      openBrowser: () => { throw new Error('no browser') },
      timeoutMs: 5000,
    })).rejects.toThrow(/no browser/)
    await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })
  })
})

describe('buildTraeCnCredential', () => {
  it('过期时间由 access token 的 JWT exp 派生', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const credential = buildTraeCnCredential({
      accessToken: makeJwt({}, exp),
      refreshToken: 'RT',
      userId: 'u-1',
      clientId: 'cid',
      deviceId: 'dev',
      deviceIdSource: 'aha',
      machineId: 'mid',
    })
    expect(credential.expires_at).toBe(String(exp * 1000))
  })

  it('非 JWT 的 access token → expires_at 留空（读取时仍会再试一次）', () => {
    const credential = buildTraeCnCredential({
      accessToken: 'opaque',
      refreshToken: 'RT',
      userId: 'u-1',
      clientId: 'cid',
      deviceId: 'dev',
      deviceIdSource: 'aha',
      machineId: 'mid',
    })
    expect(credential.expires_at).toBe('')
  })
})

describe('产品配置隔离', () => {
  it('换成另一份产品配置时端点随之切换（不从凭据推断）', async () => {
    const custom: TraeCnProduct = { ...TRAE_CN, apiBase: 'https://example.test' }
    let seenUrl = ''
    const fetcher = stubFetch((url) => {
      seenUrl = url
      return exchangeSuccess()
    })
    await exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, custom, fetcher)
    expect(seenUrl).toBe(`https://example.test${TRAE_CN_EXCHANGE_TOKEN_PATH}`)
  })
})
