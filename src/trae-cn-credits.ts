/**
 * Trae CN（字节跳动 Trae 国内版）每日签到与积分余额。
 *
 * 与 `src/credits.ts`（CodeBuddy 版）/ `src/lobsterai-credits.ts` **刻意分开**：
 * 三条协议没有一处共用（端点、信封、鉴权头、幂等判据全不同），硬合并只会让
 * 某一个文件出现大量 `if (provider === …)` 分支。但**复用 `credits.ts` 的类型**，
 * 让 `computeClaimSummary`、`collectCreditsStatus` / `collectClaimResults` /
 * `collectCreditBalances` 三个收集器与前端的结果摘要 UI 都不必各写一份 ——
 * Trae 只需注入自己的下钻函数（见 `src/jet-hub-rpc.ts` 的三处分发），
 * 唯一的类型改动是补上显式类型参数（因为 Trae 的凭据不是 `BuddyCredential`）。
 *
 * ## 协议（调研实测）
 *
 * ```
 * 状态  POST {apiBase}/trae/api/v2/ug/checkin_credits/status   body {"req_source":1}
 * 领取  POST {apiBase}/trae/api/v2/ug/checkin_credits/claim    body {"req_source":1}
 * 余额  POST {apiBase}/trae/api/v2/pay/web_user_ent_usage      body {"require_usage":true}
 * ```
 *
 * 鉴权是 `Cloud-IDE-JWT <access>`（另带两个等值 token 头，见
 * `traeCnAccessHeaders`）+ `Origin` / `Referer` = 登录门户。
 *
 * ## 三条本协议独有的约束
 *
 * 1. **必须带设备头**：`x-device-id`（凭据里的 `device_id`，即登录 exchange
 *    返回的 `BoundDeviceID`）+ `x-device-type` / `x-os-version` / `x-app-version`。
 *    ⚠️ **T9 已校准**（2026-09-18 真机）：status / claim **都不校验设备号形态**
 *    —— 16 位十进制号、`BoundDeviceID`、空串全返回 `code:0`；完全不带设备头时
 *    `did_checked_in:false`（设备级语义的佐证）。故照常取凭据值，**不**拿
 *    `machine_id` 折算假设备号。**这是 Trae 与另外两条线最大的形态差异** ——
 *    腾讯系与 LobsterAI 都不需要设备四件套。
 * 2. **签到判定以 body `code:0` 为准，不看 HTTP 状态**（对齐 CodeBuddy 既有约定）。
 *    `code:1001` + `enable:false` 是「凭据失效」，按需要重新登录处理。
 *    **余额端点例外**：`web_user_ent_usage` 的响应**没有 code 信封**（T7 已校准），
 *    按结构特征判成功 —— 详见 {@link ResponseEnvelope}。
 * 3. **幂等判据是 `checked_in`（账号级当日）**，而**不是** `did_checked_in`
 *    ——后者是**设备级**语义：同一账号换一台设备仍为 false，拿它判幂等会
 *    对已经领过的账号重复发领取请求。
 *
 * ## 与 `lobsterai-credits.ts` 的签名差异（刻意）
 *
 * LobsterAI 版用 positional `fetcher` 形参；本模块改用
 * {@link TraeCnCreditsOptions} 选项包，因为**本协议有三处字段名待校准**
 * （领取积分字段、礼包数组位置、礼包余额字段），需要一个**脱敏调试出口**
 * （`onDebug`，只输出字段名不输出值）供真机一次性收敛。为了一个可选的调试
 * 出口而把 `fetcher` 挤成第三、调试挤成第四个位置参数，会让所有调用点都
 * 出现 `undefined` 占位洞，可读性更差。
 *
 * ⚠️ **未接线项**：`onDebug` 目前只在 RPC 分发处接到 `ctx.logger.info`，
 * 由宿主日志承接；它**不**经 RPC 回传给客户端（协议里没有这个字段）。
 * 故真机校准时看宿主日志，而不是看 Account Hub 面板。
 */

import {
  TRAE_CN_REQUEST_TIMEOUT_MS,
  type TraeCnProduct,
} from './trae-cn-product.js'
import {
  traeCnAccessHeaders,
  type TraeCnCredential,
} from './trae-cn-oauth.js'
import type {
  CheckinStatus,
  ClaimOutcome,
  CreditBalance,
  CreditPackage,
} from './credits.js'

// ── 端点与请求体常量 ──

/** 签到状态查询端点（权威状态源）。 */
export const TRAE_CN_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
/** 签到领取端点。 */
export const TRAE_CN_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'
/**
 * 积分余额端点。
 *
 * **刻意不用** `ug/activity/info` 的活动口径：实测那个接口写「200 work 积分」
 * 而实际到账 150 通用积分，是**口径陷阱**（见 README「Trae CN provider」）。
 * 余额只能以本端点的资源包明细为准。
 */
export const TRAE_CN_USER_ENT_USAGE_PATH = '/trae/api/v2/pay/web_user_ent_usage'

/**
 * 两个签到端点的请求体字段。
 *
 * ⚠️ **T1 已校准**（2026-09-18 真机）：`req_source` 带与不带，服务端返回
 * **逐字节相同**，它不是 `code:9004` 的成因。保留 `req_source: 1` 是因为
 * 它是唯一被实测成功过的组合，且带一个多余字段的成本是零。
 */
