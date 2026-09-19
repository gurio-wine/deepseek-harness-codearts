import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRAE_CN_AUTH_CODE_INFO_PARAM,
  TRAE_CN_LOGIN_TRACE_ID_PARAM,
  TRAE_CN_REFRESH_TOKEN_PARAM,
  TRAE_CN_USER_INFO_PARAM,
  applyTraeCnRefresh,
  buildTraeCnCredential,
  buildTraeCnDeviceInfo,
  buildTraeCnLoginUrl,
  completeTraeCnCallback,
  exchangeTraeCnAuthCode,
  exchangeTraeCnToken,
  generateTraeCnDeviceId,
  generateTraeCnDevicePublicKey,
  generateTraeCnLoginTraceId,
  generateTraeCnMachineId,
  generateTraeCnPkce,
  hasActiveTraeCnLogin,
  isTraeCnExpired,
  isTraeCnRefreshable,
  parseTraeCnAuthExchangeResult,
  parseTraeCnCallbackUrl,
  parseTraeCnCredential,
  parseTraeCnTokenPayload,
  prepareTraeCnLogin,
  readTraeCnJwtUserId,
  redactTraeCnCallbackUrl,
  runTraeCnLoginFlow,
  serializeTraeCnCredential,
  TRAE_CN_CALLBACK_CORS_HEADERS,
  traeCnAccessHeaders,
  traeCnCredentialExpiresAtMs,
  type TraeCnCredential,
  type TraeCnLoginPrepareOptions,
  type TraeCnPendingLogin,
} from '../../src/trae-cn-oauth.js'
import {
  TRAE_CN,
  TRAE_CN_AUTH_EXCHANGE_PATH,
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_CHANNEL_NAME,
  TRAE_CN_CLIENT_ID,
  TRAE_CN_EXCHANGE_TOKEN_PATH,
  TRAE_CN_IDE_VERSION,
  TRAE_CN_LOGIN_OS_VERSION,
  TRAE_CN_LOGIN_REDIRECT,
  TRAE_CN_LOGIN_REDIRECT_CALLBACK,
  TRAE_CN_PLUGIN_VERSION,
  type TraeCnProduct,
} from '../../src/trae-cn-product.js'

/**
 * 真机样本（2026-09-17 成功登录，`%APPDATA%\Trae CN\logs\20260917T045023\main.log`）。
 *
 * 这些值是**逐字摘录**的行为契约：测试拿它们当输入，等价于「服务端真的这么发」。
 * 值本身可公开（`authCode` 为一次性、`BoundDeviceID` 是设备绑定标识），
 * 但 `Token` / `RefreshToken` 用假 JWT 替代 —— 真机日志里它们本来就是 `******`。
 */
const REAL_LOGIN_TRACE_ID = '5bc786d0-8b00-4a72-a9c9-69fe7e674306'
const REAL_MACHINE_ID = 'aec0d2b72cf910bb031046144d66e846e1aa83806439d092250451af310d6ded'
const REAL_DEVICE_ID = '2996599860772203'
const REAL_AUTH_CODE = 'p7OxOuI2tUAKATTQPKu6NK73KLDowSb3F2HHwNPtpKY'
const REAL_CODE_VERIFIER = 'yj7K7f6rowHcXl1jAVuZtRVJzttLFgEFWS1V0P0DnlWIwUOI2sQ0b9u2lfNPAlkC'
const REAL_CODE_CHALLENGE = 'QArTy-3mmiiQtRwvXyUCI8w6_C8N1rJpqjjtm10MXn4'
const REAL_BOUND_DEVICE_ID = 'wl2k1e2endpp32'
/** 真机 `Result.TokenExpireAt`（13 位 epoch ms）。 */
const REAL_TOKEN_EXPIRE_AT = 1790801493459

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

/** 续期端点成功响应（`cloudide/api/…`，字段名按候选表的主形态）。 */
function refreshSuccess(overrides: Record<string, unknown> = {}): Response {
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

/**
 * 登录交换端点成功响应 —— **真机 Result 信封逐字结构**（main.log:141）。
 *
 * `Token` 用假 JWT 替代真值（真机日志里是 `******`），其余键名与形态照抄。
 */
function authExchangeSuccess(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    ResponseMetadata: { Action: '', Region: '', RequestId: '', Service: '', Version: '' },
    Result: {
      BoundDeviceID: REAL_BOUND_DEVICE_ID,
      ClientID: TRAE_CN_CLIENT_ID,
      DeviceBindStatus: 'BOUND',
      RefreshExpireAt: 1805143893459,
      RefreshToken: 'RT-FROM-AUTHCODE',
      Token: futureJwt(),
      TokenExpireAt: REAL_TOKEN_EXPIRE_AT,
      TokenExpireDuration: 1209600000,
      UserJwt: 'uj-1',
      ...overrides,
    },
  }), { status: 200 })
}

