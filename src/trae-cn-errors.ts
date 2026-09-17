/**
 * Trae CN 上游错误分类。
 *
 * 与 `src/lobsterai-errors.ts` **平行而非复用**：两条协议线的错误码体系毫无交集
 * （LobsterAI 判 HTTP 状态码 + 英文/中文关键词，Trae CN 判 **HTTP 200 响应体里的
 * 业务码**），共用一套判定只会让两边都变得难以推理。
 *
 * ## 为什么必须按「业务码」而不是 HTTP 状态码判
 *
 * 实测（调研报告，已确认）：Trae CN 的 chat 端点在绝大多数失败下**仍返回 HTTP 200**
 * —— 错误走 SSE 的 `event:error` 帧，形如 `data:{"code":4008,"message":"..."}`。
 * 因此「按 402/429 判限流」这类在腾讯系上有效的做法在这里**完全失效**：
 * 一个 4008（限流）和一次正常回复在 HTTP 层长得一模一样。
 *
 * 本模块因此以**业务码**为第一判据；HTTP 状态码只在**拿不到业务码**时兜底
 * （网关 5xx、网络层 401/403、纯文本 429 等）。
 *
 * ## 三类动作
 *
 * | 动作 | 含义 | 由谁执行 |
 * |---|---|---|
 * | `switch-account` | 换下一个账号重试 | 适配器的换号循环 |
 * | `backoff` | **不换号**，退避后重试同一账号 | DSH 的重试层（抛可重试错误码） |
 * | `fail` | 直接报错给用户 | 适配器抛出带原始 code/message 的错误 |
 *
 * 本模块**只有纯函数**，无副作用、不发请求，故可整表穷举单测。
 */

/**
 * 分类结果。
 *
 * 刻意用字符串字面量而非数字：码值在日志与测试断言里可读性差，
 * 且 `'switch-account'` 直接就是适配器要做的动作名。
 */
export type TraeCnErrorAction =
  /** 换下一个账号重试（限流 / 账号失效 / 风控）。 */
  | 'switch-account'
  /** 不换号，退避重试（软限流 / 排队等待）。 */
  | 'backoff'
  /** 直接报错（参数错误 / 超长 / 模型不存在 / 未知码）。 */
  | 'fail'

/**
 * 换号码：限流类。
 *
 * - `4008` / `4021` / `5003`：请求频率/并发限额；
 * - `977`：服务端限流（客户端侧表现为「请求过于频繁」类）。
 *
 * 这一类换号的意义最直白：**限额是账号级的**，换一个账号就能继续。
 */
export const TRAE_CN_RATE_LIMIT_CODES: readonly number[] = [4008, 4021, 5003, 977]

/**
 * 换号码：额度/付费类（`4200`–`4203`）。
 *
 * 与上表分开是因为**冷却徽章的语义不同**（见 {@link recordsTraeCnCooldown}）：
 * 额度类需要充值/等待周期重置，与「频率限额」在 UI 上应能被区分对待。
 * 但两者在**动作**上一致 —— 都换号。
 */
export const TRAE_CN_QUOTA_CODES: readonly number[] = [4200, 4201, 4202, 4203]

/**
 * 换号码：**账号失效**（`1001` / `1002` / `4010` / `4014`）。
 *
 * 令牌被吊销、账号被踢下线、登录态失效等。用户已明确确认**与风控一样换号**
 * （对齐官方客户端的 `isSecurityError` 语义：那套逻辑把这些码统一视为
 * 「当前身份不可用」，一律切号而不是把错误抛给用户）。
 */
export const TRAE_CN_ACCOUNT_INVALID_CODES: readonly number[] = [1001, 1002, 4010, 4014]

/**
 * 换号码：**风控**（`4011` / `4013` / `4015`）。
 *
 * 与账号失效分开的原因同 {@link TRAE_CN_QUOTA_CODES}：风控通常有**时效**
 * （一段时间后自动解除），故应当记冷却徽章；账号失效只能重新登录，
 * 记一个「等待重置」的徽章是误导（见 {@link recordsTraeCnCooldown}）。
 */
export const TRAE_CN_RISK_CONTROL_CODES: readonly number[] = [4011, 4013, 4015]

