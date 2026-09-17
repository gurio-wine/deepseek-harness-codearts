/**
 * Trae CN（字节跳动 Trae 国内版）登录与凭据。
 *
 * ## 与另外两条协议线的差异
 *
 * | 项 | LobsterAI | 腾讯系 | **Trae CN** |
 * |---|---|---|---|
 * | 登录 | 本地回调收 `code` → exchange | external-link 轮询 | **本地回调直接收 refreshToken** |
 * | 换 token | `authCode` → access+refresh | 轮询结果自带 | **无 authCode 交换**（登录页自己完成 GetRefreshToken） |
 * | 续期 | `POST /api/auth/refresh` | `X-Refresh-Token` 头 | **`POST …/oauth/ExchangeToken`（body 四字段）** |
 * | 鉴权头 | `Bearer` | `Bearer` + 归属头 | **`Cloud-IDE-JWT`**（另带两个等值 token 头） |
 *
 * 登录回调**直接携带 refreshToken**是最容易搞错的一点：没有 `authCode`，
 * 也就没有「用 code 换 token」那一步。回调收到 refreshToken 后要**立即**
 * 走 `ExchangeToken` 拿 access token（对齐 `traework2api/login.sh`：
 * 它解析回调 URL query 里的 refreshToken 后直接 ExchangeToken）。
 *
 * ## 模块边界
 *
 * 本模块只做**登录 + 凭据 + 续期请求**，不含：LLM 适配器、签到、积分余额
 * —— 那三块是后续任务。故这里不定义 chat / models / credits 端点常量。
 *
 * ## ⚠️ 待实测校准点（T5）
 *
 * 调研报告明确指出**回调 URL 的确切形态未经实测**。本实现采取
 * 「**主路径 + 日志脱敏**」策略，而不是猜一个参数名就闭眼过：
 *
 * 1. **主路径**：回调 query 携带 refreshToken（`traework2api/login.sh` 的行为）。
 *    参数名按候选表依次尝试（{@link TRAE_CN_REFRESH_TOKEN_PARAMS}），
 *    顺序表本身就是「哪个最可能是真的」的记录；
 * 2. **日志**：每条回调都会经 {@link redactTraeCnCallbackUrl} 输出一份
 *    **保留全部参数名、敏感值脱敏**的 URL，由调用方（`TraeCnAuth`）写进
 *    `ctx.logger`。真实登录一次即可按日志把候选表收敛成唯一形态；
 * 3. **不猜的部分**：拿不到的字段一律走**显式回退**并在凭据里留下来源标记
 *    （如 `device_id_source`），而不是静默填一个看起来正常的假值。
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { jwtExpiresAtMs } from './buddy.js'
import {
  TRAE_CN_AUTHORIZATION_PATH,
  TRAE_CN_CALLBACK_PATH,
  TRAE_CN_EXCHANGE_TOKEN_PATH,
  TRAE_CN_LOGIN_TIMEOUT_MS,
  TRAE_CN_REQUEST_TIMEOUT_MS,
  type TraeCnDeviceIdSource,
  type TraeCnProduct,
} from './trae-cn-product.js'

/** 在浏览器中打开登录 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>

// ── 回调参数候选表（T5 校准点，见模块头注释） ──

/**
 * 回调 query 中承载 **refreshToken** 的参数名候选，按可能性排序。
 *
 * **主路径是第一个**（`refreshToken`，对齐 `traework2api/login.sh` 解析的
 * query 字段与 Trae 接口自身的大小写风格）。其余是同义写法的兜底：
 * 一旦真实回调用了别的名字，候选表能让登录**当场成功**，而日志会记录
 * 实际参数名，供随后把这里收敛成唯一项。
 */
export const TRAE_CN_REFRESH_TOKEN_PARAMS: readonly string[] = [
  'refreshToken',
  'refresh_token',
  'RefreshToken',
]

/** 回调 query 中承载 **userId** 的参数名候选（`ExchangeToken` 的必填字段）。 */
export const TRAE_CN_USER_ID_PARAMS: readonly string[] = [
  'userId',
  'user_id',
  'UserID',
  'uid',
]

/**
 * 回调 query 中承载 **deviceId**（Aha 设备号）的参数名候选。
 *
 * 拿不到时回退 `machine_id` 的十进制形态（见
 * {@link machineIdToDecimalDeviceId}），并在凭据的 `device_id_source`
 * 里标为 `machine-id-fallback` —— 属于**显式降级**，不是静默伪造。
 */
export const TRAE_CN_DEVICE_ID_PARAMS: readonly string[] = [
  'deviceId',
  'device_id',
  'deviceID',
  'ahaDeviceId',
]

/**
 * 回调 query 中**直接携带 access token** 的参数名候选。
 *
 * 次要路径：若某天真机回调直接给了 access token（而非只给 refreshToken），
 * 就不必再走 ExchangeToken。当前无实测证据支持它存在，故仅作兜底。
 *
 * ⚠️ **这一路径比其它三张表更危险**：参数名叫 `token` 的完全可能是个 CSRF
 * 令牌，把它当 access token 会**静默存下一份坏凭据**（登录「成功」、之后
 * 每次请求都 401）。故识别时额外要求它**必须是 JWT 形态**（三段点分）——
 * 见 {@link looksLikeTraeCnJwt}。形态不符时不算命中，照常走主路径
 * （refreshToken → ExchangeToken），而那才是已实测的路径。
 */
