/**
 * Trae CN **Work**（`work.trae.cn`）SSE 流解析。
 *
 * ## 与 IDE 路径（`trae-cn-sse.ts`）的关系：**事件名无一重合**
 *
 * 两条路径都是「具名事件流」，但**事件集合完全不同**，故本模块独立实现：
 *
 * | IDE 路径（`/api/ide/v1/chat`） | Work 路径（`/api/remote/v1/.../events`） |
 * |---|---|
 * | `output` 承载正文增量 | **`plan_item`** 承载正文与思考 |
 * | `thought` 承载思考 | 思考在 `plan_item.reasoning_content` |
 * | `token_usage` / `done` / `error` | `token_usage` / `done`（同名，形态不同） |
 * | 无会话概念 | `status_changed` / `metadata` / `model_config` … |
 *
 * 可复用的只有 `src/sse.ts` 的工具函数（协议层陷阱，与厂商无关）。
 *
 * ## ⚠️ 核心形态：`plan_item` 是**累计快照**，不是增量（真机实测定案）
 *
 * 这是本模块与 IDE 路径最本质的差异，也是唯一能搞错就整段文字重复的地方。
 *
 * 真机两轮对话逐帧记录（2026-09-18）显示，同一 `plan_item.id` 的
 * `thought` 与 `reasoning_content` **每一帧都是「到目前为止的全文」**：
 *
 * ```
 * [3575ms] thought=""                                                              reason="The"
 * [3776ms] thought=""                                                              reason="The user wants me to"
 * [3968ms] thought=""                                                              reason="The user wants me to reply with exactly: alpha beta gamma delta"
 * [4108ms] thought=""                                                              reason="…alpha beta gamma delta epsilon"
 * ```
 *
 * 逐帧验证：后一帧恒为前一帧的**前缀扩展**（`startsWith` 全真）。因此
 * **不能**把每帧直接当增量拼接 —— 那会让「The user wants me to」变成
 * 「TheThe user wants me toThe user wants me to reply…」。
 *
 * 正确做法（本模块）：**按 `plan_item.id` 记录上一次的快照，只发出新增的后缀**。
 * 快照若**不是**前一次的扩展（服务端重算/回退），则按「重来」处理：
 * 记一条诊断并放弃该次差异，而不是发出一段会造成错乱文本的"差异"。
 *
 * ## 正文的两条通道（真机各出现过一次）
 *
 * 助手回复文本在真机里从**两个不同位置**出现过，本模块两条都认：
 *
 * 1. **`plan_item.thought`**（第 1 轮）：逐帧累计增长，是正文的流式通道；
 * 2. **`plan_item.tool_call_info.params.summary`**（第 2 轮，`name === "finish"`）：
 *    第 2 轮的 `thought` **全程为空**，正文只出现在 `finish` 动作的 `summary` 里。
 *
 * 只认第一条会漏掉第 2 轮那种「模型直接收尾」的回复（表现为空回复）；
 * 只认第二条则失去流式效果。故两者合流进同一个正文块，并做**去重**：
 * `summary` 通常与 `thought` 的累计结果相同（第 1 轮即如此），此时只补发
 * `thought` 尚未覆盖的后缀。
 *
 * ## 错误帧**不抛异常**，而是回填到 outcome（与 IDE 路径同因）
 *
 * Work 的限流/额度失败同样可能落在 HTTP 200 的流内，而这类失败**可以换号重试**。
 * 若解析器直接抛，调用方在已经 yield 过正文块之后就失去了「要不要换号」的判断
 * 余地。故错误进 outcome，由适配器结合「是否已有产出」决定。
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { readWithIdleTimeout } from './sse.js'
import { classifyTraeCnWorkError } from './trae-cn-work-errors.js'
import type { TraeCnWorkErrorAction, TraeCnWorkErrorCode } from './trae-cn-work-errors.js'

// ── 事件名（真机两轮对话实测，逐字）──
//
// 真机观测到的事件全集（2026-09-18，两轮对话）：
//   status_changed / platform_timing / metadata / model_config /
//   session_title_message / session_icon_message / timing_events /
//   plan_item / token_usage / done
//
// 其中只有三个对 harness 有意义：`plan_item`（正文+思考）、`token_usage`（用量）、
// `done`（终止）。其余全部忽略 —— 它们不产出 harness 的块类型，
// 且把它们的 JSON 当正文渲染会让用户看到元数据乱码。

/**
 * 正文/思考帧的事件名。
 *
 * ⚠️ **`plan_item` 是累计快照**（见模块头），不是增量。
 */