/** 真机回调 query（main.log:139 的键名与编码形态，值为真机样本）。 */
function realCallbackQuery(overrides: Record<string, string> = {}): string {
  const authCodeInfo = JSON.stringify({
    AuthCode: REAL_AUTH_CODE,
    ExpireAt: 1789592492958,
    ExpireDuration: 600000,
  })
  const userInfo = JSON.stringify({
    AIRegion: 'CN',
    AvatarUrl: 'https://example.test/avatar.png',
    LastLoginType: 'sms',
    NonPlainTextMobile: '189******95',
    Region: 'CN',
    ScreenName: '河童',
    TenantID: '7o2d894p7dr0o4',
    UserID: '1435281906741923',
  })
  const params = new URLSearchParams({
    isRedirect: 'true',
    scope: 'trae',
    authCodeInfo,
    loginTraceID: REAL_LOGIN_TRACE_ID,
    host: 'https://api.trae.com.cn',
    userRegion: 'cn',
    userInfo,
    ...overrides,
  })
  return params.toString()
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

/** 从登录 URL 取回某个 query 参数。 */
function loginParam(loginUrl: string, name: string): string | null {
  return new URLSearchParams(loginUrl.slice(loginUrl.indexOf('?') + 1)).get(name)
}

/** 用真实 HTTP 请求模拟浏览器回调；返回响应。 */
async function callCallbackRaw(loginUrl: string, query: string): Promise<Response> {
  // redirect: 'manual' —— 成功回调现在是 **307 回跳授权页**（对齐官方
  // `updateLocalCredential`），不手动拦下就会真的跳到 www.trae.cn 上。
  return fetch(
    `http://127.0.0.1:${callbackPort(loginUrl)}${TRAE_CN_CALLBACK_PATH}?${query}`,
    { redirect: 'manual' },
  )
}

/** 用真实 HTTP 请求模拟浏览器回调；返回响应状态码。 */
async function callCallback(loginUrl: string, query: string): Promise<number> {
  return (await callCallbackRaw(loginUrl, query)).status
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
    // 续期端点与登录交换端点是**两条路径**，首段不同（cloudide vs trae）。
    expect(TRAE_CN_EXCHANGE_TOKEN_PATH).toBe('/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(TRAE_CN_AUTH_EXCHANGE_PATH).toBe('/trae/api/v3/oauth/ExchangeToken')
    expect(TRAE_CN_AUTH_EXCHANGE_PATH).not.toBe(TRAE_CN_EXCHANGE_TOKEN_PATH)
  })

  it('真机流程常量逐项锁死（main.log:136）', () => {
    expect(TRAE_CN_PLUGIN_VERSION).toBe('2.3.83560')
    // ⚠️ 登录线的 IDE 版本仍是 `3.3.100` —— 那是 authCode 交换与登录 URL 那条
    // 协议线里**逐字校准过的真机字面量**。签到头的 `x-app-version` 已升到
    // `3.3.102`（那是**另一条协议线**，见 `tests/unit/trae-cn-credits.spec.ts`）。
    // 两个号刻意分开，不要因为「客户端升级了」就把这里也一起改。
    expect(TRAE_CN_IDE_VERSION).toBe('3.3.100')
    expect(TRAE_CN_CHANNEL_NAME).toBe('common')
    // 登录 URL 的 x_os_version 同样是**登录线**的真机字面量（市场营销名），
    // 且**刻意保留为常量**：它由官方 `getSystemInformation().osVersion` 取系统
    // 信息得到，在真机上与 `os.version()` 同源；本插件在登录线上照发该校准值，
    // 不在本次改动边界内。签到头的 x-os-version 已改为运行时 `os.version()`
    // （见 `tests/unit/trae-cn-credits.spec.ts` 的说明）—— 两者**形态一致**
    // （都是市场营销名而非构建号），这是本次修复消掉的矛盾。
    expect(TRAE_CN_LOGIN_OS_VERSION).toBe('Windows 10 Home')
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

describe('设备标识生成（形态即风控）', () => {
  it('machineId 是 64 位小写十六进制', () => {
    expect(generateTraeCnMachineId()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('deviceId 是 16 位纯十进制', () => {
    // 真机形态：2996599860772203。**不能用 hex32/UUID**。
    //
    // ⚠️ 本断言测的是**登录 URL 的 `device_id`**（`generateTraeCnDeviceId`）——
    // 那个字段进授权页与 authCode 交换，形态由**登录握手**要求。它与签到头
    // `x-device-id`（凭据里的 `BoundDeviceID`）是**两个位置**：后者服务端
    // **不校验形态**（T9 实测，见 `tests/unit/trae-cn-credits.spec.ts`）。
    //
    // 另：早先这条注释把「形态不符」的后果记成「会触发 9074 风控」，**归因错误**
    // —— 9074 的成因与设备号形态无关（2026-09-20 重新定性为**活动级当日名额
    // 限制或账号侧风控**，见 `src/trae-cn-errors.ts` 的 `TRAE_CN_BACKOFF_CODES`）。
    // 断言本身没变（登录 URL 的 16 位形态要求仍然成立），只修了注释语义。
    expect(generateTraeCnDeviceId()).toMatch(/^\d{16}$/)
  })

  it('deviceId 的每一位都接近均匀（不是「首位恒 0」的退化形态）', () => {
    // 取 200 个样本，首位不应全是 0/1 —— 那说明取值区间没覆盖满 16 位。
    const heads = new Set(Array.from({ length: 200 }, () => generateTraeCnDeviceId()[0]))
    expect(heads.size).toBeGreaterThan(3)
  })

  it('loginTraceId 是 UUID 形态（真机样本同形）', () => {
    expect(generateTraeCnLoginTraceId())
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('两次生成互不相同（一次性随机）', () => {
    expect(generateTraeCnDeviceId()).not.toBe(generateTraeCnDeviceId())
    expect(generateTraeCnMachineId()).not.toBe(generateTraeCnMachineId())
    expect(generateTraeCnLoginTraceId()).not.toBe(generateTraeCnLoginTraceId())
  })
})

describe('generateTraeCnPkce（对齐官方 gDe）', () => {
  it('verifier 64 字符 / challenge 43 字符（都是 base64url 无填充）', () => {
    const pkce = generateTraeCnPkce()
    // 官方：randomBytes(48).toString("base64url") → 64；sha256 digest → 43。
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('challenge = sha256(verifier) 的 base64url（可往返验证）', async () => {
    const pkce = generateTraeCnPkce()
    const { createHash } = await import('node:crypto')
    expect(pkce.codeChallenge).toBe(createHash('sha256').update(pkce.codeVerifier).digest('base64url'))
  })

  it('方法恒为 S256（**不是** CodeArts 那套 SHA-256）', () => {
    const pkce = generateTraeCnPkce()
    expect(pkce.codeChallengeMethod).toBe('S256')
    expect(pkce.codeChallengeMethod).not.toBe('SHA-256')
  })
})

describe('buildTraeCnDeviceInfo / buildTraeCnLoginUrl', () => {
  it('DeviceInfo 是真机 12 字段，键名与顺序逐字一致（main.log:140）', () => {
    const info = buildTraeCnDeviceInfo(REAL_DEVICE_ID, REAL_MACHINE_ID, 'gurio的电脑')
    expect(Object.keys(info)).toEqual([
      'DeviceID', 'MachineID', 'PlatformCode', 'DeviceType', 'DeviceName', 'DeviceModel',
      'ClientVersion', 'DevicePublicKey', 'DeviceBrand', 'DeviceCPU', 'OSInfo', 'OSVersion',
    ])
    expect(info).toMatchObject({
      DeviceID: REAL_DEVICE_ID,
      MachineID: REAL_MACHINE_ID,
      PlatformCode: 'IDE_PC',
      DeviceType: 'PC',
      DeviceName: 'gurio的电脑',
      ClientVersion: '3.3.100',
      OSInfo: 'windows',
      OSVersion: 'Windows 10 Home',
    })
  })

  it('DeviceInfo.DeviceName 缺省取主机名（不留空串 —— 官方从不发空值）', () => {
    const info = buildTraeCnDeviceInfo(REAL_DEVICE_ID, REAL_MACHINE_ID)
    expect(info.DeviceName.length).toBeGreaterThan(0)
  })

  it('DeviceInfo.DevicePublicKey 缺省生成 EC P-256 SPKI PEM（官方 vDe() 同款）', () => {
    const pem = buildTraeCnDeviceInfo(REAL_DEVICE_ID, REAL_MACHINE_ID).DevicePublicKey
    // SPKI PEM 形态：头尾标记 + base64 段（P-256 公钥 91 字节 → 124 字符）。
    expect(pem.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true)
    expect(pem.trimEnd().endsWith('-----END PUBLIC KEY-----')).toBe(true)
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
    expect(b64.length).toBe(124)
  })

  it('DeviceInfo.DevicePublicKey 显式传入时原样使用（调用方可控制形态）', () => {
    const pem = generateTraeCnDevicePublicKey()
    expect(buildTraeCnDeviceInfo(REAL_DEVICE_ID, REAL_MACHINE_ID, undefined, pem).DevicePublicKey).toBe(pem)
  })
})

describe('buildTraeCnLoginUrl', () => {
  const pkce = { codeChallenge: REAL_CODE_CHALLENGE, codeChallengeMethod: 'S256' }
  const url = buildTraeCnLoginUrl(
    51234, TRAE_CN, REAL_MACHINE_ID, REAL_DEVICE_ID, REAL_LOGIN_TRACE_ID, pkce,
  )

  it('指向门户的 /authorization 端点', () => {
    expect(url.startsWith('https://www.trae.cn/authorization?')).toBe(true)
  })

  it('**client_id 是 snake_case**（写成 clientID 就是「认证中」卡死的根因）', () => {
    expect(loginParam(url, 'client_id')).toBe('ono9krqynydwx5')
    // 反向断言：授权页只读 client_id，camelCase 变体**不得**出现。
    expect(url).not.toContain('clientID=')
    expect(loginParam(url, 'clientID')).toBeNull()
  })

  it('真机流程标记逐项在位（缺 auth_type 直接停在「认证中」）', () => {
    expect(loginParam(url, 'login_version')).toBe('1')
    expect(loginParam(url, 'auth_from')).toBe('trae')
    expect(loginParam(url, 'login_channel')).toBe('native_ide')
    expect(loginParam(url, 'plugin_version')).toBe('2.3.83560')
    expect(loginParam(url, 'auth_type')).toBe('local')
    expect(loginParam(url, 'redirect')).toBe('0')
    expect(loginParam(url, 'channel_name')).toBe('common')
  })

  it('携带 PKCE 参数（授权页据此选 AuthCode 分支）', () => {
    expect(loginParam(url, 'code_challenge')).toBe(REAL_CODE_CHALLENGE)
    expect(loginParam(url, 'code_challenge_method')).toBe('S256')
  })

  it('login_trace_id 是本次登录的追踪号（回调校验的锚点）', () => {
    expect(loginParam(url, 'login_trace_id')).toBe(REAL_LOGIN_TRACE_ID)
  })

  it('auth_callback_url 指向本地 loopback 且被正确百分号编码', () => {
    // :// 与 : 必须编码，否则登录页会拒绝该回调地址。
    expect(url).toContain('auth_callback_url=http%3A%2F%2F127.0.0.1%3A51234%2Fauthorize')
  })

  it('machine_id 是 64 hex、device_id 是 16 位十进制（形态即风控）', () => {
    expect(loginParam(url, 'machine_id')).toMatch(/^[0-9a-f]{64}$/)
    expect(loginParam(url, 'device_id')).toMatch(/^\d{16}$/)
  })

  it('x_device_* / x_machine_* 与 device_id / machine_id 同值', () => {
    expect(loginParam(url, 'x_device_id')).toBe(loginParam(url, 'device_id'))
    expect(loginParam(url, 'x_machine_id')).toBe(loginParam(url, 'machine_id'))
  })

  it('设备与版本头逐项（真机逐字）', () => {
    expect(loginParam(url, 'x_device_type')).toBe('windows')
    expect(loginParam(url, 'x_os_version')).toBe('Windows 10 Home')
    expect(loginParam(url, 'x_app_version')).toBe('3.3.100')
    expect(loginParam(url, 'x_app_type')).toBe('stable')
    // 真机上这两个是**空值**参数（官方取 deviceModel / BOE 环境标识）。
    expect(loginParam(url, 'x_device_brand')).toBe('')
    expect(loginParam(url, 'x_env')).toBe('')
  })

  it('参数集合与真机一致（22 个，不多不少）', () => {
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    expect([...params.keys()].sort()).toEqual([
      'auth_callback_url', 'auth_from', 'auth_type', 'channel_name', 'client_id',
      'code_challenge', 'code_challenge_method', 'device_id', 'login_channel',
      'login_trace_id', 'login_version', 'machine_id', 'plugin_version', 'redirect',
      'x_app_type', 'x_app_version', 'x_device_brand', 'x_device_id', 'x_device_type',
      'x_env', 'x_machine_id', 'x_os_version',
    ])
  })

  it('每次登录的随机量互不相同（machine_id / device_id / trace）', () => {
    const other = buildTraeCnLoginUrl(
      1, TRAE_CN, generateTraeCnMachineId(), generateTraeCnDeviceId(), generateTraeCnLoginTraceId(),
      generateTraeCnPkce(),
    )
    expect(loginParam(other, 'machine_id')).not.toBe(loginParam(url, 'machine_id'))
    expect(loginParam(other, 'device_id')).not.toBe(loginParam(url, 'device_id'))
  })

  it('redirect 可覆盖：成功回调的 307 回跳用 1，其余参数逐字不变', () => {
    // 官方 `updateLocalCredential` 成功分支：`getLoginUrl(t, port, 1, …)`
    // → `buildLoginUrl` 里 `redirect=${r||0}` → `writeHead(307,{Location})`。
    const back = buildTraeCnLoginUrl(
      51234, TRAE_CN, REAL_MACHINE_ID, REAL_DEVICE_ID, REAL_LOGIN_TRACE_ID, pkce,
      TRAE_CN_LOGIN_REDIRECT_CALLBACK,
    )
    expect(TRAE_CN_LOGIN_REDIRECT_CALLBACK).toBe('1')
    expect(loginParam(back, 'redirect')).toBe('1')
    // 登录 URL 自身仍是 0（授权页据此进入登录流程而非直接渲染结果页）。
    expect(loginParam(url, 'redirect')).toBe(TRAE_CN_LOGIN_REDIRECT)
    // 除 redirect 外，两条 URL 逐参相等。
    const before = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    const after = new URLSearchParams(back.slice(back.indexOf('?') + 1))
    for (const [key, value] of before) {
      if (key === 'redirect') continue
      expect(after.get(key), `参数 ${key} 被改动`).toBe(value)
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
  })
})

describe('redactTraeCnCallbackUrl（保留参数名、脱敏值）', () => {
  it('保留全部参数名（诊断所需的信息就是名字）', () => {
    const redacted = redactTraeCnCallbackUrl(
      `http://127.0.0.1:1234/authorize?${TRAE_CN_AUTH_CODE_INFO_PARAM}=X&machine_id=abc&state=xyz`,
    )
    expect(redacted).toContain(`${TRAE_CN_AUTH_CODE_INFO_PARAM}=`)
    expect(redacted).toContain('machine_id=abc')
    expect(redacted).toContain('state=xyz')
  })

  it('token 类参数的值被压成前缀 + 长度（原值不出现在结果里）', () => {
    const secret = 'SUPERSECRETREFRESHTOKENVALUE'
    const redacted = redactTraeCnCallbackUrl(
      `http://127.0.0.1:1/authorize?${TRAE_CN_REFRESH_TOKEN_PARAM}=${secret}`,
    )
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain(`${TRAE_CN_REFRESH_TOKEN_PARAM}=SUPERS…`)
    expect(redacted).toContain(`(len=${secret.length})`)
  })

  it('userInfo 不在白名单：手机号与头像 URL 都不会进日志', () => {
    const redacted = redactTraeCnCallbackUrl(
      `http://127.0.0.1:1/authorize?${TRAE_CN_USER_INFO_PARAM}=${encodeURIComponent('{"NonPlainTextMobile":"189******95"}')}`,
    )
    expect(redacted).toContain(`${TRAE_CN_USER_INFO_PARAM}=`)
    expect(redacted).not.toContain('189******95')
  })

  it('**默认脱敏**：未知参数名同样被脱敏（fail-closed）', () => {
    const redacted = redactTraeCnCallbackUrl(
      'http://127.0.0.1:1/authorize?weird_param=SUPERSECRETVALUE&another=ALSOSECRET',
    )
    expect(redacted).not.toContain('SUPERSECRETVALUE')
    expect(redacted).not.toContain('ALSOSECRET')
    // 参数名仍保留 —— 诊断靠它。
    expect(redacted).toContain('weird_param=SUPERS…(len=16)')
    expect(redacted).toContain('another=ALSOSE…(len=10)')
  })

  it('白名单内的非机密值原样保留（设备号与 trace 号正是要看的）', () => {
    const redacted = redactTraeCnCallbackUrl(
      `http://127.0.0.1:1/authorize?machine_id=deadbeef&device_id=${REAL_DEVICE_ID}`
      + `&${TRAE_CN_LOGIN_TRACE_ID_PARAM}=${REAL_LOGIN_TRACE_ID}&scope=trae&host=https://api.trae.com.cn`,
    )
    expect(redacted).toContain('machine_id=deadbeef')
    expect(redacted).toContain(`device_id=${REAL_DEVICE_ID}`)
    expect(redacted).toContain(`${TRAE_CN_LOGIN_TRACE_ID_PARAM}=${REAL_LOGIN_TRACE_ID}`)
    expect(redacted).toContain('scope=trae')
    expect(redacted).toContain('host=https://api.trae.com.cn')
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
    user_id: '1435281906741923',
    client_id: 'ono9krqynydwx5',
    device_id: REAL_BOUND_DEVICE_ID,
    machine_id: REAL_MACHINE_ID,
    device_id_source: 'exchange-bound-device-id',
    expires_at: String(Date.now() + 7200_000),
    nickname: '河童',
  }

  it('五件套全部字段经 JSON 往返后不变', () => {
    const parsed = parseTraeCnCredential(serializeTraeCnCredential(credential))
    expect(parsed).toEqual(credential)
    // 逐项点出五件套，防止将来有人「顺手」删掉其中一个字段而测试仍绿。
    expect(parsed).toMatchObject({
      refresh_token: 'RT-1',
      user_id: '1435281906741923',
      client_id: 'ono9krqynydwx5',
      device_id: REAL_BOUND_DEVICE_ID,
      machine_id: REAL_MACHINE_ID,
    })
  })

  it('access_token 是账号池反查身份所需的字段（缺它判为损坏）', () => {
    expect(parseTraeCnCredential(JSON.stringify({ refresh_token: 'RT' }))).toBeUndefined()
  })

  it('其余字段缺失不判为损坏（老凭据 / 兼容分支凭据仍可用）', () => {
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
    deviceId: REAL_BOUND_DEVICE_ID,
    deviceIdSource: 'exchange-bound-device-id',
    machineId: REAL_MACHINE_ID,
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

// ── 续期端点（cloudide/api/…，与登录交换是两条路径） ──

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
      User: { userId: 'u-9', deviceId: REAL_BOUND_DEVICE_ID, nickname: '昵称' },
    })
    expect(payload).toMatchObject({ userId: 'u-9', deviceId: REAL_BOUND_DEVICE_ID, nickname: '昵称' })
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
  it('POST 到 {apiBase}/cloudide/api/v3/trae/oauth/ExchangeToken（不是登录那一条）', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = stubFetch((url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      return refreshSuccess()
    })
    await exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher)
    expect(seenUrl).toBe('https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(seenMethod).toBe('POST')
  })

  it('请求体含四个必需字段且大小写与协议一致', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return refreshSuccess()
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
      return refreshSuccess()
    })
    await exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, TRAE_CN, fetcher)
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers).not.toHaveProperty('X-Ide-Token')
  })

  it('成功时返回新 access token（JWT）', async () => {
    const payload = await exchangeTraeCnToken(
      { refreshToken: 'RT', userId: 'u-1' }, TRAE_CN,
      stubFetch(() => refreshSuccess()),
    )
    expect(payload.accessToken.split('.')).toHaveLength(3)
    expect(payload.refreshToken).toBe('RT-NEW')
  })

  it('缺 refresh_token 时立刻抛错（不发请求）', async () => {
    const fetcher = stubFetch(() => refreshSuccess())
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

  it('找不到 access token 时把**实际顶层键名**带进错误', async () => {
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
    deviceId: REAL_BOUND_DEVICE_ID,
    deviceIdSource: 'exchange-bound-device-id',
    machineId: REAL_MACHINE_ID,
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
    expect(next.device_id).toBe(REAL_BOUND_DEVICE_ID)
    expect(next.client_id).toBe('ono9krqynydwx5')
    expect(next.machine_id).toBe(REAL_MACHINE_ID)
    // 昵称同理保留旧的（续期响应不带账号对象）。
    expect(next.nickname).toBe('旧昵称')
  })

  it('user_id 为空时被响应回填（兼容分支的凭据在首次续期后自愈）', () => {
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

// ── 登录交换端点（trae/api/v3/oauth/…，AuthCode + PKCE） ──

describe('parseTraeCnAuthExchangeResult（真机 Result 信封）', () => {
  it('取出 Token / RefreshToken / BoundDeviceID / TokenExpireAt', async () => {
    const parsed = parseTraeCnAuthExchangeResult(await authExchangeSuccess().json())
    expect(parsed).toMatchObject({
      refreshToken: 'RT-FROM-AUTHCODE',
      boundDeviceId: REAL_BOUND_DEVICE_ID,
      tokenExpireAt: REAL_TOKEN_EXPIRE_AT,
      deviceBindStatus: 'BOUND',
    })
    expect(parsed!.accessToken.split('.')).toHaveLength(3)
  })

  it('TokenExpireAt 接受数字字符串（防御两种序列化形态）', () => {
    const parsed = parseTraeCnAuthExchangeResult({
      Result: { Token: 'AT', TokenExpireAt: String(REAL_TOKEN_EXPIRE_AT) },
    })
    expect(parsed?.tokenExpireAt).toBe(REAL_TOKEN_EXPIRE_AT)
  })

  it('缺 TokenExpireAt 时字段缺省（不编造一个过期时间）', () => {
    const parsed = parseTraeCnAuthExchangeResult({ Result: { Token: 'AT' } })
    expect(parsed?.tokenExpireAt).toBeUndefined()
  })

  it('没有 Result 信封时接受裸载荷', () => {
    expect(parseTraeCnAuthExchangeResult({ Token: 'AT', BoundDeviceID: 'dev' }))
      .toMatchObject({ accessToken: 'AT', boundDeviceId: 'dev' })
  })

  it('找不到 Token → undefined；业务码非 0 → undefined', () => {
    expect(parseTraeCnAuthExchangeResult({ Result: { RefreshToken: 'RT' } })).toBeUndefined()
    expect(parseTraeCnAuthExchangeResult({ Code: 20324, Result: { Token: 'AT' } })).toBeUndefined()
  })
})

describe('exchangeTraeCnAuthCode（登录交换）', () => {
  const args = {
    authCode: REAL_AUTH_CODE,
    codeVerifier: REAL_CODE_VERIFIER,
    deviceId: REAL_DEVICE_ID,
    machineId: REAL_MACHINE_ID,
    deviceName: 'gurio的电脑',
  }

  it('POST 到 {apiBase}/trae/api/v3/oauth/ExchangeToken（与续期端点不同）', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const fetcher = stubFetch((url, init) => {
      seenUrl = url
      seenMethod = init?.method ?? ''
      return authExchangeSuccess()
    })
    await exchangeTraeCnAuthCode(args, TRAE_CN, fetcher)
    expect(seenUrl).toBe('https://api.trae.cn/trae/api/v3/oauth/ExchangeToken')
    expect(seenMethod).toBe('POST')
  })

  it('请求体五字段，且**不含** ClientSecret / DeviceProof（真机逐字）', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return authExchangeSuccess()
    })
    await exchangeTraeCnAuthCode(args, TRAE_CN, fetcher)
    expect(Object.keys(body)).toEqual(['ClientID', 'AuthCode', 'CodeVerifier', 'DeviceInfo', 'IDEVersion'])
    expect(body.ClientID).toBe('ono9krqynydwx5')
    expect(body.AuthCode).toBe(REAL_AUTH_CODE)
    expect(body.CodeVerifier).toBe(REAL_CODE_VERIFIER)
    expect(body.IDEVersion).toBe('3.3.100')
    expect(body).not.toHaveProperty('ClientSecret')
    expect(body).not.toHaveProperty('DeviceProof')
  })

  it('DeviceInfo 全 12 字段进请求体，且设备号与登录 URL 同源', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return authExchangeSuccess()
    })
    await exchangeTraeCnAuthCode(args, TRAE_CN, fetcher)
    expect(body.DeviceInfo).toMatchObject({
      DeviceID: REAL_DEVICE_ID,
      MachineID: REAL_MACHINE_ID,
      PlatformCode: 'IDE_PC',
      DeviceType: 'PC',
      DeviceName: 'gurio的电脑',
      ClientVersion: '3.3.100',
      OSInfo: 'windows',
      OSVersion: 'Windows 10 Home',
    })
  })

  it('请求**不带** Authorization（此时还没有 token）', async () => {
    let headers: Record<string, string> = {}
    const fetcher = stubFetch((_u, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>
      return authExchangeSuccess()
    })
    await exchangeTraeCnAuthCode(args, TRAE_CN, fetcher)
    expect(headers).not.toHaveProperty('Authorization')
    expect(headers).not.toHaveProperty('X-Ide-Token')
  })

  it('缺 AuthCode / CodeVerifier 时立刻抛错（不发请求）', async () => {
    const fetcher = stubFetch(() => authExchangeSuccess())
    await expect(exchangeTraeCnAuthCode({ ...args, authCode: '' }, TRAE_CN, fetcher))
      .rejects.toThrow(/缺少 AuthCode/)
    await expect(exchangeTraeCnAuthCode({ ...args, codeVerifier: '' }, TRAE_CN, fetcher))
      .rejects.toThrow(/缺少 CodeVerifier/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('成功时返回 access / refresh / BoundDeviceID / 过期时刻', async () => {
    const result = await exchangeTraeCnAuthCode(args, TRAE_CN, stubFetch(() => authExchangeSuccess()))
    expect(result.accessToken.split('.')).toHaveLength(3)
    expect(result.refreshToken).toBe('RT-FROM-AUTHCODE')
    expect(result.boundDeviceId).toBe(REAL_BOUND_DEVICE_ID)
    expect(result.tokenExpireAt).toBe(REAL_TOKEN_EXPIRE_AT)
  })

  it('网络失败 / HTTP 非 2xx / 无 Token 各自抛可读错误', async () => {
    const boom = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    await expect(exchangeTraeCnAuthCode(args, TRAE_CN, boom)).rejects.toThrow(/网络失败.*socket hang up/)

    await expect(exchangeTraeCnAuthCode(args, TRAE_CN, stubFetch(
      () => new Response(JSON.stringify({ Code: 20324, Message: 'auth code expired' }), { status: 200 }),
    ))).rejects.toThrow(/auth code expired/)

    await expect(exchangeTraeCnAuthCode(args, TRAE_CN, stubFetch(
      () => new Response(JSON.stringify({ Result: { Weird: 1 } }), { status: 200 }),
    ))).rejects.toThrow(/找不到 Result.Token/)
  })
})

describe('parseTraeCnCallbackUrl（双模：PKCE 优先）', () => {
  it('主路径：authCodeInfo 双重编码 JSON 被解出 AuthCode', () => {
    const payload = parseTraeCnCallbackUrl(new URL(`http://127.0.0.1:1${TRAE_CN_CALLBACK_PATH}?${realCallbackQuery()}`))
    expect(payload).toMatchObject({
      mode: 'auth-code',
      authCode: REAL_AUTH_CODE,
      authCodeExpireAt: 1789592492958,
      userId: '1435281906741923',
      nickname: '河童',
      loginTraceId: REAL_LOGIN_TRACE_ID,
    })
  })

  it('userInfo 缺失不致命：退回裸 userId 参数，昵称留空', () => {
    const query = new URLSearchParams({
      [TRAE_CN_AUTH_CODE_INFO_PARAM]: JSON.stringify({ AuthCode: REAL_AUTH_CODE }),
      userId: 'u-bare',
    }).toString()
    expect(parseTraeCnCallbackUrl(new URL(`http://127.0.0.1:1${TRAE_CN_CALLBACK_PATH}?${query}`)))
      .toMatchObject({ mode: 'auth-code', authCode: REAL_AUTH_CODE, userId: 'u-bare', nickname: '' })
  })

  it('兼容分支：只有 refreshToken 时走 refresh-token 模式', () => {
    const query = new URLSearchParams({
      [TRAE_CN_REFRESH_TOKEN_PARAM]: 'RT-LEGACY', userId: 'u-2',
    }).toString()
    expect(parseTraeCnCallbackUrl(new URL(`http://127.0.0.1:1${TRAE_CN_CALLBACK_PATH}?${query}`)))
      .toMatchObject({ mode: 'refresh-token', refreshToken: 'RT-LEGACY', userId: 'u-2' })
  })

  it('两条分支同时出现时 **PKCE 优先**', () => {
    const query = new URLSearchParams({
      [TRAE_CN_AUTH_CODE_INFO_PARAM]: JSON.stringify({ AuthCode: REAL_AUTH_CODE }),
      [TRAE_CN_REFRESH_TOKEN_PARAM]: 'RT-LEGACY',
    }).toString()
    expect(parseTraeCnCallbackUrl(new URL(`http://127.0.0.1:1${TRAE_CN_CALLBACK_PATH}?${query}`))?.mode)
      .toBe('auth-code')
  })

  it('authCodeInfo 存在但 JSON 损坏 → 退回 refreshToken 分支（不静默丢弃载荷）', () => {
    const query = new URLSearchParams({
      [TRAE_CN_AUTH_CODE_INFO_PARAM]: '{坏 JSON',
      [TRAE_CN_REFRESH_TOKEN_PARAM]: 'RT-LEGACY',
    }).toString()
    expect(parseTraeCnCallbackUrl(new URL(`http://127.0.0.1:1${TRAE_CN_CALLBACK_PATH}?${query}`)))
      .toMatchObject({ mode: 'refresh-token' })
  })

  it('两者都没有 → undefined', () => {
    expect(parseTraeCnCallbackUrl(new URL(`http://127.0.0.1:1${TRAE_CN_CALLBACK_PATH}?scope=trae`)))
      .toBeUndefined()
  })
})

describe('completeTraeCnCallback（回调 → 凭据）', () => {
  const session = {
    machineId: REAL_MACHINE_ID,
    deviceId: REAL_DEVICE_ID,
    codeVerifier: REAL_CODE_VERIFIER,
    loginTraceId: REAL_LOGIN_TRACE_ID,
  }

  function callbackUrl(query: string): URL {
    return new URL(`http://127.0.0.1:1234${TRAE_CN_CALLBACK_PATH}?${query}`)
  }

  it('**主路径**：PKCE 回调 → 五件套凭据（device_id 取 BoundDeviceID）', async () => {
    let body: Record<string, unknown> = {}
    const fetcher = stubFetch((_u, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return authExchangeSuccess()
    })
    const credential = await completeTraeCnCallback(callbackUrl(realCallbackQuery()), session, TRAE_CN, fetcher)

    // 交换请求用的是回调里的 AuthCode 与本次登录的 verifier。
    expect(body.AuthCode).toBe(REAL_AUTH_CODE)
    expect(body.CodeVerifier).toBe(REAL_CODE_VERIFIER)
    // 凭据五件套：device_id 来自 exchange 响应，**不是**登录 URL 里的随机设备号。
    expect(credential).toMatchObject({
      refresh_token: 'RT-FROM-AUTHCODE',
      user_id: '1435281906741923',
      client_id: 'ono9krqynydwx5',
      device_id: REAL_BOUND_DEVICE_ID,
      machine_id: REAL_MACHINE_ID,
      device_id_source: 'exchange-bound-device-id',
      nickname: '河童',
    })
    // 过期时间取服务端权威值 TokenExpireAt。
    expect(credential.expires_at).toBe(String(REAL_TOKEN_EXPIRE_AT))
  })

  it('userId 缺失时从 access token 的 JWT 声明里取', async () => {
    const query = new URLSearchParams({
      [TRAE_CN_AUTH_CODE_INFO_PARAM]: JSON.stringify({ AuthCode: REAL_AUTH_CODE }),
    }).toString()
    const credential = await completeTraeCnCallback(
      callbackUrl(query), session, TRAE_CN,
      stubFetch(() => authExchangeSuccess({ Token: futureJwt({ user_id: 'from-jwt' }) })),
    )
    expect(credential.user_id).toBe('from-jwt')
  })

  it('兼容分支：回调带 refreshToken → 走续期端点，device_id **留空**（不伪造设备号）', async () => {
    let seenUrl = ''
    const fetcher = stubFetch((url) => {
      seenUrl = url
      return refreshSuccess()
    })
    const credential = await completeTraeCnCallback(
      callbackUrl(`${TRAE_CN_REFRESH_TOKEN_PARAM}=RT-CB&userId=u-cb`), session, TRAE_CN, fetcher,
    )
    // 端点必须是续期那条（cloudide），不能误打到登录交换（trae）。
    expect(seenUrl).toBe('https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken')
    expect(credential.refresh_token).toBe('RT-NEW')
    expect(credential.user_id).toBe('u-cb')
    // 该分支没有 exchange 响应 ⇒ 没有 BoundDeviceID ⇒ 如实留空。
    // 回归点：早先实现会拿 machine_id 折算一个假的 16 位号顶上（伪造设备身份）。
    expect(credential.device_id).toBe('')
  })

  it('两条分支都不带时抛错，错误里带脱敏后的实际参数', async () => {
    const error = await completeTraeCnCallback(
      callbackUrl('weird_param=SECRETLEAK&state=xyz&scope=trae'), session, TRAE_CN,
      stubFetch(() => authExchangeSuccess()),
    ).catch((e: unknown) => e as Error)
    expect(error.message).toMatch(/未携带 authCodeInfo 或 refreshToken/)
    // 参数名保留（诊断用），敏感值不出现在错误里。
    expect(error.message).toContain('weird_param=')
    expect(error.message).not.toContain('SECRETLEAK')
    expect(error.message).toContain('scope=trae')
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
    const session = await prepare({ fetcher: stubFetch(() => authExchangeSuccess()) })
    expect(session.loginUrl).toContain('https://www.trae.cn/authorization?')
    expect(session.port).toBe(callbackPort(session.loginUrl))
    expect(session.port).toBeGreaterThan(0)
    // 端口已在监听：没有任何载荷的回调得到 400（缺载荷），而不是连接失败；
    // **且会话不受影响**（畸形请求不得终结登录，见下一组用例）。
    const status = await callCallback(session.loginUrl, 'state=x')
    expect(status).toBe(400)
  })

  it('**畸形请求不终结会话**：先畸形后正常，正常那次仍能成功结算', async () => {
    // 回归点：早先实现把「解析不出凭据」当成登录失败（reject + 关端口），
    // 实测一次 500 探测就终结了整个会话 —— 浏览器预检、扫描器、用户误触
    // 都会误杀。正确行为是回 400 并让会话继续等真正的回调。
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 5000,
    })
    const settled = started(session.awaitCredential())

    for (const junk of ['state=x', '', 'weird_param=junk&foo=bar']) {
      expect(await callCallback(session.loginUrl, junk), `畸形请求 ${junk}`).toBe(400)
    }
    // 会话仍存活：互斥未释放，端口仍在监听。
    expect(hasActiveTraeCnLogin()).toBe(true)

    // 真回调照常结算，并以 307 回跳授权页结果页。
    const status = await callCallback(session.loginUrl, realCallbackQuery())
    expect(status).toBe(307)
    const { value, error } = await settled
    expect(error).toBeUndefined()
    expect(value!.refreshable).toBe(true)
    expect((JSON.parse(value!.access) as TraeCnCredential).device_id).toBe(REAL_BOUND_DEVICE_ID)
  })

  it('400 只报状态码，不回显请求内容（畸形请求可能带敏感值）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 1500,
    })
    const settled = started(session.awaitCredential())
    const response = await callCallbackRaw(session.loginUrl, 'weird_param=SECRETLEAK')
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('SECRETLEAK')
    const { error } = await settled
    expect(String(error)).toMatch(/登录超时/)
  })

  it('PKCE 回调 → awaitCredential 返回五件套凭据（设备号与登录 URL 同源）', async () => {
    const fetcher = stubFetch(() => authExchangeSuccess())
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, realCallbackQuery())
    expect(status).toBe(307)

    const { value: result } = await settled
    expect(result).toBeDefined()
    expect(result!.loginUrl).toBe(session.loginUrl)
    expect(result!.refreshable).toBe(true)
    expect(result!.expires).toBe(REAL_TOKEN_EXPIRE_AT)
    const credential = JSON.parse(result!.access) as TraeCnCredential
    expect(credential).toMatchObject({
      refresh_token: 'RT-FROM-AUTHCODE',
      user_id: '1435281906741923',
      client_id: 'ono9krqynydwx5',
      device_id: REAL_BOUND_DEVICE_ID,
      device_id_source: 'exchange-bound-device-id',
    })
    // machine_id / device_id 是本次登录随机生成的，与登录 URL 里的一致 ——
    // 它们同时进 exchange 请求体的 DeviceInfo，不一致会被服务端看出。
    expect(credential.machine_id).toBe(loginParam(session.loginUrl, 'machine_id'))
    expect(credential.machine_id).toMatch(/^[0-9a-f]{64}$/)
    expect(loginParam(session.loginUrl, 'device_id')).toMatch(/^\d{16}$/)
  })

  it('回调返回 CORS 头（浏览器跨域回调时不被静默丢弃）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 5000,
    })
    const settled = started(session.awaitCredential())
    const response = await callCallbackRaw(session.loginUrl, realCallbackQuery())
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    await settled
  })

  it('**成功回调 307 回跳授权页结果页**（对齐官方 updateLocalCredential）', async () => {
    // 回归点：早先回 200 + 静态 HTML「登录成功，可以关闭此窗口了」——
    // 该页面停在 127.0.0.1 上**自身无法离开**（HTML 里没有 window.close()）。
    // 弹窗被拦截、用户走面板内 <a target="_blank"> 手动链接时客户端没有窗口
    // 引用，closeLoginWindow() 够不到那张标签页 —— 307 回跳是唯一出路。
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 5000,
    })
    const settled = started(session.awaitCredential())
    const response = await callCallbackRaw(session.loginUrl, realCallbackQuery())
    expect(response.status).toBe(307)
    const location = response.headers.get('location')
    expect(location).not.toBeNull()

    // 回跳目标是**同一条授权页 URL，只把 redirect 换成 1** —— 与官方
    // `getLoginUrl(…, 1, …)` → `buildLoginUrl` 里 `redirect=${r||0}` 同构。
    const target = new URL(location!)
    expect(target.origin + target.pathname).toBe('https://www.trae.cn/authorization')
    expect(target.searchParams.get('redirect')).toBe('1')
    // 其余参数逐项保留：授权页靠它们认流程分支，少一个就渲染不出结果页。
    const original = new URL(session.loginUrl)
    for (const key of [...original.searchParams.keys()]) {
      if (key === 'redirect') continue
      expect(target.searchParams.get(key), `回跳 URL 丢失参数 ${key}`).toBe(original.searchParams.get(key))
    }
    // 响应体为空（不是 HTML 页）—— 回跳由浏览器自己完成。
    expect(await response.text()).toBe('')

    const { value } = await settled
    expect(value!.refreshable).toBe(true)
  })

  it('失败回调**维持 500**，不回跳（不猜测官方错误码页的渲染形态）', async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      Code: 20324, Message: 'auth code expired',
    }), { status: 200 }))
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const response = await callCallbackRaw(session.loginUrl, realCallbackQuery())
    expect(response.status).toBe(500)
    // 失败不 307：官方失败分支带 errorCode/errorMsg 回跳，而本插件的错误码
    // 体系与官方不通用，回跳一个渲染形态无法保证的页面比明确的 500 更难查。
    expect(response.headers.get('location')).toBeNull()
    const { error } = await settled
    expect(String(error)).toMatch(/auth code expired/)
  })

  it('OPTIONS 预检返回 204 与 CORS 头（且在路径判定之前处理）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 1500,
    })
    const settled = started(session.awaitCredential())
    const response = await fetch(
      `http://127.0.0.1:${session.port}${TRAE_CN_CALLBACK_PATH}`,
      { method: 'OPTIONS' },
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-headers')).toBe(
      TRAE_CN_CALLBACK_CORS_HEADERS['Access-Control-Allow-Headers'],
    )
    // 预检不完成登录；让超时收掉会话。
    const { error } = await settled
    expect(String(error)).toMatch(/登录超时/)
  })

  it('非回调路径返回 404 且**仍带 CORS 头**（否则浏览器只报跨域错）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 1500,
    })
    const settled = started(session.awaitCredential())
    const response = await fetch(`http://127.0.0.1:${session.port}/other`)
    expect(response.status).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    // 该会话不会完成，让超时把它收掉（断言超时错误而非成功）。
    const { error } = await settled
    expect(String(error)).toMatch(/登录超时/)
  })

  it('回调诊断钩子报出**走了哪条分支**（PKCE / refreshToken）', async () => {
    const seen: string[] = []
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 5000,
      onCallbackDebug: (message) => seen.push(message),
    })
    const settled = started(session.awaitCredential())
    await callCallback(session.loginUrl, realCallbackQuery())
    await settled
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain(`${TRAE_CN_AUTH_CODE_INFO_PARAM}=`)
    expect(seen[0]).toContain(`${TRAE_CN_USER_INFO_PARAM}=`)
    // 敏感值脱敏：authCode 与 userInfo 内容都不得出现在日志里。
    expect(seen[0]).not.toContain(REAL_AUTH_CODE)
    expect(seen[0]).not.toContain('189******95')
  })

  it('exchange 失败时回调返回 500 且 awaitCredential 抛出原因', async () => {
    // 500 与 400 的分界是「载荷可识别但交换失败」——那才是真正的登录失败。
    const fetcher = stubFetch(() => new Response(JSON.stringify({
      Code: 20324, Message: 'auth code expired',
    }), { status: 200 }))
    const session = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(session.awaitCredential())
    const status = await callCallback(session.loginUrl, realCallbackQuery())
    expect(status).toBe(500)
    const { error } = await settled
    expect(String(error)).toMatch(/auth code expired/)
  })

  it('超时后抛出可读的超时错误', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 50,
    })
    await expect(session.awaitCredential()).rejects.toThrow(/登录超时/)
  })

  it('超时后释放回调端口（不泄漏监听）', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 50,
    })
    await expect(session.awaitCredential()).rejects.toThrow()
    await expect(fetch(`http://127.0.0.1:${session.port}${TRAE_CN_CALLBACK_PATH}?refreshToken=x`))
      .rejects.toThrow()
  })

  it('cancel 释放端口，并让 awaitCredential 以错误结算', async () => {
    const session = await prepare({
      fetcher: stubFetch(() => authExchangeSuccess()),
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
    const fetcher = stubFetch(() => authExchangeSuccess())
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const second = await prepareTraeCnLogin({ product: TRAE_CN, fetcher, timeoutMs: 5000 })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('不应成功')
    expect(second.error).toBe('login-in-progress')
    // 没有句柄被交出去 —— 也就不存在第二个监听端口。
    expect('session' in second).toBe(false)

    // 第一次会话未被打扰：回调照常完成并换回凭据。
    const settled = started(first.awaitCredential())
    const status = await callCallback(first.loginUrl, realCallbackQuery())
    expect(status).toBe(307)
    const { value } = await settled
    expect(value!.refreshable).toBe(true)
  })

  it('互斥（并发）：三个并发 prepare 只有一个成功（同步占位，杜绝端口堆积）', async () => {
    // 这是回归用例：互斥检查若放在 `await listenOnRandomPort()` 之后，
    // 并发的三次调用会各自通过判空、各自起一个监听。
    // 故必须在不 await 的情况下连发，才能真正覆盖该窗口。
    const opts: TraeCnLoginPrepareOptions = {
      product: TRAE_CN,
      fetcher: stubFetch(() => authExchangeSuccess()),
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
    const fetcher = stubFetch(() => authExchangeSuccess())
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    const settled = started(first.awaitCredential())
    await callCallback(first.loginUrl, realCallbackQuery())
    await settled
    await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })

    const second = await prepareTraeCnLogin({ product: TRAE_CN, fetcher, timeoutMs: 5000 })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('互斥未释放')
    track(second.session)
    expect(second.session.port).toBeGreaterThan(0)
  })

  it('互斥（取消释放）：cancel 之后新会话可建立', async () => {
    const fetcher = stubFetch(() => authExchangeSuccess())
    const first = await prepare({ fetcher, timeoutMs: 5000 })
    first.cancel('用户放弃')
    await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })
    const second = await prepare({ fetcher, timeoutMs: 5000 })
    expect(second.loginUrl).not.toBe(first.loginUrl)
  })
})