export const TRAE_CN_ACCESS_TOKEN_PARAMS: readonly string[] = [
  'accessToken',
  'access_token',
  'token',
]

/**
 * 判定一个字符串是否具备 JWT 形态（三段点分、payload 可 base64url 解出 JSON）。
 *
 * 只用于「这个候选值像不像 access token」的**准入判断**，不做签名校验
 * —— access token 的真伪由服务端裁决。它的作用是排除 `token=<CSRF 串>`
 * 这类同名误命中。
 */
export function looksLikeTraeCnJwt(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 3) return false
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
    return typeof payload === 'object' && payload !== null
  } catch {
    return false
  }
}

/** 生成一枚 32 位十六进制随机串（16 字节）。 */
export function generateTraeCnHex32(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 把 hex32 的 `machineId` 折算成**十进制设备号**（Aha 设备号形态的兜底）。
 *
 * Aha 设备号是 **16 位十进制数字**；`machineId` 是 128 位十六进制。
 * 这里取机器号的十进制表示并保留**低 16 位**，使其位数与 Aha 号一致 ——
 * 位数一致是「让签到接口的 `x-device-id` 至少形态合法」的最低要求。
 *
 * ⚠️ **TODO（T5 校准）**：这只是**兜底**。`deviceId` 的真实来源是登录回调 /
 * `GetRefreshToken` 响应里的 Aha 设备号；本函数产出的值与真实 Aha 号
 * **不保证被服务端接受**。凡走到这条路径的凭据，`device_id_source` 都会被
 * 标成 `machine-id-fallback`，让它在数据里可见（UI 与日志可据此提示重新登录）。
 * 真机验证后应确认：签到接口是否强校验该值、以及回调里能否稳定拿到 Aha 号。
 */
export function machineIdToDecimalDeviceId(machineIdHex: string): string {
  const cleaned = machineIdHex.trim().toLowerCase()
  // 非十六进制（含空串）时退化为全零，而不是抛错：调用方在登录流程里，
  // 不该因为一个设备号形态问题让整个登录失败。
  const decimal = /^[0-9a-f]+$/.test(cleaned) ? BigInt(`0x${cleaned}`).toString(10) : '0'
  return decimal.slice(-16).padStart(16, '0')
}

// ── 凭据数据结构 ──

/**
 * 持久化的 Trae CN 凭据（**五件套整体配对存储**）。
 *
 * 字段名与 `BuddyCredential` / `LobsteraiCredential` 保持同一套 `snake_case`
 * 约定 —— `AccountPool.findAccountIdByCredential`（`src/account-pool.ts`）
 * 对非 codearts 的 provider 统一取 **`access_token`** 作身份标识，
 * 命名一致才能直接复用该函数。与协议字段（`RefreshToken` / `UserID` /
 * `ClientID`）的对应关系见各字段说明。
 *
 * **五件套** = `refresh_token` + `user_id` + `client_id` + `device_id` + `machine_id`。
 * 它们必须**按账号整体配对**：任何一个丢失/串号都会让续期或签到用到别的身份的字段。
 */
export interface TraeCnCredential {
  /**
   * 访问令牌（JWT）。
   *
   * 用法：`Authorization: Cloud-IDE-JWT <access_token>`，另带
   * `X-Ide-Token` 与 `X-Cloudide-Token` 两个同值头（见
   * {@link traeCnAccessHeaders}）。
   */
  access_token: string
  /** 刷新令牌（五件套之一；`ExchangeToken` 请求体的 `RefreshToken`）。 */
  refresh_token: string
  /** 用户 ID（五件套之一；`ExchangeToken` 请求体的 `UserID`）。 */
  user_id: string
  /** OAuth 客户端 ID（五件套之一；与产品配置的 `clientId` 同值，随凭据快照留档）。 */
  client_id: string
  /**
   * 设备号（五件套之一）。
   *
   * 理论上应是 **Aha 设备号**（16 位十进制）——签到的 `x-device-id` 用它，
   * **不是**登录 URL 里那个随机 `device_id`。来源见 {@link device_id_source}。
   */
  device_id: string
  /** 机器号（五件套之一，32 位十六进制）；登录 URL 的 `machine_id` 用之。 */
  machine_id: string
  /** `device_id` 的来源标记（诊断用）。 */
  device_id_source: TraeCnDeviceIdSource
  /**
   * 过期时间（**毫秒时间戳字符串**）。
   *
   * Trae 的 access token 是 JWT，`exp` 才是权威过期时刻，故这里的值
   * 始终由 {@link jwtExpiresAtMs} 从 token 派生（解析不出时为空串）。
   */
  expires_at?: string
  /** 昵称（UI 展示；登录回调/JWT 提供时才写）。 */
  nickname?: string
}

/** 凭据是否携带可静默续期的 `refresh_token`。 */
export function isTraeCnRefreshable(credential: TraeCnCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/**
 * 从凭据解析过期的毫秒时间戳。
 *
 * 优先用存储的 `expires_at`，缺失时**回退解析 access token 的 JWT `exp`** ——
 * Trae 的 access token 是 JWT，`exp` 是权威来源，故两级解析口径一致。
 */
export function traeCnCredentialExpiresAtMs(credential: TraeCnCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtExpiresAtMs(credential.access_token)
}

/** 凭据是否已过期；无法解析过期时间时**不**判定过期（与另外两条协议线一致）。 */
export function isTraeCnExpired(credential: TraeCnCredential): boolean {
  const expiresAt = traeCnCredentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/**
 * 解析存储值里的凭据 JSON；解析失败或结构不合法返回 undefined。
 *
 * 判据只有一条：`access_token` 必须是字符串（账号池反查身份标识要用它）。
 * 其余字段允许缺失 —— 老凭据、或 T5 校准前的降级凭据都不该因此判为损坏。
 */
export function parseTraeCnCredential(value: string): TraeCnCredential | undefined {
  try {
    const parsed = JSON.parse(value) as TraeCnCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 序列化凭据（存入 `ctx.credentials` 的形态）。 */
export function serializeTraeCnCredential(credential: TraeCnCredential): string {
  return JSON.stringify(credential)
}

// ── 请求头 ──

/**
 * 构造带 Trae 鉴权的请求头。
 *
 * **三个头都带**：网关接受等价鉴权（三选一即可），但三个同值一起发是
 * 实测量最稳的形态 —— 不同的 Trae 服务端组件读不同的头。
 *
 * 刻意**不带**腾讯系的 `X-Domain` / `X-Product*` 归属头，也不带
 * LobsterAI 的 `X-LobsterAI-Client-*`：那些头对本服务无意义，
 * 带上会让服务端按错误的客户端形态归因。
 */
export function traeCnAccessHeaders(
  credential: TraeCnCredential,
  accept = 'application/json',
): Record<string, string> {
  return {
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Ide-Token': credential.access_token,
    'X-Cloudide-Token': credential.access_token,
    Accept: accept,
    'Content-Type': 'application/json',
  }
}

/**
 * 构造 `ExchangeToken` 的无鉴权请求头。
 *
 * 续期时**还没有**新的 access token，服务端只认请求体里的 `RefreshToken`
 * 与 `UserID`，故不发 `Authorization`。
 *
 * ⚠️ 调研未给出该端点的 `User-Agent` 约定，故**刻意不发明一个值**。
 * 若真机验证发现网关按 UA 拦截，再补一个实测值并在此注明来源。
 */
export function traeCnAnonymousHeaders(): Record<string, string> {
  return { Accept: 'application/json', 'Content-Type': 'application/json' }
}

// ── ExchangeToken（续期 / 登录后换取 access token） ──

/** `ExchangeToken` 响应解析出的载荷。 */
export interface TraeCnTokenPayload {
  /** 新的 access token（JWT）。 */
  accessToken: string
  /** 新的 refresh token；响应未返回时为空串（沿用旧的）。 */
  refreshToken: string
  /** 响应里带的用户 ID（没有则为空串）。 */
  userId: string
  /** 响应里带的设备号（没有则为空串）。 */
  deviceId: string
  /** 昵称（没有则为空串）。 */
  nickname: string
}

/** 从若干候选键里取第一个非空字符串值。 */
function readFirstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** 取出可能承载业务载荷的嵌套对象（响应可能套 `Result` / `Data` 等信封）。 */
function readEnvelopeObjects(body: Record<string, unknown>): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [body]
  for (const key of ['Result', 'result', 'Data', 'data']) {
    const value = body[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      layers.push(value as Record<string, unknown>)
    }
  }
  return layers
}

/**
 * 判定响应是否为业务失败。
 *
 * Trae 的接口风格是 `{Code/Code: 0, Message: "..."}` 信封（大小写两种写法都
 * 出现过）。**没有 code 字段也算成功** —— 有些组件直接返回裸载荷，
 * 按「必须显式 code:0」判会把成功当失败。
 */
function readEnvelopeError(body: Record<string, unknown>): string | undefined {
  for (const key of ['Code', 'code', 'ErrCode', 'errCode']) {
    const value = body[key]
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
      const message = readFirstString(body, ['Message', 'message', 'Msg', 'msg', 'ErrMsg', 'errMsg'])
      return message.length > 0 ? message : `code=${value}`
    }
    if (typeof value === 'string' && value.length > 0 && value !== '0') {
      const message = readFirstString(body, ['Message', 'message', 'Msg', 'msg', 'ErrMsg', 'errMsg'])
      return message.length > 0 ? message : `code=${value}`
    }
  }
  // 顶层 Error/error 字段（部分网关直接返回它）。
  const error = body.Error ?? body.error
  if (typeof error === 'string' && error.length > 0) return error
  return undefined
}

/**
 * 解析 `ExchangeToken` 响应。
 *
 * 候选键**大小写/命名两种风格都收**（`Token` / `AccessToken` / `access_token`…）：
 * 调研只确认了「响应含新 access token（JWT）」，未固定字段名。
 * 与其猜一个，不如按候选表取，并让 {@link exchangeTraeCnToken} 在
 * **全都没命中**时抛出带上原始键名的错误 —— 那样一次真机调用就能把
 * 候选表收敛，而不是留下一个「续期永远失败但原因不明」的哑谜。
 */
export function parseTraeCnTokenPayload(body: unknown): TraeCnTokenPayload | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const root = body as Record<string, unknown>
  if (readEnvelopeError(root) !== undefined) return undefined
  for (const layer of readEnvelopeObjects(root)) {
    const accessToken = readFirstString(layer, [
      'Token', 'token', 'AccessToken', 'access_token', 'accessToken',
    ])
    if (accessToken.length === 0) continue
    const user = typeof layer.User === 'object' && layer.User !== null
      ? layer.User as Record<string, unknown>
      : (typeof layer.user === 'object' && layer.user !== null ? layer.user as Record<string, unknown> : {})
    return {
      accessToken,
      refreshToken: readFirstString(layer, ['RefreshToken', 'refresh_token', 'refreshToken']),
      userId: readFirstString(layer, ['UserID', 'UserId', 'userId', 'user_id', 'uid'])
        || readFirstString(user, ['ID', 'Id', 'id', 'userId', 'user_id']),
      deviceId: readFirstString(layer, ['DeviceID', 'DeviceId', 'deviceId', 'device_id'])
        || readFirstString(user, ['DeviceID', 'DeviceId', 'deviceId', 'device_id']),
      nickname: readFirstString(layer, ['Nickname', 'nickname', 'Name', 'name', 'UserName', 'userName'])
        || readFirstString(user, ['Nickname', 'nickname', 'Name', 'name']),
    }
  }
  return undefined
}

/** 诊断用：响应里出现过的顶层键名（不涉值，可安全入日志）。 */
function describeTopLevelKeys(body: unknown): string {
  if (typeof body !== 'object' || body === null) return typeof body
  return Object.keys(body as Record<string, unknown>).join(',') || '(空对象)'
}

/**
 * 用 `RefreshToken` 换新的 access token（**续期**，也是登录后取 access 的路径）。
 *
 * 请求体四字段（实测形态）：
 * `{ClientID, ClientSecret, RefreshToken, UserID}`。
 * `ClientSecret` 实测为占位串 `"-"`，服务端不校验（见产品配置）。
 *
 * @throws 网络失败、HTTP 非 2xx、业务码非 0、或响应中找不到 access token 时。
 */
export async function exchangeTraeCnToken(
  args: { refreshToken: string; userId: string },
  product: TraeCnProduct,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TraeCnTokenPayload> {
  if (args.refreshToken.length === 0) {
    throw new Error('Trae CN 续期缺少 refresh_token，请重新登录')
  }
  const body = {
    ClientID: product.clientId,
    ClientSecret: product.clientSecret,
    RefreshToken: args.refreshToken,
    UserID: args.userId,
  }
  const signalToUse = signal === undefined
    ? AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS)
    : AbortSignal.any([AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS), signal])

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${TRAE_CN_EXCHANGE_TOKEN_PATH}`, {
      method: 'POST',
      headers: traeCnAnonymousHeaders(),
      body: JSON.stringify(body),
      signal: signalToUse,
    })
  } catch (error) {
    // 传输层失败**不**是终态：交给调用方（与 RefreshScheduler）走可重试路径。
    throw new Error(`Trae CN ExchangeToken 网络失败：${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`Trae CN ExchangeToken 响应不是 JSON（HTTP ${response.status}）`)
  }

  if (!response.ok) {
    const message = typeof parsed === 'object' && parsed !== null
      ? readEnvelopeError(parsed as Record<string, unknown>) : undefined
    throw new Error(
      `Trae CN ExchangeToken 失败（HTTP ${response.status}）`
      + `${message === undefined ? '' : `：${message}`}`,
    )
  }

  const payload = parseTraeCnTokenPayload(parsed)
  if (payload === undefined) {
    const envelopeError = typeof parsed === 'object' && parsed !== null
      ? readEnvelopeError(parsed as Record<string, unknown>) : undefined
    if (envelopeError !== undefined) {
      throw new Error(`Trae CN ExchangeToken 失败：${envelopeError}`)
    }
    // 没有 access token：把**实际键名**带进错误里。候选表猜错时，
    // 这一条日志就足以定位（见 parseTraeCnTokenPayload 的说明）。
    throw new Error(
      `Trae CN ExchangeToken 响应中找不到 access token（顶层键：${describeTopLevelKeys(parsed)}）`,
    )
  }
  return payload
}