export const TRAE_CN_CHECKIN_REQ_SOURCE = 1

/** 设备头中的客户端形态（**伪装**，与运行环境无关，非 Windows 上也照发）。 */
export const TRAE_CN_DEVICE_TYPE = 'windows'

/**
 * 设备头中的操作系统版本。
 *
 * 调研报告把构建号记成了 `Windows 10.0.xxxxx`（脱敏形态），
 * 故这里填一个真实存在的 Windows 构建号。它必须**形态合法**（`Windows 10.0.\d+`）
 * 而非留 `xxxxx` 字面量 —— 后者一定过不了校验。T9 校准（2026-09-18）确认
 * **设备号形态不被校验**，但 `x-os-version` 仍照实测值发；真机若在 claim 处
 * 拿到 9004，按本机 Trae 客户端实际发送的值替换即可（`x-os-version` 在系统 API 上可取）。
 */
export const TRAE_CN_OS_VERSION = 'Windows 10.0.22631'

/** 设备头中的客户端版本（调研实测值）。 */
export const TRAE_CN_APP_VERSION = '3.3.100'

// ── 业务码 ──

/** 成功码（签到判定以 body code 为准，不看 HTTP 状态）。 */
export const TRAE_CN_CODE_OK = 0
/**
 * 凭据失效码。
 *
 * 实测：**不带 auth 时服务端不返回 401，而是 HTTP 200 + `code:1001` +
 * `enable:false`** —— 这正是「必须按业务码判」的实证。
 */
export const TRAE_CN_CODE_CREDENTIAL_INVALID = 1001
/**
 * 设备校验失败码（缺少**设备头本身**时返回；T9 校准确认设备**号形态**不校验）。
 *
 * 本模块**总是**带设备四件套，因此真机遇到它只可能是「服务端不认可我们构造的
 * 设备身份」（例如 {@link TRAE_CN_OS_VERSION} 的构建号形态不对）。故错误文案
 * 必须把这件事说清楚，而不是笼统报「领取失败」。
 */
export const TRAE_CN_CODE_DEVICE_REJECTED = 9004

/** 传输层失败（网络异常 / 响应无法解析 / 信封与预期不符）的统一码。 */
const CODE_TRANSPORT_FAILED = -1

// ── 积分池 ──

/** 通用积分池（`available_endpoint === 0`）—— chat 实际扣的就是它。 */
export const TRAE_CN_POOL_UNIVERSAL = 0
/** Work 积分池（`available_endpoint === 1`）—— 与通用池**不可合并展示**。 */
export const TRAE_CN_POOL_WORK = 1

/**
 * 积分池展示名。
 *
 * 两个池**必须分开显示**（如「通用 154.22 / Work 2000」）：
 * chat 只扣通用池，合并成一个数会让用户以为 Work 那部分可以用来对话，
 * 从而对「明明显示还有 2000 却说余额不足」感到莫名其妙。
 */
export function traeCnPoolName(endpoint: number): string {
  if (endpoint === TRAE_CN_POOL_UNIVERSAL) return '通用积分'
  if (endpoint === TRAE_CN_POOL_WORK) return 'Work 积分'
  return `端点 ${endpoint}`
}

/**
 * 定长字段的脱敏描述：**只列字段名，不带任何值**。
 *
 * 待校准项（礼包数组位置、余额字段名）只能靠真机响应的**结构**收敛，
 * 而值里可能含账号标识与金额 —— 只输出键名即可完成任务，且不泄露内容。
 */
function describeKeys(record: Record<string, unknown>): string {
  const keys = Object.keys(record)
  return keys.length === 0 ? '(空对象)' : keys.join(',')
}

// ── 请求 ──

/** 本模块三个函数共用的请求选项。 */
export interface TraeCnCreditsOptions {
  /** 注入的 fetch（测试用）；默认全局 fetch。 */
  fetcher?: typeof fetch
  /**
   * 脱敏调试出口（**只输出字段名与结构判定，不输出值**）。
   *
   * 用途是在真机校准时一次性看清「礼包数组在哪、余额字段叫什么、领取积分字段
   * 叫什么」。生产接线把它接到 `ctx.logger.info`（见 `src/jet-hub-rpc.ts` 的
   * 三处分发）；它**不**回传客户端，故校准看宿主日志。
   */
  onDebug?: (message: string) => void
}

/** 一次请求的解析结果（与 `credits.ts` 的 `PostResult` 同构，另带业务码）。 */
type CreditsCallResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: number; message: string }

/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析'

/** 读取带 Trae 鉴权与设备四件套的请求头。 */
export function traeCnCreditsHeaders(
  credential: TraeCnCredential,
  product: TraeCnProduct,
): Record<string, string> {
  return {
    // 三个等值 token 头（Authorization: Cloud-IDE-JWT + X-Ide-Token + X-Cloudide-Token）
    // 由 oauth 模块统一构造：签到与对话走同一份鉴权形态，不在这里另写一遍。
    ...traeCnAccessHeaders(credential),
    // Origin/Referer 取编译期常量 portalBase，**不从凭据推断**（对齐 X-Domain 那条约定）。
    Origin: product.portalBase,
    Referer: product.portalBase,
    // 设备四件套：claim 严格校验，缺了回 9004。
    'x-device-id': credential.device_id,
    'x-device-type': TRAE_CN_DEVICE_TYPE,
    'x-os-version': TRAE_CN_OS_VERSION,
    'x-app-version': TRAE_CN_APP_VERSION,
  }
}