export const TRAE_CN_WORK_PLAN_ITEM_EVENT = 'plan_item'

/** 流结束帧的事件名（真机两轮均以此收尾）。 */
export const TRAE_CN_WORK_DONE_EVENT = 'done'

/** 错误帧的事件名（⚠️ 真机未观察到，形态按同厂商 IDE 路径的同类帧写）。 */
export const TRAE_CN_WORK_ERROR_EVENT = 'error'

/** 用量帧的事件名。 */
export const TRAE_CN_WORK_TOKEN_USAGE_EVENT = 'token_usage'

/** 会话状态变更帧的事件名。 */
export const TRAE_CN_WORK_STATUS_CHANGED_EVENT = 'status_changed'

/** 模型配置帧的事件名（`model_name` 带 `__dev` 后缀，见归一函数）。 */
export const TRAE_CN_WORK_MODEL_CONFIG_EVENT = 'model_config'

/**
 * 终止判据：`status_changed.new_status` 落在这些值里即视为会话结束。
 *
 * ⚠️ **真机两轮都只出现 `new_status: 3`**（会话开始），从未出现 4/5 ——
 * 两轮均以 `done` 帧正常收尾。故 4/5 是**按任务书配方保留的候选判据**，
 * 不是实测结论；本解析器把它与 `done` 并列作为「停止读取」的条件，
 * 因为若真出现终态却继续等，只会白等到空闲超时。
 */
export const TRAE_CN_WORK_TERMINAL_STATUSES: readonly number[] = [4, 5]

/**
 * 收尾动作的工具名。
 *
 * 真机第 2 轮的正文**只**出现在这个动作的 `params.summary` 里
 * （该轮 `thought` 全程为空）—— 这是正文的第二条通道，见模块头。
 */
export const TRAE_CN_WORK_FINISH_TOOL_NAME = 'finish'

/** 从 `plan_item.tool_call_info` 里取出的收尾动作载荷。 */
export interface TraeCnWorkPlanToolCall {
  /** 工具名（真机 `finish` / 空串）。 */
  name: string
  /**
   * 结构化参数（`finish` 时为 `{summary: "..."}`）。
   *
   * 显式允许 `undefined`（而不是可选属性）：本仓库开启了
   * `exactOptionalPropertyTypes`，用 `params?: X` 时构造出的
   * `{name, params: undefined}` 无法赋回该类型。
   */
  params: Record<string, unknown> | undefined
}

/**
 * 一个 `plan_item` 帧的可读形态。
 *
 * `thought` / `reasoningContent` 都是**累计快照**（见模块头），不是增量。
 */
export interface TraeCnWorkPlanItem {
  /** plan item id —— 累计快照的**去重键**（不同 id 各自独立累计）。 */
  id: string
  /** 正文累计快照（`thought` 字段）。 */
  thought: string
  /** 思考累计快照（`reasoning_content` 字段）。 */
  reasoningContent: string
  /** 收尾/工具动作载荷（无 `tool_call_info` 时为 undefined）。 */
  toolCall: TraeCnWorkPlanToolCall | undefined
  /**
   * 该 plan item 的 agent 状态（真机 `{status:"running"|"completed",run_mode:"foreground"}`）。
   *
   * 仅用于诊断；流的终止由 `done` / `status_changed` 决定，不看它 ——
   * 真机实测 `finish` 动作出现时 `status` 已是 `completed`，但流仍在继续
   * （后面还有 timing_events 与 done），拿它当终止判据会**提前掐断流**。
   */
  agentStatus: string | undefined
}

/**
 * 解析一个 `plan_item` 帧。
 *
 * 容忍式读取：字段缺失一律按空串处理，`tool_call_info` 结构异常时按 undefined。
 * 全部落空（连 `id` 都没有）时返回 undefined —— 该帧被忽略，而不是产出一个
 * 无法归因的文本块。
 */