/**
 * 用续期结果更新凭据（保留服务端未返回的字段）。
 *
 * **五件套里的身份字段一律沿用旧值**（`user_id` / `client_id` / `device_id`
 * / `machine_id`）：续期响应只带令牌，不含账号对象。`refresh_token` 仅在
 * 响应给了新值时才覆盖 —— 覆盖成空串会让下一次续期直接失败。
 *
 * `user_id` 是唯一例外：响应若给了（或 JWT 里有），**回填**它 ——
 * 登录时拿不到 user_id 的降级凭据会因此在首次续期后自愈。
 */
export function applyTraeCnRefresh(
  previous: TraeCnCredential,
  payload: TraeCnTokenPayload,
): TraeCnCredential {
  const expiresAt = jwtExpiresAtMs(payload.accessToken)
  return {
    ...previous,
    access_token: payload.accessToken,
    refresh_token: payload.refreshToken.length > 0 ? payload.refreshToken : previous.refresh_token,
    user_id: previous.user_id.length > 0
      ? previous.user_id
      : (payload.userId.length > 0 ? payload.userId : previous.user_id),
    device_id: previous.device_id.length > 0
      ? previous.device_id
      : (payload.deviceId.length > 0 ? payload.deviceId : previous.device_id),
    nickname: previous.nickname !== undefined && previous.nickname.length > 0
      ? previous.nickname
      : payload.nickname,
    expires_at: expiresAt === undefined ? (previous.expires_at ?? '') : String(expiresAt),
  }
}