/**
 * 退避码（**不换号**）。
 *
 * - `4007` / `3004` / `9074`：软限流 —— 服务端明确要求稍后重试，
 *   换号既无必要（限的是请求节奏而非账号额度），又会额外消耗其它账号的额度；
 * - `4000005`、`4050`–`4052`：**排队等待**。用户已确认按退避处理，
 *   理由见 {@link classifyTraeCnError} 的说明。
 */
export const TRAE_CN_BACKOFF_CODES: readonly number[] = [4007, 3004, 9074]

/**
 * 排队/等待码（**不换号**，按退避处理）。
 *
 * 与 {@link TRAE_CN_BACKOFF_CODES} 分开列，是因为它们的语义不同但动作相同：
 * 前者是「你请求太快」，后者是「服务端忙，你在队列里」。
 *
 * 为什么排队**不换号**：排队是**全局**状态（服务端容量问题），不是某个账号
 * 的问题 —— 换号只会把同一个排队问题再问一遍，还额外消耗另一个账号的一次
 * 往返与额度。正确处置是退避重试同一账号。
 */
export const TRAE_CN_QUEUE_CODES: readonly number[] = [4000005, 4050, 4051, 4052]

/**
 * 直报码（**不换号、不退避**）。
 *
 * - `4001`：参数错误；
 * - `4006`：请求超长（上下文超限）；
 * - `4023`：模型不存在。
 *
 * 三者都是**确定性**失败：同样的请求换任何账号都会得到同一个结果，
 * 换号与退避都只是浪费往返，必须立刻把原因交给用户/模型。
 */
export const TRAE_CN_FATAL_CODES: readonly number[] = [4001, 4006, 4023]

/** 上述四类换号码的并集（供实现处一次性判「是否换号类」）。 */
export const TRAE_CN_SWITCH_CODES: readonly number[] = [
  ...TRAE_CN_RATE_LIMIT_CODES,
  ...TRAE_CN_QUOTA_CODES,
  ...TRAE_CN_ACCOUNT_INVALID_CODES,
  ...TRAE_CN_RISK_CONTROL_CODES,
]

/**
 * 业务码的两个输入形态。
 *
 * 上游在不同帧里可能给数字（`{"code":4008}`）或字符串（`{"code":"4008"}`），
 * 客户端源码里两种都出现过，故两个都收。
 */
export type TraeCnErrorCode = number | string

/** {@link classifyTraeCnError} 的入参。 */
export interface TraeCnErrorInput {
  /**
   * HTTP 状态码。
   *
   * **几乎总是 200** —— Trae 把业务失败放在 SSE 的 `event:error` 帧里。
   * 只有网关/网络层失败才会给出非 200，届时 {@link sseErrorCode} 通常缺失，
   * 本参数就是**唯一**判据。省略视为「未知」，等价于 200。
   */
  httpStatus?: number
  /** SSE `event:error` 帧里的业务码；缺失表示这不是业务错误。 */
  sseErrorCode?: TraeCnErrorCode
}