describe('runTraeCnLoginFlow（阻塞式便捷封装）', () => {
  it('打开浏览器 → PKCE 回调 → 返回凭据', async () => {
    const fetcher = stubFetch(() => authExchangeSuccess())
    let openedUrl = ''
    const flow = started(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher,
      openBrowser: (url) => { openedUrl = url },
      timeoutMs: 5000,
    }))
    // 等 openBrowser 被调用（登录 URL 已就绪）后再模拟浏览器回调。
    await vi.waitFor(() => { expect(openedUrl).not.toBe('') })
    const status = await callCallback(openedUrl, realCallbackQuery())
    expect(status).toBe(307)

    const { value: result } = await flow
    expect(result).toBeDefined()
    expect(result!.loginUrl).toBe(openedUrl)
    expect(result!.refreshable).toBe(true)
    const credential = JSON.parse(result!.access) as TraeCnCredential
    expect(credential.refresh_token).toBe('RT-FROM-AUTHCODE')
    expect(credential.device_id).toBe(REAL_BOUND_DEVICE_ID)
  })

  it('超时后抛出可读的超时错误', async () => {
    await expect(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher: stubFetch(() => authExchangeSuccess()),
      openBrowser: () => {},
      timeoutMs: 50,
    })).rejects.toThrow(/登录超时/)
  })

  it('已有未结算会话时抛出可读错误（不静默复用）', async () => {
    const session = await prepareTraeCnLogin({
      product: TRAE_CN,
      fetcher: stubFetch(() => authExchangeSuccess()),
      timeoutMs: 5000,
    })
    expect(session.ok).toBe(true)
    if (session.ok) track(session.session)
    await expect(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher: stubFetch(() => authExchangeSuccess()),
      openBrowser: () => {},
      timeoutMs: 5000,
    })).rejects.toThrow(/已有 Trae CN 登录进行中/)
  })

  it('打开浏览器失败时会话被释放（不占端口到超时）', async () => {
    await expect(runTraeCnLoginFlow({
      product: TRAE_CN,
      fetcher: stubFetch(() => authExchangeSuccess()),
      openBrowser: () => { throw new Error('no browser') },
      timeoutMs: 5000,
    })).rejects.toThrow(/no browser/)
    await vi.waitFor(() => { expect(hasActiveTraeCnLogin()).toBe(false) })
  })
})