/** 从 JSON 安全读取业务码（兼容数字与整数字符串两种形态）。 */
function readCode(source: Record<string, unknown>): number | undefined {
  for (const key of ['code', 'Code']) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    // `"1001"` 是码；`"code=1001"` 之类不是，后者被 parseInt 静默截取会把诊断文本误判成业务码。
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  }
  return undefined
}

/**
 * 从 JSON 读取服务端说明文案（`msg` / `message` / 大写变体）。
 *
 * ⚠️ 这里读的是**服务端文案**，用于失败原因透出。**不用于**判定成功与否 ——
 * 判定只认 `code`。
 */
function readServerMessage(source: Record<string, unknown>): string {
  for (const key of ['msg', 'message', 'Msg', 'Message']) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** 取响应体里的数据层：优先 `data`，缺失时回退到根对象。 */
function dataLayer(body: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['data', 'Data']) {
    const value = body[key]
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return body
}

/**
 * 响应信封形态。
 *
 * - `code`：**业务码信封**（签到 status / claim）。判定全部依据 body 的 `code`，
 *   缺失即失败 —— 信封与预期不符时「当作成功」会把一次失败的领取报成
 *   「已领取」，比报失败更糟。
 * - `trae-pay`：`web_user_ent_usage` 的**无 code 信封**。真机实测（2026-09-18）
 *   该端点响应顶层是 `{"is_credits_billing":…,"usage_summary":{…},
 *   "user_entitlement_pack_list":[…]}`，**根本没有 `code` 字段** —— 沿用
 *   `code` 信封会让余额**恒失败**（实测表现为「响应缺少 code 字段」）。
 *   故本形态按「结构特征存在即成功」，同时保留「若真的解析出 `code` 且非 0，
 *   仍按业务码报错」的通道（对齐「业务失败在 HTTP 200」的协议，
 *   `code:1001` 的凭据失效翻译因此不丢）。
 */
type ResponseEnvelope = 'code' | 'trae-pay'

/** `trae-pay` 信封的结构特征字段：任一存在即认定响应形态正确。 */
const TRAE_PAY_ENVELOPE_MARKERS: readonly string[] = [
  'user_entitlement_pack_list', 'usage_summary',
]

/** `trae-pay` 信封的响应体是否具备已实测的结构特征。 */
function hasTraePayEnvelope(record: Record<string, unknown>): boolean {
  return TRAE_PAY_ENVELOPE_MARKERS.some((key) => key in record)
}

/**
 * 发起一次 POST 并解析业务码。
 *
 * 判定的全部依据是 **body 的 `code`**，`response.ok` 一概不看：实测无 auth 时
 * 服务端返回的是 HTTP 200 + `code:1001`，按状态码判会把它当成成功。
 *
 * `code` **缺失**时按 `envelope` 分派（见 {@link ResponseEnvelope}）：
 * 签到端点判失败，余额端点按结构特征判成功。
 */
async function postJson(
  path: string,
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions,
  body: string,
  envelope: ResponseEnvelope = 'code',
): Promise<CreditsCallResult> {
  const fetcher = options.fetcher ?? fetch
  let parsed: unknown
  try {
    const response = await fetcher(`${product.apiBase}${path}`, {
      method: 'POST',
      headers: traeCnCreditsHeaders(credential, product),
      body,
      signal: AbortSignal.timeout(TRAE_CN_REQUEST_TIMEOUT_MS),
    })
    parsed = await response.json() as unknown
  } catch (error) {
    // 保留原始错误消息（含 timeout / socket hang up），不吞掉诊断信息。
    return {
      ok: false,
      code: CODE_TRANSPORT_FAILED,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: CODE_TRANSPORT_FAILED, message: UNPARSABLE_RESPONSE_MESSAGE }
  }
  const record = parsed as Record<string, unknown>
  const code = readCode(record)
  if (code === undefined) {
    if (envelope === 'trae-pay') {
      // 无 code 信封：结构特征在即成功（真机校准，2026-09-18）。
      if (hasTraePayEnvelope(record)) return { ok: true, body: record }
      options.onDebug?.(
        `[trae-cn] ${path} 响应既无 code 也无余额信封特征字段，字段名: ${describeKeys(record)}`,
      )
      return { ok: false, code: CODE_TRANSPORT_FAILED, message: UNPARSABLE_RESPONSE_MESSAGE }
    }
    options.onDebug?.(`[trae-cn] ${path} 响应缺少 code 字段，字段名: ${describeKeys(record)}`)
    return { ok: false, code: CODE_TRANSPORT_FAILED, message: '响应缺少 code 字段' }
  }
  if (code !== TRAE_CN_CODE_OK) {
    const serverMessage = readServerMessage(record)
    return {
      ok: false,
      code,
      message: serverMessage.length > 0 ? serverMessage : `服务端返回 code=${code}`,
    }
  }
  return { ok: true, body: record }
}

/** 把业务码翻译成用户可读的失败说明（凭据失效与设备被拒各有专门文案）。 */
function describeFailureCode(code: number, message: string): string {
  if (code === TRAE_CN_CODE_CREDENTIAL_INVALID) return '凭据已失效，请重新登录'
  if (code === TRAE_CN_CODE_DEVICE_REJECTED) {
    // 本模块总是带设备四件套 ⇒ 9004 只可能是「服务端不认可我们构造的设备身份」，
    // 而不是「忘了带设备头」。文案因此指向真正要校准的那个值。
    // （T9 已校准确认**设备号形态**不被校验，故这里不再声称形态是成因。）
    return `设备校验未通过（code ${TRAE_CN_CODE_DEVICE_REJECTED}）：`
      + 'x-device-id 取自凭据的 device_id（登录 exchange 返回的 BoundDeviceID），'
      + `x-os-version / x-app-version 为实测常量（${TRAE_CN_OS_VERSION} / ${TRAE_CN_APP_VERSION}）`
  }
  return message
}

// ── 签到状态 ──

/** 签到状态的两个**实测确认**字段。 */
export interface TraeCnCheckinState {
  /**
   * 账号级「今天是否已签到」——**幂等判据**。
   *
   * 刻意不用 `did_checked_in`：那是**设备级**语义（换设备后仍为 false），
   * 拿它判幂等会对已领取的账号重复发领取请求。
   */
  checkedIn: boolean
  /**
   * 服务端是否开启签到。
   *
   * `undefined` 表示响应里没有该字段 —— 与显式 `false` **严格区分**：
   * 只有服务端明确说关，才判「签到未开启」。
   */
  enabled: boolean | undefined
}

/** 读取布尔值：只认 `true` / `false` 两种显式形态，其余（含缺失）返回 undefined。 */
function readOptionalBool(source: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = source[key]
    if (value === true || value === false) return value
  }
  return undefined
}