export function parseTraeCnWorkPlanItem(payload: unknown): TraeCnWorkPlanItem | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : undefined
  if (id === undefined) return undefined

  const thought = typeof record.thought === 'string' ? record.thought : ''
  const reasoningContent = typeof record.reasoning_content === 'string' ? record.reasoning_content : ''
  const toolCall = parsePlanToolCall(record.tool_call_info)
  const agentStatus = readAgentStatus(record.agent_status)

  return {
    id,
    thought,
    reasoningContent,
    toolCall,
    agentStatus,
  }
}

/** 读取 `tool_call_info`（`{id,name,params,result,meta}`）。 */
function parsePlanToolCall(value: unknown): TraeCnWorkPlanToolCall | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  const params = typeof record.params === 'object' && record.params !== null
    ? record.params as Record<string, unknown>
    : undefined
  return { name, params }
}

/** 读取 `agent_status.status`（真机为字符串）。 */
function readAgentStatus(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const status = (value as Record<string, unknown>).status
  return typeof status === 'string' && status.length > 0 ? status : undefined
}

/**
 * 从 `finish` 动作的 `params` 里取出最终正文（`summary`）。
 *
 * 真机 `params` 形态：`{"summary":"alpha beta gamma delta epsilon"}`。
 * `summary` 之外还出现过的键（真机 `result.data.products.*` 那套）属于
 * 变更集元数据，**不是**正文，故只认 `summary`。
 *
 * 非 `finish` 动作返回空串：其它工具名（远程 agent 自己的沙箱操作）不承载
 * 用户可见的正文 —— 把它们当正文会把内部动作名渲染进回复。
 */
export function extractTraeCnWorkFinishSummary(toolCall: TraeCnWorkPlanToolCall | undefined): string {
  if (toolCall === undefined || toolCall.name !== TRAE_CN_WORK_FINISH_TOOL_NAME) return ''
  const summary = toolCall.params?.summary
  return typeof summary === 'string' ? summary : ''
}

/**
 * 从一个**累计快照**序列里算出增量。
 *
 * 返回 `undefined` 表示「无需发出」（无新增），返回 `null` 表示「快照非前缀扩展」
 * （服务端重算/回退，调用方应记诊断并放弃该次差异）。
 *
 * 这是本模块的核心纯函数：累计快照 → 增量，**可整表穷举单测**。
 */
export function diffCumulativeSnapshot(previous: string, current: string): string | undefined | null {
  if (current.length === 0) return undefined
  if (previous.length === 0) return current
  if (current === previous) return undefined
  if (current.startsWith(previous)) return current.slice(previous.length)
  // 非前缀扩展：不做「取尾巴」式的猜测（那会产出乱序文本），交由调用方处置。
  return null
}

/**
 * 从 `model_config` 帧里取模型名并**归一 `__dev` 后缀**。
 *
 * 真机实测：请求体发的是 `model_name: "Doubao-Seed-Code"`，而 `model_config`
 * 事件回的 `model_name` 是 **`"Doubao-Seed-Code__dev"`**（同帧另有
 * `config_name: "Doubao-Seed-Code"`，即请求时的名字）。
 *
 * `__dev` 是服务端内部的**配置通道标记**（dev 档上下文窗口，见真机目录的
 * `context_window_tokens.dev`），不是模型 id 的一部分。任何拿它去比对
 * `TRAE_CN_WORK_FALLBACK_MODELS` 的代码都会**一项都匹配不上**，故这里统一剥掉。
 */
export function normalizeTraeCnWorkModelName(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.endsWith('__dev') ? trimmed.slice(0, -'__dev'.length) : trimmed
}

/** 解析 `model_config` 帧，返回归一后的模型名。 */
export function parseTraeCnWorkModelConfig(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  for (const key of ['config_name', 'model_name']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return normalizeTraeCnWorkModelName(value)
    }
  }
  return undefined
}

/** 从 `status_changed` 帧取新的会话状态。 */
export function parseTraeCnWorkStatusChange(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>).new_status
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 从 `token_usage` 帧解析用量；无可用字段时返回 undefined。 */
export function parseTraeCnWorkUsage(payload: unknown): TokenUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return undefined
  }
  const input = pick('prompt_tokens', 'input_tokens')
  const output = pick('completion_tokens', 'output_tokens')
  if (input === undefined && output === undefined) return undefined
  const cached = pick('cache_read_input_tokens', 'cache_read_tokens', 'cached_tokens')
  const reasoning = pick('reasoning_tokens')
  return {
    // inputTokens 只计**未命中缓存**的部分（与其余 provider 同口径）：
    // 真机 `prompt_tokens=21125` 而 `cache_read_input_tokens=20792`，
    // 不减掉会让缓存命中率显示偏大。
    inputTokens: input === undefined ? 0 : (cached !== undefined && cached > 0 ? input - cached : input),
    outputTokens: output ?? 0,
    ...cached !== undefined && cached > 0 ? { cacheReadTokens: cached } : {},
    ...reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {},
  }
}

