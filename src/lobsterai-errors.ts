/**
 * LobsterAI 上游错误分类。
 *
 * 移植自 `lobsterai2api/internal/upstream/classify.go`（Go）的 `Classify()`：
 * 把 HTTP 状态码 + 响应体文本判定成有限几类，供上层决定「该换号还是该报错」。
 *
 * ## 与 Go 版的**关键分歧**：只移植「分类」，不移植「冷却状态机」
 *
 * Go 的 `internal/pool` 会在分类之后自动执行
 * `Cooldown(CoolHard, 12h)` / `Disable(uid)` —— 表现为账号被**静默停用**，
 * 用户只能从 `/status` 的一个 `reason` 字段里看到原因。
 *
 * 本插件刻意不这样做：账号池只有 `modelRateLimits`（模型级重置时间）与
 * 用户手工的 `enabled` 开关，Jet Hub 面板上有具体的限流徽章与「重测 / 重置」
 * 按钮。设计哲学是「如实展示 + 用户可主动验证」（见 `src/account-probe.ts`
 * 模块头注释），把自动禁用搬进来会与这套 UI 语义冲突。
 *
 * 因此本模块**只有纯函数**，无副作用；`hard-credit` 的识别尤其重要 ——
 * 它是 LobsterAI 最主要的失败模式（免费积分用尽）。
 */

/**
 * 上游错误类别。
 *
 * 顺序与 Go 版 `ErrKind` 常量一致，但这里用字符串字面量而非数字：
 * 字号在日志与测试断言里可读性差，且本插件不做数值比较。
 */
export type LobsteraiErrorKind =
  /** 成功（HTTP < 400 且未命中任何关键词）。 */
  | 'none'
  /** 余额/积分不足 → Go 侧会做长冷却（12h）。本插件只标记限流。 */
  | 'hard-credit'
  /** 429 软限流 → Go 侧短冷却（60s）。 */
  | 'soft-rate'
  /** 会话终止：refresh_token 被拒（40100 / 40101），只能重新登录。 */
  | 'session-dead'
  /** 上游偶发 404。Go 侧短冷却且**不累计** errCount（防雪崩）。 */
  | 'not-found'
  /** 5xx 上游故障。 */
  | 'server'
  /** 其他 4xx / 业务错误。 */
  | 'client'

/**
 * 余额不足关键词（对齐 `classify.go:55-60` 的 `hardMarkers`）。
 *
 * 中英双通道是必需的：LobsterAI 是网易有道系产品，同一后端在不同场景下
 * 会返回中文或英文文案（实测两种都出现过），只匹配一种会漏判。
 *
 * 比较策略（见 {@link classifyLobsteraiError}）：英文走 `/i` 不区分大小写，
 * 中文走原文包含 —— 中文没有大小写概念，统一转小写再比也等价，
 * 但保留原文比较可避免极端情况下 `toLowerCase()` 改变字符数量的干扰。
 */
export const LOBSTERAI_HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit', 'freecreditsused', 'free credits used',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分', '积分耗尽',
]

/**
 * 会话终止标记（对齐 `classify.go:63` 的 `sessionDeadMarkers`）。
 *
 * `40100` / `40101` 是 LobsterAI 刷新被拒的业务码 —— 终态，重试无意义。
 */
export const LOBSTERAI_SESSION_DEAD_MARKERS: readonly string[] = [
  '40100', '40101', 'token rejected', 'refresh token was rejected',
]

/** HTTP 402 Payment Required：最直接的「余额不足」信号。 */
const HTTP_PAYMENT_REQUIRED = 402
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_NOT_FOUND = 404

/**
 * 按 HTTP 状态码 + 响应体判定错误类别。
 *
 * **判定顺序即优先级**（完全对齐 `classify.go:66-93`），不要重排：
 *
 * 1. `402` → hard-credit（状态码最权威）
 * 2. body 含 hard 关键词 → hard-credit
 * 3. body 含 session-dead 标记 → session-dead
 * 4. `429` → soft-rate
 * 5. `404` → not-found
 * 6. `>= 500` → server
 * 7. `>= 400` → client
 * 8. 否则 none
 *
 * 为什么 body 关键词要**排在状态码之前**（除 402）：实测上游用 400 + 中文
 * 「积分不足」表达余额耗尽，只按状态码会把这类错误误判成 `client`（可重试），
 * 于是反复重试一个永远不会成功的账号。
 *
 * 又为什么 session-dead 要排在 429/404 之前：40100/40101 可能与 4xx 同时出现，
 * 会话已死时任何「换号重试」都没意义（该账号需重新登录），
 * 必须优先识别出来。
 *
 * @param status - HTTP 状态码
 * @param body - 响应体原文（JSON 或纯文本均可，只做子串匹配）
 */
export function classifyLobsteraiError(status: number, body: string): LobsteraiErrorKind {
  if (status === HTTP_PAYMENT_REQUIRED) return 'hard-credit'

  const lower = body.toLowerCase()
  for (const marker of LOBSTERAI_HARD_CREDIT_MARKERS) {
    // 英文走小写比较，中文走原文比较（中文无大小写，lower 后仍相等，属冗余保险）。
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard-credit'
  }
  for (const marker of LOBSTERAI_SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session-dead'
  }

  if (status === HTTP_TOO_MANY_REQUESTS) return 'soft-rate'
  if (status === HTTP_NOT_FOUND) return 'not-found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

/**
 * 该类别是否应当触发「换下一个账号」（而不是直接把错误抛给用户）。
 *
 * **不含 `client`**：其他 4xx（请求体非法、模型名不存在……）是**请求本身**的
 * 问题，换个账号照样失败，换号只会白白消耗其他账号的额度。
 * Go 版对此的处理是 `NoteError` 累计 3 次才冷却 —— 本质上也是不换号，
 * 本插件没有该计数器，故直接判为「不换」。
 */
export function shouldRotateLobsteraiAccount(kind: LobsteraiErrorKind): boolean {
  return kind === 'hard-credit' || kind === 'soft-rate' || kind === 'not-found'
}

/**
 * 该类别是否属于**终态**（重试无意义，只能重新登录）。
 *
 * 用途：`LobsteraiAuth.refresh()` 据此抛 `RefreshTokenExpiredError`，
 * 让 `RefreshScheduler` 停止续期并提示重新登录；其余错误走可重试路径。
 * 这是相对 Go 版的一处改进 —— Go 只判「响应里有没有 accessToken」，
 * 把网络抖动也当成了终态。
 */
export function isLobsteraiTerminalError(kind: LobsteraiErrorKind): boolean {
  return kind === 'session-dead'
}

/**
 * 该类别是否属于**余额耗尽**（需要用户充值/等待次日签到）。
 *
 * 单独的谓词而非让调用方自己比较字符串：调用点分散在适配器、签到、
 * 账号探测三处，集中一处便于将来新增同类码时一次改全。
 */
export function isLobsteraiCreditExhausted(kind: LobsteraiErrorKind): boolean {
  return kind === 'hard-credit'
}