/** 把任意形态的业务码归一化成数字；非法值返回 undefined。 */
export function normalizeTraeCnCode(code: TraeCnErrorCode | undefined): number | undefined {
  if (code === undefined) return undefined
  if (typeof code === 'number') return Number.isFinite(code) ? code : undefined
  const trimmed = code.trim()
  if (trimmed.length === 0) return undefined
  // 只接受**整串是整数**的写法：`"4008"` 是码，`"code=4008"` 之类不是，
  // 后者若被 parseInt 静默截取会把诊断文本误判成业务码。
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

/** 判定业务码是否落在某个码表里。 */
function inCodes(codes: readonly number[], code: number | undefined): boolean {
  return code !== undefined && codes.includes(code)
}

/**
 * 按「业务码 + HTTP 状态码」判定失败处置动作。
 *
 * ## 判定顺序（即优先级，不要重排）
 *
 * 1. **业务码命中换号表** → `'switch-account'`；
 * 2. **业务码命中退避表（含排队）** → `'backoff'`；
 * 3. **业务码命中直报表** → `'fail'`；
 * 4. **业务码未知（有值但不在任何表里）** → `'fail'` —— 直报并**带上原始码**。
 *    这是刻意的保守默认：未知码可能是积分耗尽（真实码 T3 尚未实测到）之类的
 *    终态，此时换号会把一个确定性的失败放大成 N 次无用请求；直报能让真机
 *    第一次遇到就把码暴露在错误文案里，一步即可校准。
 * 5. 无业务码时按 HTTP 兜底：
 *    - `401` / `403` → `'switch-account'`（凭据被拒 ⇒ 换个账号试；
 *      适配器在此之前还会先做一次静默续期）；
 *    - `429` / `408` / `5xx` → `'backoff'`（网关级限流与瞬时故障都是
 *      「稍后重试」语义，与具体账号无关）；
 *    - 其余（含 200 与非 2xx 的 4xx）→ `'fail'`。
 *
 * 为什么业务码**优先于** HTTP 状态码：状态码在这些场景里几乎恒为 200，
 * 反过来判会把所有业务失败都归成 `'fail'`，换号与退避机制整体失效。
 *
 * @param input - HTTP 状态码与业务码。
 * @returns 该次失败应执行的动作。
 */
export function classifyTraeCnError(input: TraeCnErrorInput): TraeCnErrorAction {
  const code = normalizeTraeCnCode(input.sseErrorCode)

  if (code !== undefined) {
    if (inCodes(TRAE_CN_SWITCH_CODES, code)) return 'switch-account'
    if (inCodes(TRAE_CN_BACKOFF_CODES, code) || inCodes(TRAE_CN_QUEUE_CODES, code)) return 'backoff'
    if (inCodes(TRAE_CN_FATAL_CODES, code)) return 'fail'
    // 未知码：直报（见上方第 4 条）。
    return 'fail'
  }

  const status = input.httpStatus
  if (status === undefined) return 'fail'
  if (status === 401 || status === 403) return 'switch-account'
  if (status === 429 || status === 408) return 'backoff'
  if (status >= 500) return 'backoff'
  return 'fail'
}

/** 该动作是否应当触发「换下一个账号」（而不是退避或直接报错）。 */
export function shouldSwitchTraeCnAccount(action: TraeCnErrorAction): boolean {
  return action === 'switch-account'
}

/**
 * 该动作是否为「退避重试」（**不换号**）。
 *
 * 适配器据此抛**可重试**错误码，把节奏交还给 DSH 的重试层。
 */
export function isTraeCnBackoff(action: TraeCnErrorAction): boolean {
  return action === 'backoff'
}

/**
 * 该业务码的失败是否应**记为该模型的冷却标记**（让 Account Hub 亮出徽章）。
 *
 * 覆盖：
 * - 限流码（{@link TRAE_CN_RATE_LIMIT_CODES}）—— 等一会儿就好；
 * - 额度码（{@link TRAE_CN_QUOTA_CODES}）—— 等周期重置或充值；
 * - 风控码（{@link TRAE_CN_RISK_CONTROL_CODES}）—— 通常有时效，会自动解除。
 *
 * **刻意不覆盖账号失效码**（{@link TRAE_CN_ACCOUNT_INVALID_CODES}）：
 * 那种情况唯一的解法是**重新登录**，而不是等一个重置时刻。给它记一个
 * 「该模型限流 N 分钟」的徽章是虚假信息 —— 用户会照着徽章等，等完仍然失败。
 * 这与 `lobsterai-errors.ts` 里「徽章的含义必须是这个模型受限，而不是
 * 这个账号出过错」是同一条原则。
 *
 * 无业务码的 HTTP 兜底路径（401/403/429/5xx）**一律不记**：那些是传输/网关层
 * 现象，无法归属到「某个模型」上。
 */
export function recordsTraeCnCooldown(code: TraeCnErrorCode | undefined): boolean {
  const normalized = normalizeTraeCnCode(code)
  return inCodes(TRAE_CN_RATE_LIMIT_CODES, normalized)
    || inCodes(TRAE_CN_QUOTA_CODES, normalized)
    || inCodes(TRAE_CN_RISK_CONTROL_CODES, normalized)
}