/** 从任意一层读取布尔值（先数据层、再根对象），任一处显式为 true 即为 true。 */
function readBoolAnywhere(
  data: Record<string, unknown>,
  root: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return readOptionalBool(data, keys) === true || readOptionalBool(root, keys) === true
}

/** 从响应体解析签到状态。 */
function parseCheckinState(body: Record<string, unknown>): TraeCnCheckinState {
  const data = dataLayer(body)
  return {
    checkedIn: readBoolAnywhere(data, body, ['checked_in', 'checkedIn']),
    // enable 可能在数据层也可能在根上（实测的失效形态是「code:1001 + enable:false」，
    // 未记录它的层级），故两层都看。
    enabled: readOptionalBool(data, ['enable', 'enabled'])
      ?? readOptionalBool(body, ['enable', 'enabled']),
  }
}

/**
 * 查询签到状态。
 *
 * 返回 `null` 表示**查不到**（网络失败 / 信封异常 / 业务码非 0，含 `code:1001`
 * 的凭据失效），与「服务端明确说未签到」严格区分 —— 后者返回
 * `todayCheckedIn: false` 的对象。
 *
 * 映射到共用的 {@link CheckinStatus}：只有 `active` 与 `todayCheckedIn` 有
 * 实测依据，其余字段（连续天数 / 每日积分 / 活动名…）Trae 的状态响应里
 * **没有已确认的对应字段**，故一律取零值，而不是臆造一份看起来丰满的状态。
 * 这与 LobsterAI 的处理同因（那份协议同样没有这些概念）。
 */
export async function fetchTraeCnCheckinStatus(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions = {},
): Promise<CheckinStatus | null> {
  const result = await postJson(
    TRAE_CN_CHECKIN_STATUS_PATH, credential, product, options,
    JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
  )
  if (!result.ok) {
    options.onDebug?.(
      `[trae-cn] 签到状态查询失败 code=${result.code}: ${result.message}`,
    )
    return null
  }
  const state = parseCheckinState(result.body)
  return {
    // 缺失视为开启：只有服务端**显式** enable:false 才判未开启，
    // 否则一旦响应里省略该字段，UI 会把正常账号显示成「活动未开启」。
    active: state.enabled !== false,
    todayCheckedIn: state.checkedIn,
    streakDays: 0,
    dailyCredit: 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
  }
}

// ── 签到领取 ──

/**
 * 领取响应里「本次获得积分」的候选字段表。
 *
 * ⚠️ **T8 待校准**：调研报告未给出 claim 成功的响应结构。故按候选表依次尝试，
 * 全部未命中时按 0 处理并输出一条脱敏调试行（列出实际字段名），真机跑一次
 * 即可把本表收敛成唯一字段。**不发明**字段名，也不把 0 当成「服务端说 0 分」。
 */
export const TRAE_CN_CLAIM_CREDIT_FIELDS: readonly string[] = [
  'credit', 'credits', 'credits_granted', 'reward_credits', 'reward', 'amount', 'integral',
]