/** 从 `error` 帧里取出的业务错误。 */
export interface TraeCnWorkSseError {
  /** 业务码的原始形态（数字或字符串）。 */
  code: TraeCnWorkErrorCode | undefined
  /** 服务端给的可读文案。 */
  message: string
  /** 由 {@link classifyTraeCnWorkError} 判定的处置动作。 */
  action: TraeCnWorkErrorAction
}

/**
 * 解析 `error` 帧的 data。
 *
 * ⚠️ **真机未观察到该帧**（两轮对话全绿）。形态按与 IDE 路径同源的
 * `{"code":N,"message":"..."}` 写，并容忍嵌套一层的 `{"error":{...}}` ——
 * 这与 `parseTraeCnSseError` 的读取策略一致（同一厂商的同类帧）。
 * 若真机遇到不同形态，`classifyTraeCnWorkError` 的「未知码 → 直报并带原文」
 * 会让第一次遇到就把真实码暴露在错误文案里。
 */
export function parseTraeCnWorkSseError(payload: unknown, httpStatus = 200): TraeCnWorkSseError {
  if (typeof payload !== 'object' || payload === null) {
    const message = typeof payload === 'string' && payload.length > 0 ? payload : 'unknown error'
    return { code: undefined, message, action: classifyTraeCnWorkError({ httpStatus }) }
  }
  const record = payload as Record<string, unknown>
  const nested = record.error
  const source = typeof nested === 'object' && nested !== null ? nested as Record<string, unknown> : record
  const rawCode = source.code
  const code: TraeCnWorkErrorCode | undefined = typeof rawCode === 'number' || typeof rawCode === 'string'
    ? rawCode
    : undefined
  return {
    code,
    message: pickWorkMessage(source),
    action: classifyTraeCnWorkError({ httpStatus, ...code === undefined ? {} : { sseErrorCode: code } }),
  }
}

/** 依次尝试 `message` / `msg` / `error` 三个文案字段。 */
function pickWorkMessage(source: Record<string, unknown>): string {
  for (const key of ['message', 'msg']) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const nested = source.error
  if (typeof nested === 'string' && nested.length > 0) return nested
  return 'unknown error'
}

/** 一次 Work chat 请求的 SSE 消费结果（供适配器做换号与收尾判定）。 */
export interface TraeCnWorkStreamOutcome {
  /** 是否收到过 `done` 帧。未收到说明流被中途掐断。 */
  done: boolean
  /** 是否产出过任何正文或思考片段。 */
  produced: boolean
  /**
   * 会话进入的终态（`status_changed.new_status` ∈ {@link TRAE_CN_WORK_TERMINAL_STATUSES}）。
   *
   * 与 `done` 分开记录：真机两轮**都**以 `done` 收尾（从未出现 4/5），
   * 故「终态」与「正常完成」是否等价**尚未标定**。适配器据此区分
   * 「协议说了完成」与「会话结束了但没说完成」两种情况。
   */
  terminalStatus?: number
  /** 上游以 `error` 帧报错时填入（此时 `done` 为 false）。 */
  sseError?: TraeCnWorkSseError
  /**
   * 累计快照非前缀扩展的次数（诊断用）。
   *
   * 非零说明服务端重算/回退了 plan item 文本，我们**放弃**了那些差异
   * （见 {@link diffCumulativeSnapshot}）。保留计数是为了让这种形态在
   * 真机再次出现时可被观测到，而不是静默丢失。
   */
  snapshotRewinds: number
}

/** {@link consumeTraeCnWorkStream} 的入参。 */
export interface TraeCnWorkStreamOptions {
  /** harness 的取消信号。 */
  signal?: AbortSignal
  /** 上游响应的 HTTP 状态码（业务错误可能仍为 200，仅作分类兜底）。 */
  httpStatus: number
  /** 错误消息前缀（如 `trae-cn-work`）。 */
  label: string
  /** 两阶段空闲超时：等待首帧与帧间静默。 */
  timeouts: { firstFrameMs: number; chunkMs: number }
}

