/**
 * Trae CN **Work**（`work.trae.cn`）上游错误分类。
 *
 * ## 为什么独立于 `trae-cn-errors.ts`
 *
 * Work 与 IDE 路径**共用同一批账号与凭据**，但**错误码体系未标定**：
 *
 * | 项 | IDE 路径 | Work 路径 |
 * |---|---|---|
 * | 失败载体 | HTTP 200 的 `event:error` 帧（已实测，如 `4008`） | 同源形态，但**真机两轮全绿、一帧未遇** |
 * | 码表来源 | 官方 bundle + `ai_agent.dll` 三方互证 | **无任何实测样本** |
 *
 * 直接复用 IDE 的码表会**把未经验证的假设当成事实**：那些码（`4008` 通用池耗尽、
 * `4200`–`4203` 额度、`4011`–`4015` 风控）都来自 IDE 路径的协议线，Work 的
 * 网页 RPC 是否用同一套编号，**没有任何证据**。
 *
 * 故本模块只保留**能确证的部分**，其余一律走保守默认：
 *
 * - **HTTP 状态码**是两条路径都成立的客观事实 → 按状态码分类（401/403 换号、
 *   429/408/5xx 退避、其余直报）；
 * - **业务码**照「与 IDE 同厂商同源」的**可能性**接住两个最关键的码
 *   （见 {@link TRAE_CN_WORK_KNOWN_QUOTA_CODES}），但**未知码一律直报并带原文** ——
 *   真机第一次遇到就会把真实码暴露在错误文案里，一步即可校准。
 *
 * ## 三类动作（与 IDE 路径同语义）
 *
 * | 动作 | 含义 | 由谁执行 |
 * |---|---|---|
 * | `switch-account` | 换下一个账号重试 | 适配器的换号循环 |
 * | `backoff` | **不换号**，退避后重试同一账号 | DSH 的重试层（抛可重试错误码） |
 * | `fail` | 直接报错给用户 | 适配器抛出带原始 code/message 的错误 |
 *
 * 本模块**只有纯函数**，无副作用、不发请求，故可整表穷举单测。
 */

/** 分类结果（与 IDE 路径同字面量，便于两边对照阅读）。 */
export type TraeCnWorkErrorAction =
  /** 换下一个账号重试（限流 / 账号失效 / 额度）。 */
  | 'switch-account'
  /** 不换号，退避重试（软限流 / 排队等待）。 */
  | 'backoff'
  /** 直接报错（参数错误 / 超长 / 模型不存在 / 未知码）。 */
  | 'fail'

/** 业务码的两个输入形态（上游可能给数字或字符串）。 */
export type TraeCnWorkErrorCode = number | string

/**
 * **已知的额度类码**（换号）。
 *
 * ## 为什么只收这两个，而不是照搬 IDE 的整张额度表
 *
 * 两者都是**跨路径可确证**的：
 *
 * - `4008`：IDE 路径真机实测的**通用积分池耗尽**码。用户当前通用池已耗尽，
 *   而 Work 池有额度 —— 若 Work 侧也用这个码表示「本池耗尽」，那它同样意味着
 *   「换一个账号试」（每个账号的池是独立的）；
 * - `4200`：IDE 码表里的额度类首码，与 `4008` 语义相邻。
 *
 * ⚠️ 这两个码在 Work 路径上**尚未实测**。收进来的代价是「万一 Work 用同一个码
 * 表示别的含义，我们会多换一次号」——换号本身无害（失败会继续走循环），
 * 比「漏掉一个真实额度码导致直接报错给用户」轻。
 *
 * **刻意不收** IDE 的风控码（`4011`/`4013`/`4015`）与账号失效码
 * （`1001`/`1002`/`4010`/`4014`）：那些码的语义在 Work 侧完全未知，
 * 猜错会把「参数错误」当成「账号失效」而白换号。
 */
export const TRAE_CN_WORK_KNOWN_QUOTA_CODES: readonly number[] = [4008, 4200]

/**
 * **已知的限流类码**（换号）。
 *
 * `4021` / `5003` 是 IDE 路径的请求频率/并发限额码；`977` 是服务端限流。
 * 与 {@link TRAE_CN_WORK_KNOWN_QUOTA_CODES} 同样的取舍：收了最坏是多换一次号。
 */
export const TRAE_CN_WORK_KNOWN_RATE_LIMIT_CODES: readonly number[] = [4021, 5003, 977]

/**
 * **已知的退避类码**（**不换号**）。
 *
 * `4007` / `3004`：软限流 —— 服务端明确要求稍后重试，限的是请求节奏而非账号额度，
 * 换号既无必要又会额外消耗其它账号的额度。这条判断与账号无关，
 * 故跨路径成立。
 */