/** 从领取响应的数据层取本次积分；取不到返回 undefined。 */
function readClaimedCredit(data: Record<string, unknown>): number | undefined {
  for (const key of TRAE_CN_CLAIM_CREDIT_FIELDS) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/**
 * 执行每日签到领取。
 *
 * 完整两步流程（**status → 未领则 claim**），返回与 `credits.ts` 同构的
 * {@link ClaimOutcome} 判别联合 —— `computeClaimSummary` 与结果摘要 UI 无需改动。
 *
 * 判定顺序（把「业务正常状态」与「真失败」严格分开）：
 * 1. 状态查询失败 → `failed`（转述底层原因；`code:1001` 译为「凭据已失效」）；
 * 2. `checked_in` 为真 → `already-claimed`（**不发领取请求**）；
 * 3. 服务端显式 `enable:false` → `inactive`；
 * 4. 领取请求失败 → `failed`（`1001` 凭据失效 / `9004` 设备被拒各有专门文案）；
 * 5. 成功 → `claimed`。
 *
 * 幂等是**服务端**保证的（`checked_in`），本模块只在客户端做一次预检以省掉
 * 无效请求 —— 即便预检与实际状态竞态，重复领取也只会得到服务端的幂等响应。
 */
export async function claimTraeCnDailyCheckin(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions = {},
): Promise<ClaimOutcome> {
  const statusResult = await postJson(
    TRAE_CN_CHECKIN_STATUS_PATH, credential, product, options,
    JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
  )
  if (!statusResult.ok) {
    return {
      kind: 'failed',
      code: statusResult.code,
      message: statusResult.code === TRAE_CN_CODE_CREDENTIAL_INVALID
        ? describeFailureCode(statusResult.code, statusResult.message)
        : `签到状态查询失败：${statusResult.message}`,
    }
  }
  const state = parseCheckinState(statusResult.body)
  if (state.checkedIn) {
    return { kind: 'already-claimed', message: '今天已签到' }
  }
  if (state.enabled === false) {
    return { kind: 'inactive', message: '签到未开启' }
  }

  const claimResult = await postJson(
    TRAE_CN_CHECKIN_CLAIM_PATH, credential, product, options,
    JSON.stringify({ req_source: TRAE_CN_CHECKIN_REQ_SOURCE }),
  )
  if (!claimResult.ok) {
    return {
      kind: 'failed',
      code: claimResult.code,
      message: describeFailureCode(claimResult.code, claimResult.message),
    }
  }
  const data = dataLayer(claimResult.body)
  const credit = readClaimedCredit(data)
  if (credit === undefined) {
    options.onDebug?.(
      `[trae-cn] 领取成功但未命中积分字段候选表，响应字段名: ${describeKeys(data)}`,
    )
  }
  const delayed = readServerMessage(data)
  return {
    kind: 'claimed',
    credit: credit ?? 0,
    // Trae 的签到响应不含连续签到天数概念（那是 CodeBuddy 的活动机制）。
    streakDays: 0,
    isStreakDay: false,
    ...delayed.length > 0 ? { delayedMessage: delayed } : {},
  }
}

// ── 积分余额 ──

/**
 * 礼包数组所在的候选键（**T7 已按真机校准**，2026-09-18）。
 *
 * 真机 `web_user_ent_usage` 的礼包数组位于**根层**、键名
 * `user_entitlement_pack_list` —— 故它排在首位。其余候选键与「按
 * `available_endpoint` 指纹扫描」兜底一并保留：`require_usage:true` 下响应里
 * 同时有「用量」数组与「礼包」数组，只按名字猜容易猜错，只按扫描又可能命中
 * 用量数组。名字优先 + 分池指纹兜底是最稳的组合。
 */
export const TRAE_CN_BALANCE_ARRAY_KEYS: readonly string[] = [
  'user_entitlement_pack_list',
  'packages', 'gift_packages', 'gifts', 'gift_list', 'credit_packages',
  'resource_list', 'ent_list', 'entitlements', 'data_list', 'list', 'items',
]

/** 礼包「剩余额度」的候选字段（按优先级）。 */
export const TRAE_CN_BALANCE_REMAIN_FIELDS: readonly string[] = [
  'remain_amount', 'remaining_amount', 'remain', 'remaining', 'balance',
  'available_amount', 'left_amount', 'surplus_amount', 'usable_amount',
  'remain_credits', 'credits_remain', 'remain_balance',
]

/** 礼包「总额度」的候选字段（按优先级）。 */
export const TRAE_CN_BALANCE_TOTAL_FIELDS: readonly string[] = [
  'total_amount', 'total', 'amount', 'capacity', 'total_credits',
]

/** 礼包「已用额度」的候选字段（按优先级）。 */
export const TRAE_CN_BALANCE_USED_FIELDS: readonly string[] = [
  'used_amount', 'used', 'consume_amount', 'consumed_amount', 'used_credits', 'usage_amount',
]

/** 礼包名候选字段（按优先级）。 */
const BALANCE_NAME_FIELDS: readonly string[] = [
  'name', 'package_name', 'gift_name', 'product_name', 'title', 'desc',
]

/** 礼包失效时间候选字段（按优先级）。 */
const BALANCE_EXPIRE_FIELDS: readonly string[] = [
  'expire_time', 'expired_time', 'expire_at', 'end_time', 'expired_at',
]

/** `available_endpoint` 字段名候选（分池依据）。 */
const BALANCE_ENDPOINT_FIELDS: readonly string[] = [
  'available_endpoint', 'endpoint', 'resource_endpoint',
]

/** 积分池明细。 */
export interface TraeCnCreditPool {
  /** `available_endpoint` 原值：0=通用积分，1=Work 积分，其余为未知池。 */
  endpoint: number
  /** 池展示名（见 {@link traeCnPoolName}）。 */
  name: string
  /** 该池**有效**礼包余额合计（两位小数）。 */
  total: number
  /** 该池的礼包明细。 */
  packages: CreditPackage[]
}

/**
 * Trae CN 的余额结果：在共用 {@link CreditBalance} 之上**追加**双池信息。
 *
 * 追加而非改写 `total` 的语义：`total` 仍是**主数字**（通用池，chat 实际扣的
 * 就是它），另给 `workTotal` 与 `pools` 让 UI 能按「通用 154.22 / Work 2000」
 * 分开展示。**绝不把两池相加** —— 那会让用户以为 Work 的额度可以用来对话。
 */
export interface TraeCnCreditBalance extends CreditBalance {
  /** 各积分池明细（至少一项；未出现的池不会凭空补 0 项）。 */
  pools: TraeCnCreditPool[]
  /** Work 池（endpoint=1）余额；没有 Work 礼包时为 0。 */
  workTotal: number
}

/** 从对象里读第一个存在且可解析的数值；都没有返回 undefined。 */
function readFirstNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

/** 从对象里读第一个非空字符串。 */
function readFirstString(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 沿嵌套路径读取一个**普通对象**；任一层缺失或不是对象时返回 undefined。
 *
 * 真机的礼包条目把额度放在嵌套对象里（`entitlement_base_info` →
 * `product_extra` → `package_extra` → `quota`），`readFirstNumber` 那种只看
 * 顶层的读法在真机响应上**全部 miss**（表现为每个礼包余额都算 0）。
 */
function readObjectPath(
  source: Record<string, unknown>,
  path: readonly string[],
): Record<string, unknown> | undefined {
  let current: unknown = source
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined
}

/** 真机（2026-09-18）实测的额度字段名：`credits_limit` 是总额，`credits_amount` 是已用。 */
const NESTED_LIMIT_FIELD = 'credits_limit'
/** 已用额度的字段名（位于 `usage` 对象内）。 */
const NESTED_CONSUMED_FIELD = 'credits_amount'

/**
 * 定位礼包数组。
 *
 * `require_usage:true` 意味着响应里很可能**同时**有「用量」数组与「礼包」数组，
 * 故单纯的「按名字找」或「按扫描找」都会猜错。这里分三轮：
 *
 * 1. **名字命中且可信**：候选键上的数组，要么是**空数组**（服务端明确说没有
 *    礼包），要么元素里带 `available_endpoint` 分池指纹 —— 这两类直接采纳；
 * 2. **广度优先扫描**：取第一个元素带分池指纹的数组（用量数组没有这个指纹）；
 * 3. **回退**：名字命中但「非空且无指纹」的数组（可能是同名的用量列表）。
 *    只在 1、2 都无果时使用，并由调用方在调试行里报出路径与口径，便于校准。
 */
function findPackageArray(
  body: Record<string, unknown>,
): { path: string; items: unknown[]; confident: boolean } | undefined {
  const hasMarker = (items: unknown[]): boolean => items.some((item) => {
    if (typeof item !== 'object' || item === null) return false
    const record = item as Record<string, unknown>
    if (BALANCE_ENDPOINT_FIELDS.some((field) => field in record)) return true
    // 真机的分池字段**嵌在** `entitlement_base_info` 里（不在条目顶层），
    // 只看顶层会把真机礼包数组判成「无指纹」，退化成仅按键名命中的不可信路径。
    const base = readObjectPath(record, ['entitlement_base_info'])
    return base !== undefined && BALANCE_ENDPOINT_FIELDS.some((field) => field in base)
  })

  const data = dataLayer(body)
  // `dataLayer` 在没有 `data` 键时**回退到根对象** —— 此时若仍把这一层叫
  // 'data'，调试行会报出「data.user_entitlement_pack_list」这种不存在的路径，
  // 而调试行的全部价值就在于如实报出真实层级（真机校准靠它）。
  const scopes: ReadonlyArray<readonly [string, Record<string, unknown>]> = data === body
    ? [['root', body]]
    : [['data', data], ['root', body]]
  let fallback: { path: string; items: unknown[] } | undefined
  for (const [scopeName, scope] of scopes) {
    for (const key of TRAE_CN_BALANCE_ARRAY_KEYS) {
      const value = scope[key]
      if (!Array.isArray(value)) continue
      const items = value as unknown[]
      if (items.length === 0 || hasMarker(items)) {
        return { path: `${scopeName}.${key}`, items, confident: true }
      }
      fallback ??= { path: `${scopeName}.${key}`, items }
    }
  }

  // 扫描兜底：只认带分池指纹的数组。
  const queue: Array<{ path: string; value: unknown }> = [{ path: 'root', value: body }]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (typeof current.value !== 'object' || current.value === null) continue
    if (seen.has(current.value)) continue
    seen.add(current.value)
    if (Array.isArray(current.value)) {
      const items = current.value as unknown[]
      if (hasMarker(items)) return { path: current.path, items, confident: true }
      continue
    }
    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        queue.push({ path: `${current.path}.${key}`, value })
      }
    }
  }
  return fallback === undefined ? undefined : { ...fallback, confident: false }
}