// ── 登录 URL 与回调脱敏 ──

/**
 * 构造登录 URL。
 *
 * 形态（实测）：
 * `{portalBase}/authorization?clientID=…&auth_callback_url=…&machine_id=…&device_id=…`
 *
 * `machine_id` / `device_id` 是**每次登录随机生成的 hex32**；服务端不校验
 * 它们与签到设备号（Aha 号）的一致性 —— 后者的来源是凭据里的
 * `device_id`，与这两个参数无关。这一点极易混淆，故在此显式记录。
 *
 * ⚠️ 用 `URL` + `searchParams` 而非手工拼字符串：`auth_callback_url` 含
 * `://` 与 `:` 必须被百分号编码，手工拼极易漏编码导致登录页校验失败。
 */
export function buildTraeCnLoginUrl(
  port: number,
  product: TraeCnProduct,
  machineId: string,
  deviceId: string,
): string {
  const query = new URLSearchParams({
    clientID: product.clientId,
    auth_callback_url: `http://127.0.0.1:${port}${TRAE_CN_CALLBACK_PATH}`,
    machine_id: machineId,
    device_id: deviceId,
  })
  return `${product.portalBase}${TRAE_CN_AUTHORIZATION_PATH}?${query.toString()}`
}

/**
 * 回调参数中**可安全原样入日志**的白名单（非机密元数据）。
 *
 * 采用**白名单（fail-closed）**而非「敏感键黑名单」：黑名单只能挡住
 * 你**想得到**的名字，而回调里出现什么参数名恰恰是未知的（这正是 T5 要校准的
 * 东西）—— 一个叫 `weird_param` 的未知参数完全可能就是凭据。
 * 白名单的默认动作是脱敏，未知参数最多泄露「名字 + 长度 + 6 字符前缀」。
 *
 * 白名单里的值都是**本次登录自己生成**或**非机密**的：
 * `machine_id` / `device_id` 是登录 URL 里那两个随机 hex32，
 * `auth_callback_url` / `clientID` 是登录 URL 的回显，`state` 是一次性随机串。
 */