export const TRAE_CN_WORK_KNOWN_BACKOFF_CODES: readonly number[] = [4007, 3004]

/** 上述换号码的并集（供实现处一次性判「是否换号类」）。 */
export const TRAE_CN_WORK_SWITCH_CODES: readonly number[] = [
  ...TRAE_CN_WORK_KNOWN_QUOTA_CODES,
  ...TRAE_CN_WORK_KNOWN_RATE_LIMIT_CODES,
]

/** {@link classifyTraeCnWorkError} 的入参。 */
export interface TraeCnWorkErrorInput {
  /**
   * HTTP 状态码。
   *
   * Work 的业务失败**可能**仍是 200（错误走流内帧），故它是**兜底**判据；
   * 但它是唯一**已确证**的判据（真机三段式全链路都是标准 HTTP 语义）。
   */
  httpStatus?: number
  /** 流内 `error` 帧里的业务码；缺失表示这不是业务错误。 */
  sseErrorCode?: TraeCnWorkErrorCode
}

/** 把任意形态的业务码归一化成数字；非法值返回 undefined。 */
export function normalizeTraeCnWorkCode(code: TraeCnWorkErrorCode | undefined): number | undefined {
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
 * 2. **业务码命中退避表** → `'backoff'`；
 * 3. **业务码未知（有值但不在任何表里）** → `'fail'` —— 直报并**带上原始码**。
 *    这是刻意的保守默认（与 IDE 路径同策略，但**理由更强**）：Work 的码表
 *    本来就未标定，任何「猜一个动作」都是在用假设换风险；直报能让真机第一次
 *    遇到就把码暴露出来，一步即可校准。若猜成 `switch-account`，一个确定性
 *    失败会被放大成 N 次无用请求，且**真实码被吞掉**（用户只看到「都失败了」）。
 * 4. 无业务码时按 HTTP 兜底：
 *    - `401` / `403` → `'switch-account'`（凭据被拒 ⇒ 换个账号试；
 *      适配器在此之前还会先做一次静默续期）；
 *    - `429` / `408` / `5xx` → `'backoff'`（网关级限流与瞬时故障都是
 *      「稍后重试」语义，与具体账号无关）；
 *    - 其余（含 200 与非 2xx 的 4xx）→ `'fail'`。
 *
 * 为什么业务码**优先于** HTTP 状态码：与 IDE 路径同因 —— 状态码在这些场景里
 * 可能恒为 200，反过来判会把所有业务失败都归成 `'fail'`，换号机制整体失效。
 */
export function classifyTraeCnWorkError(input: TraeCnWorkErrorInput): TraeCnWorkErrorAction {
  const code = normalizeTraeCnWorkCode(input.sseErrorCode)

  if (code !== undefined) {
    if (inCodes(TRAE_CN_WORK_SWITCH_CODES, code)) return 'switch-account'
    if (inCodes(TRAE_CN_WORK_KNOWN_BACKOFF_CODES, code)) return 'backoff'
    // 未知码：直报（见上方第 3 条）。
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
export function shouldSwitchTraeCnWorkAccount(action: TraeCnWorkErrorAction): boolean {
  return action === 'switch-account'
}

/** 该动作是否为「退避重试」（**不换号**）。 */
export function isTraeCnWorkBackoff(action: TraeCnWorkErrorAction): boolean {
  return action === 'backoff'
}

/**
 * 该业务码的失败是否应**记为该模型的冷却标记**（让 Account Hub 亮出徽章）。
 *
 * 只覆盖**额度与限流**两类 —— 它们有明确的「等待重置」语义，
 * 徽章文案（「该模型限流至 …」）是诚实的。
 *
 * 退避码（{@link TRAE_CN_WORK_KNOWN_BACKOFF_CODES}）**刻意不记**：
 * 退避的语义是「不换号、稍后重试同一个账号」，给它记上标记会让
 * `getAvailableAccount` 在下次选号时跳过该账号 —— 那就等于偷偷换号，
 * 与「退避不换号」的决策自相矛盾。
 *
 * 无业务码的 HTTP 兜底路径（401/403/429/5xx）**一律不记**：那些是传输/网关层
 * 现象，无法归属到「某个模型」上。
 */
export function recordsTraeCnWorkCooldown(code: TraeCnWorkErrorCode | undefined): boolean {
  const normalized = normalizeTraeCnWorkCode(code)
  return inCodes(TRAE_CN_WORK_SWITCH_CODES, normalized)
}