/** 把数值或时间字符串解析为毫秒时间戳；无法解析返回 NaN。 */
function toTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级与毫秒级时间戳都见过程（>= 1e12 视为毫秒）。
    return value >= 1e12 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value.trim())
    if (Number.isFinite(numeric)) return numeric >= 1e12 ? numeric : numeric * 1000
    return Date.parse(value.replace(' ', 'T'))
  }
  return Number.NaN
}

/** 解析后的单条礼包。 */
interface ParsedPackage {
  endpoint: number
  pkg: CreditPackage
  /** 余额取数口径（供脱敏调试行说明「这个数是怎么来的」）。 */
  source: 'nested-limit' | 'remain-field' | 'total-minus-used' | 'total-as-remain' | 'none'
}

/**
 * 按真机口径读取礼包的额度（**T7 已按真机校准**，2026-09-18）。
 *
 * 真机响应的礼包条目把额度放在**嵌套对象**里，顶层没有任何额度字段：
 *
 * ```
 * entitlement_base_info.product_extra.package_extra.quota.credits_limit  ← 总额（主路径）
 * entitlement_base_info.quota.credits_limit                              ← 总额（回退）
 * usage.credits_amount                                                   ← 已用
 * entitlement_base_info.available_endpoint                               ← 分池
 * ```
 *
 * `usage` 真机上可能是 `{}`（该包尚未产生用量），此时已用按 0 计 ——
 * 不是「查不到」，而是「这个包一分没用过」。
 *
 * 主路径（含 `credits_limit`）命中时返回**余额 = limit − consumed**；
 * 未命中返回 undefined，由调用方走原有的候选表回退链。
 */