const SAFE_CALLBACK_PARAMS: ReadonlySet<string> = new Set([
  // 设备号的全部候选名：这些值是一次性的硬件/安装标识，不是凭据，
  // 而且「拿到的是真 Aha 号还是 machine_id 兜底」正是 T5 要看清的东西。
  ...TRAE_CN_DEVICE_ID_PARAMS,
  'machine_id',
  'state',
  'clientID',
  'client_id',
  'auth_callback_url',
  'redirect_uri',
  'port',
])

/**
 * 把回调 URL 脱敏成可安全入日志的形态（**保留全部参数名**）。
 *
 * 脱敏规则（**默认脱敏，白名单放行**）：
 * - **参数名一律完整保留** —— 它们才是校准 T5 所需的信息；
 * - 白名单内的非机密元数据（见 {@link SAFE_CALLBACK_PARAMS}）原样保留其值；
 * - **其余一切参数**（含未知名字）的值压成 `前6位…(len=N)`，只够确认
 *   「拿到了东西」与「长度对不对」。宁可校准信息少一点，也不把可能是
 *   refreshToken 的值写进日志。
 *
 * 解析失败时**不返回原串**（原串可能带 token），而是返回长度与错误说明。
 */
export function redactTraeCnCallbackUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl, 'http://127.0.0.1')
  } catch {
    return `<无法解析的回调 URL，长度 ${rawUrl.length}>`
  }
  const parts: string[] = []
  for (const [key, value] of url.searchParams) {
    if (SAFE_CALLBACK_PARAMS.has(key)) {
      parts.push(value.length <= 64 ? `${key}=${value}` : `${key}=${value.slice(0, 32)}…(len=${value.length})`)
      continue
    }
    const head = value.slice(0, Math.min(6, value.length))
    parts.push(`${key}=${head}…(len=${value.length})`)
  }
  const query = parts.length === 0 ? '(无 query 参数)' : parts.join('&')
  const hash = url.hash.length > 0 ? ` hash=${url.hash}` : ''
  return `${url.pathname}?${query}${hash}`
}

// ── 登录流程 ──

/** 一次登录流程的结果。 */
export interface TraeCnLoginFlowResult {
  /** 已序列化的 `TraeCnCredential` JSON 字符串（直接存入 ctx.credentials）。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** `runTraeCnLoginFlow` 接受的选项。 */
export interface TraeCnLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 打开登录 URL 的方式；默认用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 回调等待总超时（毫秒）；默认 10 分钟。 */
  timeoutMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 产品配置；默认 TRAE_CN。 */
  product?: TraeCnProduct
  /**
   * 回调诊断钩子（收到**每条**回调时调用，参数已脱敏）。
   *
   * 存在的理由是 T5：回调参数名未经实测，真实登录一次即可按这条日志
   * 把候选表收敛。生产侧由 `TraeCnAuth` 接到 `ctx.logger.info`。
   */
  onCallbackDebug?: (message: string) => void
}