/** 一个 plan item 的文本累计器。 */
interface PlanItemAccumulator {
  /** 已发出的正文累计量（用于对 `thought` 与 `finish.summary` 去重）。 */
  text: string
  /** 上一次看到的思考快照。 */
  reasoning: string
}

/**
 * 逐帧翻译 Trae CN Work 的 SSE 流。
 *
 * **不产出 `finish` chunk，也不抛业务错误** —— 两者都交给调用方
 * （与 IDE 路径同设计：`finish` 的 reason 取决于「换号是否发生」，
 * 业务错误需要调用方结合「是否已有产出」决定换号还是直报）。
 *
 * 设计要点（每条对应一个真机观测或已知坑）：
 *
 * 1. **行式解析**：只处理完整的 `\n` 结尾行，残行留 buffer 等下一块；
 * 2. **`id:` 行容忍**：Work 的帧多一个 `id:` 行（IDE 路径没有）。它不是
 *    SSE 规范的标准字段，但对本解析器无意义 —— 直接忽略，不参与分发；
 * 3. **空行 = 一帧结束**并清空事件名（SSE 规范）；
 * 4. **事件名未知的 `data` 行被忽略**：把「事件行缺失」当正文会让
 *    metadata / timing 帧的 JSON 被渲染成用户可见的乱码；
 * 5. **畸形 JSON 帧跳过**：一个坏帧不该让整条会话报废；
 * 6. **`done` 帧立即停止读取**：真机 `done` 之后不再有内容帧；
 * 7. **终态立即停止读取**：见 {@link TRAE_CN_WORK_TERMINAL_STATUSES}。
 */