describe('buildTraeCnCredential', () => {
  it('服务端 TokenExpireAt 优先于 JWT exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const credential = buildTraeCnCredential({
      accessToken: makeJwt({}, exp),
      refreshToken: 'RT',
      userId: 'u-1',
      clientId: 'cid',
      deviceId: 'dev',
      deviceIdSource: 'exchange-bound-device-id',
      machineId: REAL_MACHINE_ID,
      expiresAt: REAL_TOKEN_EXPIRE_AT,
    })
    expect(credential.expires_at).toBe(String(REAL_TOKEN_EXPIRE_AT))
    expect(credential.expires_at).not.toBe(String(exp * 1000))
  })

  it('无服务端过期时间时由 access token 的 JWT exp 派生', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const credential = buildTraeCnCredential({
      accessToken: makeJwt({}, exp),
      refreshToken: 'RT',
      userId: 'u-1',
      clientId: 'cid',
      deviceId: 'dev',
      deviceIdSource: 'exchange-bound-device-id',
      machineId: REAL_MACHINE_ID,
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
      deviceIdSource: 'exchange-bound-device-id',
      machineId: REAL_MACHINE_ID,
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
      return refreshSuccess()
    })
    await exchangeTraeCnToken({ refreshToken: 'RT', userId: 'u-1' }, custom, fetcher)
    expect(seenUrl).toBe(`https://example.test${TRAE_CN_EXCHANGE_TOKEN_PATH}`)
  })

  it('登录交换端点同样跟随产品配置', async () => {
    const custom: TraeCnProduct = { ...TRAE_CN, apiBase: 'https://example.test' }
    let seenUrl = ''
    const fetcher = stubFetch((url) => {
      seenUrl = url
      return authExchangeSuccess()
    })
    await exchangeTraeCnAuthCode({
      authCode: 'AC', codeVerifier: 'CV', deviceId: REAL_DEVICE_ID, machineId: REAL_MACHINE_ID,
    }, custom, fetcher)
    expect(seenUrl).toBe(`https://example.test${TRAE_CN_AUTH_EXCHANGE_PATH}`)
  })
})