/** 从若干候选参数名里取第一个非空 query 值。 */
function readCallbackParam(url: URL, candidates: readonly string[]): { name: string; value: string } | undefined {
  for (const name of candidates) {
    const value = url.searchParams.get(name)
    if (value !== null && value.length > 0) return { name, value }
  }
  return undefined
}

/** 从 JWT 里读出用户 ID（`user_id` / `userId` / `uid` / `sub` 依次尝试）。 */
export function readTraeCnJwtUserId(token: string): string {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    return readFirstString(payload, ['user_id', 'userId', 'uid', 'sub', 'UserID'])
  } catch {
    return ''
  }
}

/** 从 JWT 里读出昵称（没有则空串）。 */
function readTraeCnJwtNickname(token: string): string {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
    return readFirstString(payload, ['nickname', 'name', 'preferred_username'])
  } catch {
    return ''
  }
}

/**
 * 一次「已准备、待完成」的登录会话（两段式的第一段产物）。
 *
 * 与 {@link runTraeCnLoginFlow} 的区别：**流程内不再打开浏览器**。
 * 打开动作必须由持有用户手势的一方（客户端弹窗）完成 —— 这正是两段式改造的
 * 目的：RPC 立即把 `loginUrl` 返回给客户端，客户端在同一手势内 `open`，
 * 宿主不再持有「等 10 分钟」的阻塞调用（用户手势过期会让弹窗被拦截，
 * 客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉）。
 */
export interface TraeCnPendingLogin {
  /** 本地回调服务器实际监听的端口。 */
  port: number
  /** 展示给用户的 portal 登录 URL（含本次随机的 machine_id / device_id）。 */
  loginUrl: string
  /** 等待用户在浏览器完成登录、并换取 access token。 */
  awaitCredential(): Promise<TraeCnLoginFlowResult>
  /** 主动放弃本次登录：关闭回调端口，并让 {@link awaitCredential} 以错误结算。 */
  cancel(reason?: string): void
}

/**
 * {@link prepareTraeCnLogin} 的结果。
 *
 * 用判别联合而非「抛异常」表达互斥：调用方（RPC 层）需要把
 * `login-in-progress` 原样透传给客户端做提示，异常会被 RPC 的统一错误包装
 * 成 `jet-hub/handler-failed`，客户端拿不到可判别的错误码。
 */
export type TraeCnLoginPrepareOutcome =
  | { ok: true; session: TraeCnPendingLogin }
  | { ok: false; error: 'login-in-progress'; message: string }

/** {@link prepareTraeCnLogin} 接受的选项（无 `openBrowser` —— 该阶段不开浏览器）。 */
export type TraeCnLoginPrepareOptions =
  Omit<TraeCnLoginFlowOptions, 'openBrowser'> & { product: TraeCnProduct }

/**
 * 进行中的登录槽位（模块级，同一时间最多一个）。
 *
 * prepare 阶段会**占用一个本地监听端口**，而客户端的「新建账号」按钮可以被
 * 反复点击。没有互斥时每次点击都会起一个新的 loopback 服务器，
 * 点 N 次就有 N 个端口一直挂到 10 分钟超时。
 *
 * `'preparing'` 是**同步占位**：从进入临界区到回调服务器真正 listen 成功之间
 * 存在多个 await，若只在 listen 完成后才登记，并发的两次调用会双双通过判空
 * 检查、各自起一个监听（LobsterAI 侧实测：3 次并发 prepare 全部成功、3 个端口）。
 * 故必须在**第一个 await 之前**同步占位。
 */
type TraeCnLoginSlot = TraeCnPendingLogin | 'preparing'

let activeLoginSlot: TraeCnLoginSlot | undefined

/** 当前是否有未结算的登录会话（含正在准备中的；供诊断与单测断言使用）。 */
export function hasActiveTraeCnLogin(): boolean {
  return activeLoginSlot !== undefined
}

/**
 * 处理一次回调：从 query 里取 refreshToken，换取 access token 并组装凭据。
 *
 * 抽成函数是为了让「回调参数 → 凭据」这段纯逻辑可被单测直接覆盖，
 * 不必每次都起 HTTP 服务器。
 *
 * @param callbackUrl - 回调请求的完整 URL（query 里带 refreshToken）。
 * @param session - 本次登录随机生成的 `machineId`（hex32），用于设备号兜底与凭据留档。
 * @param product - 产品配置（用到 `apiBase` / `clientId` / `clientSecret`）。
 * @throws refreshToken 缺失、或 exchange 失败时。
 */