export async function* consumeTraeCnWorkStream(
  response: Response,
  options: TraeCnWorkStreamOptions,
): AsyncGenerator<StreamChunk, TraeCnWorkStreamOutcome, void> {
  const { label, timeouts, signal } = options
  if (!response.body) throw new LlmError(`${label}: empty model response body`, 'EMPTY_RESPONSE')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstFrameReceived = false

  let eventName = ''
  let textIndex: number | undefined
  let thoughtIndex: number | undefined
  let nextIndex = 0
  let text = ''
  let thought = ''
  let produced = false
  let done = false
  let terminalStatus: number | undefined
  let sseError: TraeCnWorkSseError | undefined
  let snapshotRewinds = 0
  /** 按 plan item id 分别累计（不同 id 各自独立，不可共用一个游标）。 */
  const accumulators = new Map<string, PlanItemAccumulator>()

  /** 确保正文块已开启，返回其 index。 */
  function* ensureTextBlock(): Generator<StreamChunk, number, void> {
    if (textIndex === undefined) {
      textIndex = nextIndex++
      yield { type: 'block-start', index: textIndex, blockType: 'text' }
    }
    return textIndex
  }

  /** 确保思考块已开启，返回其 index。 */
  function* ensureThoughtBlock(): Generator<StreamChunk, number, void> {
    if (thoughtIndex === undefined) {
      thoughtIndex = nextIndex++
      yield { type: 'block-start', index: thoughtIndex, blockType: 'reasoning' }
    }
    return thoughtIndex
  }

  try {
    while (!done && sseError === undefined && terminalStatus === undefined) {
      const timeoutMs = firstFrameReceived ? timeouts.chunkMs : timeouts.firstFrameMs
      const phase = firstFrameReceived ? 'chunk' : 'first-token'
      const result = await readWithIdleTimeout(reader, timeoutMs, label, signal, phase)
      if (result.done) break
      firstFrameReceived = true
      buffer += decoder.decode(result.value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)

        if (line.length === 0) {
          // 空行 = 一帧结束，事件名按 SSE 规范清除。
          eventName = ''
          continue
        }
        if (line.startsWith(':')) continue // 注释行（心跳）
        // Work 的帧带 `id:` 行（IDE 路径没有）；对本解析器无意义，忽略。
        if (line.startsWith('id:')) continue
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload.length === 0) continue

        // ── 终止类帧 ──
        if (eventName === TRAE_CN_WORK_DONE_EVENT) {
          done = true
          break
        }
        if (eventName === TRAE_CN_WORK_STATUS_CHANGED_EVENT) {
          let status: unknown
          try { status = JSON.parse(payload) } catch { continue }
          const next = parseTraeCnWorkStatusChange(status)
          if (next !== undefined && TRAE_CN_WORK_TERMINAL_STATUSES.includes(next)) {
            terminalStatus = next
            break
          }
          continue
        }
        if (eventName === TRAE_CN_WORK_ERROR_EVENT) {
          let parsed: unknown = payload
          try { parsed = JSON.parse(payload) } catch { /* 非 JSON：把原文当文案 */ }
          sseError = parseTraeCnWorkSseError(parsed, options.httpStatus)
          break
        }

        // ── 用量帧 ──
        if (eventName === TRAE_CN_WORK_TOKEN_USAGE_EVENT) {
          let usage: unknown
          try { usage = JSON.parse(payload) } catch { continue }
          const parsed = parseTraeCnWorkUsage(usage)
          if (parsed !== undefined) yield { type: 'usage', usage: parsed }
          continue
        }

        // ── 模型帧（仅用于诊断，不产出块）──
        if (eventName === TRAE_CN_WORK_MODEL_CONFIG_EVENT) continue

        // ── 正文/思考帧 ──
        if (eventName !== TRAE_CN_WORK_PLAN_ITEM_EVENT) continue
        let data: unknown
        try { data = JSON.parse(payload) } catch { continue }
        const item = parseTraeCnWorkPlanItem(data)
        if (item === undefined) continue

        let acc = accumulators.get(item.id)
        if (acc === undefined) {
          acc = { text: '', reasoning: '' }
          accumulators.set(item.id, acc)
        }

        // 思考：累计快照 → 增量。
        const reasoningDelta = diffCumulativeSnapshot(acc.reasoning, item.reasoningContent)
        if (reasoningDelta === null) {
          snapshotRewinds++
        } else if (reasoningDelta !== undefined) {
          acc.reasoning = item.reasoningContent
          const index = yield* ensureThoughtBlock()
          produced = true
          thought += reasoningDelta
          yield { type: 'reasoning-delta', index, text: reasoningDelta }
        } else if (item.reasoningContent.length > 0) {
          // 无新增：保持游标（内容相同，快照即当前值）。
          acc.reasoning = item.reasoningContent
        }

        // 正文通道 1：`thought` 累计快照。
        const textDelta = diffCumulativeSnapshot(acc.text, item.thought)
        if (textDelta === null) {
          snapshotRewinds++
        } else if (textDelta !== undefined) {
          acc.text = item.thought
          const index = yield* ensureTextBlock()
          produced = true
          text += textDelta
          yield { type: 'text-delta', index, text: textDelta }
        }

        // 正文通道 2：`finish` 动作的 `summary`。
        //
        // 去重规则：只补发 `thought` 尚未覆盖的后缀。真机第 1 轮里
        // `summary` 与 `thought` 的最终累计**完全相同** → 补发空串（不发）；
        // 第 2 轮 `thought` 全程为空 → 补发整个 summary。两条通道因此合流成
        // 一段连续文本，不会重复。
        const summary = extractTraeCnWorkFinishSummary(item.toolCall)
        if (summary.length > 0 && summary.length > acc.text.length && summary.startsWith(acc.text)) {
          const remainder = summary.slice(acc.text.length)
          acc.text = summary
          const index = yield* ensureTextBlock()
          produced = true
          text += remainder
          yield { type: 'text-delta', index, text: remainder }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // 收尾：按创建顺序闭合已开启的块（harness 要求 block-end 携带拼装结果）。
  if (textIndex !== undefined) {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
  }
  if (thoughtIndex !== undefined && thought.length > 0) {
    yield { type: 'block-end', index: thoughtIndex, block: { type: 'reasoning', text: thought } }
  }
  return {
    done,
    produced,
    ...terminalStatus === undefined ? {} : { terminalStatus },
    ...sseError === undefined ? {} : { sseError },
    snapshotRewinds,
  }
}

/** 一个待写入 `query` 的文本段。 */
export interface TraeCnWorkQuerySegment {
  type: 'text'
  data: { content: string }
}

/**
 * 把 harness 消息序列化为 Work 请求体的 `query`（**JSON 字符串**）。
 *
 * ## 为什么是「扁平化全文」而不是消息数组
 *
 * Work 的 `POST .../messages` 请求体**没有** `messages` 字段 —— 它只有单个
 * `query`（真机请求体逐字确认）。会话历史由**服务端按 session 保存**，
 * 而本适配器每轮 `stream()` 都新建会话并在收尾时删除（见模块头的会话生命周期），
 * 故历史**必须由我们带进 query**，否则模型每轮都从零开始（表现为「忘了上文」）。
 *
 * 序列化形态：把历史逐条按 `角色: 内容` 展平，最后一条用户消息作为当前提问。
 * 这不是 Work 官方前端的做法（它靠持久会话），而是本适配器「一次性会话」模型下
 * 唯一能保留上下文的办法。代价是历史 token 每轮重发 —— 在 DSH 的会话里
 * 上下文窗口由 `resolveModel().context` 约束，压缩由 DSH 负责。
 *
 * ## 多模态
 *
 * v1 **只发文本**：图片块被展平成占位文字（`[图片]`）。适配器的 `stream()`
 * 在更早一层就拒绝图片输入（与 IDE 路径同款最后防线），故正常调用到不了这里。
 */
export function serializeTraeCnWorkQuery(
  messages: readonly { role: string; content: unknown }[],
  system?: string,
): string {
  const parts: string[] = []
  if (system !== undefined && system.length > 0) parts.push(system)
  for (const message of messages) {
    const body = contentToText(message.content)
    if (body.length === 0) continue
    parts.push(`${roleLabel(message.role)}: ${body}`)
  }
  const segments: TraeCnWorkQuerySegment[] = [{ type: 'text', data: { content: parts.join('\n\n') } }]
  return JSON.stringify(segments)
}

/** 角色标签（中文，与插件其余面向模型的文案语言一致）。 */
function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'system') return '系统'
  if (role === 'tool') return '工具'
  return role
}