function readNestedQuota(record: Record<string, unknown>): {
  endpoint: number | undefined
  limit: number
  consumed: number
  total: number
} | undefined {
  const base = readObjectPath(record, ['entitlement_base_info'])
  if (base === undefined) return undefined

  const packageQuota = readObjectPath(base, ['product_extra', 'package_extra', 'quota'])
  const plainQuota = readObjectPath(base, ['quota'])
  const limit = readFirstNumber(packageQuota ?? {}, [NESTED_LIMIT_FIELD])
    ?? readFirstNumber(plainQuota ?? {}, [NESTED_LIMIT_FIELD])
  if (limit === undefined) return undefined

  // `usage` 可为 `{}` 或缺失 —— 两种都按「未产生用量」计 0。
  const consumed = readFirstNumber(readObjectPath(record, ['usage']) ?? {}, [NESTED_CONSUMED_FIELD]) ?? 0
  const endpoint = readFirstNumber(base, BALANCE_ENDPOINT_FIELDS)
  return { endpoint, limit, consumed, total: limit - consumed }
}

/** 解析一个礼包条目。 */
function parseTraeCnPackage(record: Record<string, unknown>): ParsedPackage {
  // 真机嵌套口径优先；未命中时 endpoint 才走顶层候选表。
  const nested = readNestedQuota(record)
  const endpointRaw = nested?.endpoint ?? readFirstNumber(record, BALANCE_ENDPOINT_FIELDS)
  // 缺失 available_endpoint 时归入**通用池**：chat 扣的就是通用池，
  // 且缺失数量会由调试行报出，真机校准时一眼能看到是不是猜错了。
  const endpoint = endpointRaw ?? TRAE_CN_POOL_UNIVERSAL

  const remain = readFirstNumber(record, TRAE_CN_BALANCE_REMAIN_FIELDS)
  const total = readFirstNumber(record, TRAE_CN_BALANCE_TOTAL_FIELDS)
  const used = readFirstNumber(record, TRAE_CN_BALANCE_USED_FIELDS)

  let remaining: number
  let source: ParsedPackage['source']
  let totalForDisplay: number
  if (nested !== undefined) {
    remaining = nested.total
    totalForDisplay = nested.limit
    source = 'nested-limit'
  } else if (remain !== undefined) {
    remaining = remain
    totalForDisplay = total ?? 0
    source = 'remain-field'
  } else if (total !== undefined && used !== undefined) {
    // 余额 = 总额 - 已用（调研给出的口径之一）。
    remaining = total - used
    totalForDisplay = total
    source = 'total-minus-used'
  } else if (total !== undefined) {
    // 三级回退：调研观察到 claim 后 `total_amount` 由 4500 变为 4650，形态上
    // 它就是「当前可用额」。**此时总额未知**，故 totalForDisplay 置 0
    // （UI 的 formatPackageLine 对 0 显示 '?'，不会把它伪装成 1:1）。
    remaining = total
    totalForDisplay = 0
    source = 'total-as-remain'
  } else {
    remaining = 0
    totalForDisplay = 0
    source = 'none'
  }

  // 已用额度：真机在嵌套 `usage.credits_amount`，其余形态走顶层候选表。
  const usedForDisplay = nested?.consumed ?? used
  const expireRaw = readFirstString(record, BALANCE_EXPIRE_FIELDS)
  const expireValue = BALANCE_EXPIRE_FIELDS
    .map((field) => record[field])
    .find((value) => typeof value === 'string' || typeof value === 'number')
  const expiresAt = toTimestamp(expireValue)
  const name = readFirstString(record, BALANCE_NAME_FIELDS)

  return {
    endpoint,
    source,
    pkg: {
      name: name.length > 0 ? name : '积分包',
      unit: 'credit',
      // 负数一律 clamp 到 0：服务端在计量回滚/超额扣费等异常下可能下发负值，
      // 原样透出会让卡片显示「-12.5 积分」，既无意义又误导。
      remaining: Math.max(0, remaining),
      total: Math.max(0, totalForDisplay),
      used: Math.max(0, usedForDisplay ?? 0),
      // 只按失效时间判：本协议未见 Status 字段（CodeBuddy 那套 3=已过期 不适用）。
      active: !(Number.isFinite(expiresAt) && Date.now() >= expiresAt),
      cycleStartTime: '',
      cycleEndTime: '',
      expiredTime: expireRaw,
    },
  }
}