export async function completeTraeCnCallback(
  callbackUrl: URL,
  session: { machineId: string },
  product: TraeCnProduct,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<TraeCnCredential> {
  const refresh = readCallbackParam(callbackUrl, TRAE_CN_REFRESH_TOKEN_PARAMS)
  if (refresh === undefined) {
    throw new Error(
      '登录回调未携带 refreshToken'
      + `（实际参数：${redactTraeCnCallbackUrl(callbackUrl.toString())}）`,
    )
  }

  // 设备号：优先回调里的 Aha 号，拿不到才回退 machine_id 的十进制形态。
  const device = readCallbackParam(callbackUrl, TRAE_CN_DEVICE_ID_PARAMS)
  const deviceId = device?.value ?? machineIdToDecimalDeviceId(session.machineId)
  const deviceIdSource: TraeCnDeviceIdSource = device === undefined ? 'machine-id-fallback' : 'aha'

  // userId：回调 → refreshToken 的 JWT 声明 → exchange 响应 → access token 的 JWT。
  const callbackUserId = readCallbackParam(callbackUrl, TRAE_CN_USER_ID_PARAMS)?.value ?? ''
  let userId = callbackUserId.length > 0 ? callbackUserId : readTraeCnJwtUserId(refresh.value)

  // 次要路径：回调直接给了 access token 时无需再 exchange。
  // **必须通过 JWT 形态校验**：名字叫 token/accessToken 的参数完全可能是别的
  // 东西（如 CSRF 串），误当 access token 会静默存下坏凭据 —— 见候选表说明。
  const directCandidate = readCallbackParam(callbackUrl, TRAE_CN_ACCESS_TOKEN_PARAMS)?.value ?? ''
  const directAccess = looksLikeTraeCnJwt(directCandidate) ? directCandidate : ''
  let accessToken = directAccess
  let refreshToken = refresh.value
  let nickname = ''
  if (accessToken.length === 0) {
    const payload = await exchangeTraeCnToken(
      { refreshToken: refresh.value, userId }, product, fetcher, signal,
    )
    accessToken = payload.accessToken
    if (payload.refreshToken.length > 0) refreshToken = payload.refreshToken
    if (userId.length === 0) {
      userId = payload.userId.length > 0 ? payload.userId : readTraeCnJwtUserId(accessToken)
    }
    nickname = payload.nickname
    if (device === undefined && payload.deviceId.length > 0) {
      // exchange 响应里带了设备号：比 machine_id 兜底更接近真实来源。
      return buildTraeCnCredential({
        accessToken,
        refreshToken,
        userId,
        clientId: product.clientId,
        deviceId: payload.deviceId,
        deviceIdSource: 'aha',
        machineId: session.machineId,
        nickname,
      })
    }
  }
  if (nickname.length === 0) nickname = readTraeCnJwtNickname(accessToken)
  // access token 的 JWT 是 userId 的**最后一级**来源：直连路径（回调已给
  // access token）没有 exchange 响应可读，而 user_id 是 ExchangeToken 的
  // 必填字段 —— 这里漏掉会让凭据首次续期就因缺 user_id 判终态。
  if (userId.length === 0) userId = readTraeCnJwtUserId(accessToken)
  return buildTraeCnCredential({
    accessToken,
    refreshToken,
    userId,
    clientId: product.clientId,
    deviceId,
    deviceIdSource,
    machineId: session.machineId,
    nickname,
  })
}

/**
 * 组装可持久化的凭据。
 *
 * `expires_at` 由 access token 的 JWT `exp` 派生（Trae 的 access token 是 JWT，
 * `exp` 是权威过期时刻）；解析不出时留空 —— `traeCnCredentialExpiresAtMs`
 * 会在读取时再试一次，仍失败则「不判定过期」。
 */
export function buildTraeCnCredential(input: {
  accessToken: string
  refreshToken: string
  userId: string
  clientId: string
  deviceId: string
  deviceIdSource: TraeCnDeviceIdSource
  machineId: string
  nickname?: string
}): TraeCnCredential {
  const expiresAt = jwtExpiresAtMs(input.accessToken)
  return {
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    user_id: input.userId,
    client_id: input.clientId,
    device_id: input.deviceId,
    machine_id: input.machineId,
    device_id_source: input.deviceIdSource,
    expires_at: expiresAt === undefined ? '' : String(expiresAt),
    nickname: input.nickname ?? '',
  }
}

/** 把凭据包成一次登录流程的结果。 */
function toLoginFlowResult(credential: TraeCnCredential, loginUrl: string): TraeCnLoginFlowResult {
  return {
    access: serializeTraeCnCredential(credential),
    // 与另外两条协议线一致：无法解析过期时间时报告 0 而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因为展示层的缺失而登录失败。
    expires: traeCnCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isTraeCnRefreshable(credential),
  }
}

/** 默认的平台浏览器打开器（延迟 import 以复用 CodeArts 的既有实现）。 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./login.js')
  openBrowser(url)
}

/**
 * 准备一次登录（两段式的第一段）：起本地回调服务器，返回登录 URL 与结算句柄。
 *
 * **不打开浏览器、不等待用户**：调用方应立即把 `session.loginUrl` 交给客户端
 * 弹窗，之后再用 {@link TraeCnPendingLogin.awaitCredential} 等凭据落盘。
 *
 * ## 并发策略：provider 级互斥（已有会话时拒绝，不新建、不复用）
 *
 * 已有未结算会话时返回 `{ok:false, error:'login-in-progress'}`：
 * - **不复用旧会话**：复用会让一份凭据结果被多个占位 accountId 共享，
 *   账号池里出现指向同一凭据的重复候选；
 * - **不静默新建**：每次点击都起监听会让端口堆积到超时。
 *
 * 超时、成功、失败、{@link TraeCnPendingLogin.cancel} 都会释放会话。
 */
export async function prepareTraeCnLogin(
  options: TraeCnLoginPrepareOptions,
): Promise<TraeCnLoginPrepareOutcome> {
  if (activeLoginSlot !== undefined) {
    return {
      ok: false,
      error: 'login-in-progress',
      message: '已有 Trae CN 登录进行中，请先在浏览器完成或关闭该登录窗口',
    }
  }
  // 同步占位：本函数后面还有 await（listen），不在此刻占住的话并发调用会同时通过上面的判空。
  activeLoginSlot = 'preparing'

  const fetcher = options.fetcher ?? fetch
  const { product } = options
  const machineId = generateTraeCnHex32()
  const deviceIdHex = generateTraeCnHex32()

  let resolveResult!: (value: TraeCnLoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const credential = new Promise<TraeCnLoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 这个 Promise 是手工创建的、要过一会儿才被消费者 await，而回调处理器可能在
  // 「构造完成」与「被 await」之间就把它 reject 掉（典型：回调极快，或 exchange
  // 立刻失败）。那一段窗口里 Node 会把它视为**未处理的拒绝**并触发
  // PromiseRejectionHandledWarning / vitest 的 unhandled error。
  // 先挂一个空处理器把「已处理」标记打上；不影响后续消费者 —— 它们仍拿到同一拒绝原因。
  credential.catch(() => {})

  let serverClosed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  /** 关闭回调服务器并停掉超时计时器（幂等）。 */
  const closeServer = async (): Promise<void> => {
    if (serverClosed) return
    serverClosed = true
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const server = createServer((request, response) => {
    const localPort = request.socket.localPort ?? 0
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${localPort}`)
    // T5 诊断：**每条**回调先记一份脱敏形态（保留全部参数名），再判分支。
    // 这样即便参数名与候选表不符，日志里也有据可查，而不是只有一个 404。
    options.onCallbackDebug?.(
      `[trae-cn] 登录回调 ${request.method ?? 'GET'} ${redactTraeCnCallbackUrl(url.toString())}`,
    )
    if (!url.pathname.startsWith(TRAE_CN_CALLBACK_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    // 结果里的 loginUrl 用**回调请求实际落到的端口**现算，而不是捕获外层变量：
    // 回调服务器端口是在 `listen` 之后才知道的，先声明后赋值会让这个闭包
    // 引用一个尚未初始化的 const。
    const loginUrl = buildTraeCnLoginUrl(localPort, product, machineId, deviceIdHex)
    void completeTraeCnCallback(url, { machineId }, product, fetcher, options.signal)
      .then((credentialValue) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
        resolveResult(toLoginFlowResult(credentialValue, loginUrl))
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录换取凭据失败')
        rejectResult(error)
      })
  })

  let port: number
  try {
    port = await listenOnRandomPort(server)
  } catch (error) {
    // 起监听失败：必须把同步占下的槽位还回去，否则此后所有登录都会被
    // `login-in-progress` 永久挡住。
    if (activeLoginSlot === 'preparing') activeLoginSlot = undefined
    throw error
  }
  const loginUrl = buildTraeCnLoginUrl(port, product, machineId, deviceIdHex)

  // 超时覆盖「用户操作 + exchange」整个窗口；从「会话建立」起算。
  const timeoutMs = options.timeoutMs ?? TRAE_CN_LOGIN_TIMEOUT_MS
  timeoutTimer = setTimeout(() => {
    rejectResult(new Error(`Trae CN 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timeoutTimer.unref?.()

  const loginSession: TraeCnPendingLogin = {
    port,
    loginUrl,
    awaitCredential: () => credential,
    cancel: (reason = 'Trae CN 登录已取消') => {
      rejectResult(new Error(reason))
    },
  }
  // 用真实句柄替换占位，保持互斥连续（中间没有释放窗口）。
  activeLoginSlot = loginSession
  // 结算即释放会话：成功、失败、超时、取消都汇聚到这一条路径上。
  void credential.then(releaseSession, releaseSession)

  function releaseSession(): void {
    if (activeLoginSlot === loginSession) activeLoginSlot = undefined
    void closeServer()
  }

  return { ok: true, session: loginSession }
}

/**
 * 运行完整登录流程：起本地回调服务器 → 打开 portal → 等回调 → 换 access token。
 *
 * 单进程内闭环，不落状态文件。现已成为 {@link prepareTraeCnLogin} 的便捷封装，
 * 供「阻塞式」调用方使用（`TraeCnAuth.login()`、e2e 探针）；Account Hub 走的是
 * 两段式（prepare → 客户端弹窗 → awaitCredential），不经过这里。
 */
export async function runTraeCnLoginFlow(
  options: TraeCnLoginFlowOptions & { product: TraeCnProduct },
): Promise<TraeCnLoginFlowResult> {
  const open: OpenBrowser = options.openBrowser ?? defaultOpenBrowser
  const outcome = await prepareTraeCnLogin(options)
  if (!outcome.ok) throw new Error(outcome.message)
  const loginSession = outcome.session
  try {
    await open(loginSession.loginUrl)
  } catch (error) {
    // 打开失败时不能把会话留在原地（会一直占用端口到超时）。
    loginSession.cancel(`打开 Trae CN 登录页失败：${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
  return loginSession.awaitCredential()
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器，返回实际端口。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：回调只可能来自本机浏览器，
 * 不对外暴露监听面。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('Trae CN 登录回调服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}