/**
 * 把消息内容载荷展平为纯文本。
 *
 * 工具调用与工具结果同样被展平（`[工具调用 name]` / `[工具结果]`）：
 * Work 是**自带沙箱的 agent 端点**，不接受外部的 `tools` 数组，也不产生
 * OpenAI 形态的 `tool_calls`。把 DSH 的工具往返如实写进文本，至少让模型
 * 看得到「之前发生过什么」，而不是整段丢失。
 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    const type = record.type
    if (type === 'text') {
      const value = record.text
      if (typeof value === 'string' && value.length > 0) parts.push(value)
      continue
    }
    if (type === 'reasoning') continue // 思考不回灌给上游
    if (type === 'image') {
      // v1 只发文本；占位而不是静默丢弃，让模型知道这里原本有图。
      parts.push('[图片]')
      continue
    }
    if (type === 'tool-call') {
      parts.push(`[工具调用 ${String(record.name ?? '')} ${String(record.arguments ?? '')}]`)
      continue
    }
    if (type === 'tool-result') {
      parts.push(`[工具结果] ${contentToText(record.content)}`)
    }
  }
  return parts.join('\n')
}

/**
 * 把「流内业务错误」的分类动作映射为 harness 错误码。
 *
 * - `switch-account` / `backoff` → `'RATE_LIMIT'`：**两者都必须是可重试码**。
 *   `RATE_LIMIT` 在 DSH 的 `DEFAULT_RETRYABLE_CODES` 里，所以 `backoff` 才真的能
 *   退避重试；两者的区别由**适配器**处理（换号循环 vs 直接抛出），错误码只表达
 *   「这是可重试的限流类失败」。发明两个新码会让 DSH 的重试层认不出来。
 * - `fail` → `'INVALID_REQUEST'`。
 *
 * ⚠️ **刻意不照搬 IDE 路径的 `4006 → CONTEXT_WINDOW_EXCEEDED` 映射**：
 * Work 侧的码表**未标定**（真机两轮全绿、一帧错误都没遇到），把某个未验证的码
 * 当作「上下文超长」会让 DSH **误触发上下文压缩** —— 那会真实地改写用户的会话
 * 历史。宁可先报一个普通请求错误，等真机观测到真实码再补映射。
 */
export function traeCnWorkErrorCodeForAction(action: TraeCnWorkErrorAction): string {
  if (action === 'switch-account' || action === 'backoff') return 'RATE_LIMIT'
  return 'INVALID_REQUEST'
}