/**
 * 查询账号积分余额（按 `available_endpoint` 分池）。
 *
 * 返回 `null` 表示**查不到**（网络 / 信封 / 业务码异常 / 找不到礼包数组），
 * 与「余额为 0」严格区分 —— 失败时 UI 应显示原因而不是 0。
 *
 * `total` = **通用池**（endpoint=0）有效礼包余额之和，是卡片的主数字；
 * Work 池（endpoint=1）走 {@link TraeCnCreditBalance.workTotal}，**不并入** total。
 */
export async function fetchTraeCnCreditBalance(
  credential: TraeCnCredential,
  product: TraeCnProduct,
  options: TraeCnCreditsOptions = {},
): Promise<TraeCnCreditBalance | null> {
  const result = await postJson(
    TRAE_CN_USER_ENT_USAGE_PATH, credential, product, options,
    JSON.stringify({ require_usage: true }),
    // 本端点**没有 code 信封**（真机校准），按结构特征判成功。
    'trae-pay',
  )
  if (!result.ok) {
    options.onDebug?.(`[trae-cn] 余额查询失败 code=${result.code}: ${result.message}`)
    return null
  }
  const found = findPackageArray(result.body)
  if (found === undefined) {
    // 拿不到礼包数组 = 查不到，**不是** 0 积分。
    options.onDebug?.(
      `[trae-cn] 余额响应里找不到礼包数组，字段名: ${describeKeys(dataLayer(result.body))}`,
    )
    return null
  }

  const parsed: ParsedPackage[] = []
  for (const item of found.items) {
    if (typeof item !== 'object' || item === null) continue
    parsed.push(parseTraeCnPackage(item as Record<string, unknown>))
  }
  const firstItem = found.items.find((item) => typeof item === 'object' && item !== null)
  options.onDebug?.(
    `[trae-cn] 余额礼包数组=${found.path}（${found.confident ? '已按分池指纹确认' : '**未确认**，仅按候选键名命中'}），`
    + `共 ${parsed.length} 项；`
    + `字段名（仅键名）: ${firstItem === undefined ? '(无条目)' : describeKeys(firstItem as Record<string, unknown>)}`,
  )
  const sources = [...new Set(parsed.map((entry) => entry.source))]
  options.onDebug?.(`[trae-cn] 余额取数口径: ${sources.length === 0 ? '(无条目)' : sources.join(' / ')}（T7 已校准：nested-limit 为主路径）`)

  const endpoints = [...new Set(parsed.map((entry) => entry.endpoint))].sort((a, b) => a - b)
  const pools: TraeCnCreditPool[] = endpoints.map((endpoint) => {
    const entries = parsed.filter((entry) => entry.endpoint === endpoint)
    const poolName = traeCnPoolName(endpoint)
    return {
      endpoint,
      name: poolName,
      total: roundCredits(entries.reduce((sum, entry) => sum + (entry.pkg.active ? entry.pkg.remaining : 0), 0)),
      packages: entries.map((entry) => ({
        ...entry.pkg,
        // 非通用池的包名前缀池名：`packages` 是两池混排的，而 UI 的 tooltip
        // 直接逐行渲染 `name` —— 不加前缀会让「2000」看起来像通用额度。
        name: endpoint === TRAE_CN_POOL_UNIVERSAL ? entry.pkg.name : `[${poolName}] ${entry.pkg.name}`,
      })),
    }
  })

  const universalTotal = pools.find((pool) => pool.endpoint === TRAE_CN_POOL_UNIVERSAL)?.total ?? 0
  const workTotal = pools.find((pool) => pool.endpoint === TRAE_CN_POOL_WORK)?.total ?? 0
  // 失效额度单独汇总（跨池），供 UI 提示「另有 N 已失效」。
  const expiredTotal = roundCredits(
    parsed.reduce((sum, entry) => sum + (entry.pkg.active ? 0 : Math.max(0, entry.pkg.remaining)), 0),
  )
  return {
    total: universalTotal,
    packages: pools.flatMap((pool) => pool.packages),
    expiredTotal,
    pools,
    workTotal,
  }
}

/**
 * 把额度规整为两位小数。
 *
 * 服务端精确值本身可能带浮点表示（如 55.67000031），多包相加会把尾数噪声
 * 显式化 —— 金额展示到分即可（与 `credits.ts` / `lobsterai-credits.ts` 同口径）。
 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}
