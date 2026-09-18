/**
 * Trae CN **Work**（`work.trae.cn`）LLM 适配器。
 *
 * ## 与 `TraeCnAdapter`（IDE 路径）的关系：**协议完全不同，但共用账号池**
 *
 * 骨架与 IDE 路径同构（凭据解析 → 换号循环 → 流消费），但**每一个协议动作
 * 都重写**：Work 是**三段式有状态会话**，而 IDE 是**单次无状态 POST**。
 *
 * | 项 | IDE 路径 | Work 路径（本文件） |
 * |---|---|---|
 * | 请求 | 一次 `POST /api/ide/v1/chat` | 建会话 → 发消息 → 订阅 SSE（**三次调用**） |
 * | 鉴权头 | 鉴权三头 + **IDE 网关全套** | **仅鉴权三头**（无 x-app-id 等） |
 * | 模型池 | 16 项静态表（远端拿不到） | **12 项，远端可拉**（本文件已接线） |
 * | 扣费池 | 通用积分（`available_endpoint=0`） | **Work 专属（`available_endpoint=1`）** |
 * | 会话清理 | 无状态，无需清理 | **每轮必须 DELETE**（见下） |
 * | 错误判据 | 业务码（已标定） | 状态码为主（Work 码表未标定） |
 *
 * ## 会话生命周期（本适配器的核心结构差异）
 *
 * 每次 `stream()` 调用 = **建会话 → 发消息 → 订阅 → 收完 → 删会话**，
 * 删除在 `finally` 里，失败**仅告警不抛**：
 *
 * ```
 * const sid = await createSession()
 * try { ...发消息 + 消费 SSE... }
 * finally { await deleteSession(sid) }   // 失败只 console.warn
 * ```
 *
 * 为什么**必须**删：
 * 1. Work 的会话在云端会拉起**沙箱**（真机 `platform_timing.sandbox_name`
 *    形如 `run-agent-<sid>-xxxx`），不删就是持续占资源；
 * 2. 会话会出现在用户的 TraeWork 会话列表里 —— 每问一句就往用户列表里塞一条
 *    「hi」是很糟的副作用；
 * 3. 删除已验证有效（真机 `DELETE` → `{"code":0,"message":"success"}`）。
 *
 * 为什么删除**失败不抛**：用户要的是回复，会话残留是**副作用**而非本次请求的
 * 失败原因。把清理失败变成用户可见的错误，会让一次成功的对话因收尾问题报错。
 *
 * ## 为什么不用持久会话复用（性能取舍）
 *
 * 复用会话能省一次建/删往返，但会引入**状态耦合**：DSH 的每次 `stream()` 是
 * 独立的（可能并发、可能来自不同会话/分支），共享一个云端 session 会让
 * 「哪条 DSH 会话对应哪个云端会话」变成需要维护的映射，且一轮失败后该会话的
 * 脏状态会污染后续请求。**每轮新建**把这个复杂度归零，代价是两次额外往返
 * （真机建会话 ~0.3s、删会话 ~0.2s，相对 3–13s 的生成时间可忽略）。
 *
 * ## 换号循环接住两条失败路径
 *
 * 与 IDE 路径同因：Work 的限流/额度失败可能落在 HTTP 200 的流内
 * （`error` 帧），而这类失败**可以换号重试**。故循环同时覆盖：
 * - **HTTP 失败**（建会话/发消息/订阅的非 200）——按状态码分类；
 * - **流内业务错误**（`error` 帧）——按业务码分类（码表未标定，见
 *   `trae-cn-work-errors.ts`）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool } from './account-pool.js'
import { isTraeCnExpired, traeCnAccessHeaders } from './trae-cn-oauth.js'
import type { TraeCnCredential } from './trae-cn-oauth.js'
import {
  TRAE_CN_WORK,
  TRAE_CN_WORK_AGENT_ID,
  TRAE_CN_WORK_AGENT_TYPE,
  TRAE_CN_WORK_FALLBACK_MODELS,
  TRAE_CN_WORK_MODEL_SELECTION_STRATEGY,
  TRAE_CN_WORK_MODELS_PATH,
  TRAE_CN_WORK_ORIGIN,
  TRAE_CN_WORK_SESSION_MODE,
  TRAE_CN_WORK_SESSIONS_PATH,
} from './trae-cn-work-product.js'
import type { TraeCnWorkFallbackModel, TraeCnWorkProduct } from './trae-cn-work-product.js'
import {
  classifyTraeCnWorkError,
  recordsTraeCnWorkCooldown,
  shouldSwitchTraeCnWorkAccount,
} from './trae-cn-work-errors.js'
import type { TraeCnWorkErrorAction } from './trae-cn-work-errors.js'
import {
  consumeTraeCnWorkStream,
  normalizeTraeCnWorkModelName,
  serializeTraeCnWorkQuery,
  traeCnWorkErrorCodeForAction,
} from './trae-cn-work-sse.js'
import type { TraeCnWorkStreamOutcome } from './trae-cn-work-sse.js'

/** 本适配器注册的 provider 路由名（等价于 `TRAE_CN_WORK.id`）。 */
export const PROVIDER = 'trae-cn-work'

/**
 * 单次请求最多换几个账号（含首次）。
 *
 * 与 IDE 路径同值（3）。Work 每轮要建/删会话，换号成本比 IDE 路径高，
 * 故同样不宜逐个试完。
 */
const TRAE_CN_WORK_MAX_ROTATE = 3

/** 限流/额度类冷却时长（毫秒，1 小时）。 */
const TRAE_CN_WORK_COOLDOWN_MS = 3_600_000

/** 远端模型条目（`GET /api/remote/v1/models` 的一项）。 */
export interface TraeCnWorkRemoteModel {
  id: string
  name: string
  supportsImages?: boolean
  contextWindow?: number
  consumptionRate?: number
}

/** 安全读取 Error.message。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 从错误体提取可读 detail 文本。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const parts = [
      typeof data.code === 'number' || typeof data.code === 'string' ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.msg === 'string' ? data.msg : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body
}

/** 将 HTTP 状态码映射为 harness 错误码（仅用于**无业务码**的兜底路径）。 */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** 把分类动作映射为**无账号池 / 池已试遍时**抛出的错误码。 */
function actionErrorCode(action: TraeCnWorkErrorAction, status: number): string {
  if (action === 'backoff') return 'RATE_LIMIT'
  if (action === 'switch-account') return httpErrorCode(status === 200 ? 429 : status)
  return httpErrorCode(status)
}

/** 判断是否为传输级错误（可重试的 TRANSPORT）。 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首帧与两次 chunk 之间的最大静默，均可用环境变量覆盖
 * （便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取** ——
 * 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 真机观测：首帧（`status_changed`）在 ~0ms 到达，正文首帧在 3.5s 左右。
 * 默认窗口比 IDE 路径宽（180s vs 120s）：Work 的 SOLO agent 会先起沙箱，
 * 实测 `platform_timing` 显示容器就绪阶段可以吃满数秒到数十秒。
 */
function resolveFirstFrameTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_CN_WORK_SSE_FIRST_FRAME_TIMEOUT_MS ?? '', 10) || 180_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_CN_WORK_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 180_000
}

/** `TraeCnWorkAdapter` 的构造选项。 */
export interface TraeCnWorkAdapterOptions {
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
   * 供多账号池跳过「对该模型仍有限流/额度标记」的账号。
   */
  resolveCredential: (model?: string) => Promise<TraeCnCredential | undefined>
  /**
   * 静默续期凭据。
   *
   * `model` 与 {@link TraeCnWorkAdapterOptions.resolveCredential} 同源。
   * **必须用同一个 model 选号**：`refresh` 是「按账号池选号再续期该账号」，
   * 若口径不同就会出现「解析到 B、却刷新了 A」—— B 的过期 token 永不更新，
   * 用户看到「刚登录好却一直认证失败」而日志全绿。
   */
  refresh: (model?: string) => Promise<void>
  /** 动态拉取远端模型列表；失败或未注入时回退 {@link TRAE_CN_WORK_FALLBACK_MODELS}。 */
  fetchRemoteModels?: () => Promise<TraeCnWorkRemoteModel[]>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 `TRAE_CN_WORK`。 */
  product?: TraeCnWorkProduct
}

/** Trae CN Work 模型适配器。使用 `Cloud-IDE-JWT` 鉴权，三段式有状态会话。 */
export class TraeCnWorkAdapter extends LlmAdapter {
  private readonly product: TraeCnWorkProduct
  private readonly fetchImpl: typeof fetch
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: TraeCnWorkRemoteModel[] | undefined
  /** 静态兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, TraeCnWorkFallbackModel>

  constructor(private readonly options: TraeCnWorkAdapterOptions) {
    super()
    this.product = options.product ?? TRAE_CN_WORK
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(TRAE_CN_WORK_FALLBACK_MODELS.map((model) => [model.id, model]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页会用
   * 该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。一旦
   * provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，避免
   * `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 懒加载远端模型目录（仅拉取一次）。
   *
   * `listModels` 与 `resolveModel` 共用：`resolveModel` 可能先于 `listModels` 被调用
   * （如直接从历史会话进入），此时同样需要触发一次拉取。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined || this.options.fetchRemoteModels === undefined) return
    try {
      const models = await this.options.fetchRemoteModels()
      if (models.length > 0) this.remoteModels = models
    } catch {
      // 远端不可用：回退兜底目录（由 staticFallbackModels 提供）。
    }
  }

  /** 静态模型目录（字段与远端条目同源，切换不产生口径差）。 */
  private staticFallbackModels(): readonly TraeCnWorkRemoteModel[] {
    return TRAE_CN_WORK_FALLBACK_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      supportsImages: model.supportsImages,
      contextWindow: model.contextWindow,
      consumptionRate: model.consumptionRate,
    }))
  }

  /**
   * 模型接受的输入模态。
   *
   * 真机目录逐项标了 `multimodal`：**8/12 项支持图片**。远端若接通且未带该能力
   * 字段，则**保守判为纯文本** —— 目录里没有的能力不该被假定存在。
   *
   * ⚠️ 与 IDE 路径同款**有意的不一致**：目录照实报模型的图片能力，而
   * `stream()` 仍拒绝图片输入（本适配器的图片通路未实测）。DSH 会在路由层按
   * `inputModalities` 把图片投影成文本占位，故正常调用到不了那道防线。
   */
  private inputModalitiesFor(supportsImages: boolean | undefined): readonly ['text'] | readonly ['text', 'image'] {
    return supportsImages === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.staticFallbackModels()
    // 用户在 Account Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    //
    // ⚠️ 黑名单按**本 provider 的 id**（`trae-cn-work`）查，不是账号池键
    // （`trae-cn`）—— 两个 provider 的模型池完全不重合，共用一个黑名单会让
    // 关闭 IDE 的某个模型连带影响 Work 路径。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // provider 描述挂在**模型条目**上：`LlmProviderInfo` 与
      // `LlmConfigurableProvider` 都**没有** description 字段（实测该副本的类型定义），
      // `LlmModelInfo.description` 是唯一能承载「这个 provider 走另一条协议、
      // 扣另一个池」这句话的位置。
      description: this.product.description,
      inputModalities: this.inputModalitiesFor(model.supportsImages),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const remote = this.remoteModels?.find((entry) => entry.id === model)
    const entry = this.fallbackIndex.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: remote?.name ?? entry?.name ?? model,
      // 模态与 `listModels` **同源同口径**：两处都读同一条目，否则选择器显示
      // 「支持图片」而请求路径按纯文本处理（或反之），是自相矛盾。
      inputModalities: this.inputModalitiesFor(remote?.supportsImages ?? entry?.supportsImages),
    }
    // 上下文窗口：取真机目录的 **dev 档**（见 TraeCnWorkFallbackModel）。
    const contextWindow = remote?.contextWindow ?? entry?.contextWindow
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // 思考档：**v1 刻意不声明**。真机目录里只有 `Doubao-Seed-Code` 一项带
    // `reasoning_effort_config`，且其内容是 `{support_thinking:false, options:null,
    // default_level:""}` —— 即**明确不支持思考**。其余 11 项连该字段都没有。
    // 故这里不声明 `reasoning`（DSH 的模型选择器显示「当前模型未提供推理等级」，
    // 那是诚实的）。若将来实测出 Work 的档位配置，在此补 `reasoning` 即可。
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本基类尚未
   * 提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` / `TraeCnAdapter` 同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片：目录里 8/12 项标了多模态，但**本适配器的图片通路未实测**
    // （`serializeTraeCnWorkQuery` 只把图片展平成 `[图片]` 占位）。
    // 故这里明确报错而不是静默丢弃 —— 静默丢弃会让用户以为模型看到了图片。
    for (const message of options.messages) {
      if (!Array.isArray(message.content)) continue
      const hasImage = message.content.some((block) =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
      if (hasImage) throw new LlmError('trae-cn-work: 当前 provider 不支持图片输入', 'UNSUPPORTED_CONTENT')
    }

    // 1. 获取凭据（过期则先静默续期）
    // 传 options.model：让账号池在**发请求之前**就跳过对该模型已记为限流/额度耗尽的
    // 账号（否则每次请求都要先白跑一遍这些账号再换号）。
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isTraeCnExpired(credential)) {
      await this.options.refresh(options.model)
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('trae-cn-work: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 记录当前账号（限流时可切换）。
    //
    // ⚠️ 池查询一律用 `product.poolProviderId`（= `trae-cn`），**不是** `product.id`：
    // 账号条目的 provider 字段是 `trae-cn`（Work 与 IDE 共用同一批账号），
    // 按 `trae-cn-work` 过滤一个都匹配不到。
    let currentAccountId = ''
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.poolProviderId, credential.access_token,
        )
        if (currentAccountId === '') {
          console.warn('[trae-cn-work] 当前凭据未匹配到账号池条目，限流记录将被跳过')
        }
      } catch (error) {
        console.warn('[trae-cn-work] 账号匹配失败（不影响本次请求）:', error)
      }
    }

    await this.ensureRemoteModels()
    const query = serializeTraeCnWorkQuery(options.messages, options.system)

    /**
     * 已试过的账号 id。
     *
     * 换号时必须传给池：失败类别为 5xx / 请求错误时**不写冷却标记**，
     * 刚失败的账号仍是池里排序第一，不排除就会拿回同一个账号、命中 `tried.has`
     * 而立即中断 —— 换号形同虚设。
     */
    const tried = new Set<string>()
    let accountId = currentAccountId
    if (accountId !== '') tried.add(accountId)

    /** 最后一次失败的成组状态（message / action / status / 业务码必须同源）。 */
    let lastMessage = ''
    let lastAction: TraeCnWorkErrorAction = 'fail'
    let lastStatus = 0
    let lastSseCode: string | undefined

    // 3. 换号循环。
    //
    // ⚠️ **上限减 1**：首个账号在循环外已经试过一次；不减的话总请求数会变成
    // 1 + MaxRotate，比设计值多一次。
    const maxRotate = TRAE_CN_WORK_MAX_ROTATE - 1
    for (let round = 0; ; round++) {
      // 每次尝试 = 一次完整的「建会话 → 发消息 → 订阅 → 删会话」。
      const attempt = await this.attemptOnce(credential, options, query)
      lastStatus = attempt.status

      // 会话清理**覆盖整次尝试**，不只是成功路径。
      //
      // ⚠️ 这里的 try/finally 是本适配器最容易写错的一处：建会话成功而
      // **后续任一步失败**（发消息 4xx/5xx、订阅失败、换号前的中断）时，
      // 会话已经在云端建起来了 —— 只在成功分支里删会让这些会话**全部泄漏**，
      // 在用户的 TraeWork 列表里堆出成片空会话，并让云端沙箱挂着。
      //
      // 因此 `finally` 挂在「拿到 attempt 之后」而不是「流消费之后」：
      // 只要 `sessionId` 非空就删（建会话就失败时它是空串，`deleteSession`
      // 自己会跳过）。
      try {
        if (attempt.failure === undefined) {
          // 消费流：chunk **实时透传**，同时记录是否已有产出。
          const cell: ConsumeCell = { yielded: false }
          for await (const chunk of this.consumeInto(attempt.response!, options, cell)) {
            cell.yielded = true
            yield chunk
          }
          const outcome = cell.outcome!

          if (outcome.sseError === undefined && outcome.produced) {
            // 成功收尾。
            //
            // Work 不产出工具调用块（它是自带沙箱的 agent 端点，不接受外部
            // `tools`），故 reason 只区分 stop 与 max-tokens：未收到 `done`
            // 说明流被中途掐断，正文可能被截断，报 max-tokens 让 DSH 重试
            // （与其它 provider 同策略）。
            yield {
              type: 'finish',
              reason: outcome.done ? { kind: 'stop' } : { kind: 'max-tokens' },
            }
            return
          }

          if (outcome.sseError === undefined) {
            // 用了 `done` 帧却一个内容块都没有：报 EMPTY_RESPONSE 让 DSH 重试，
            // 而不是把一条空 assistant 消息交给用户（那会静默结束本轮）。
            // **不换号** —— 空回复不是账号问题，换个账号只会再拿到一次空回复。
            throw new LlmError(
              'trae-cn-work: 上游返回空回复（done 帧后无任何内容块）',
              'EMPTY_RESPONSE',
              { status: attempt.status },
            )
          }

          lastSseCode = outcome.sseError.code === undefined ? undefined : String(outcome.sseError.code)
          lastMessage = `trae-cn-work: ${outcome.sseError.message}`
            + (lastSseCode === undefined ? '' : ` (code=${lastSseCode})`)
          // 已经透传出内容时不再换号：换号会让用户看到「半截回答 + 完整回答」两段
          // 内容，比直接报错更糟。用 `cell.yielded`（涵盖所有已发出的 chunk，
          // 含 usage）而不是 `outcome.produced`（只涵盖正文/思考块）——
          // 只发过 usage 就失败时同样不能重来，否则用量会被重复计入。
          lastAction = cell.yielded ? 'fail' : outcome.sseError.action
        } else {
          // 三段式里任一步的 HTTP 失败（建会话 / 发消息 / 订阅）。
          lastAction = classifyTraeCnWorkError({ httpStatus: attempt.status })
          lastMessage = `trae-cn-work: ${attempt.failure}`
          lastSseCode = undefined
        }
      } finally {
        await this.deleteSession(credential, attempt.sessionId)
      }

      // **先记冷却，再决定是否换号**（顺序不能颠倒：`recordCooldown` 只对
      // **换号类**的码写标记，而 `accountId` 在下面会被推进到下一个账号）。
      await this.recordCooldown(accountId, options.model, lastSseCode)

      if (!this.options.accountPool) break
      if (!shouldSwitchTraeCnWorkAccount(lastAction)) break
      if (round >= maxRotate) break

      const next = await this.options.accountPool.getAvailableAccount(
        this.product.poolProviderId, options.model, tried,
      )
      if (!next || tried.has(next.entry.id)) break
      tried.add(next.entry.id)
      accountId = next.entry.id
      credential = next.credential as TraeCnCredential
    }

    // 4. 试遍候选（或本就没有池、或已产出过内容不能再换号）：抛出**最后一次**的
    // 真实原因，不吞诊断信息。
    if (lastSseCode !== undefined) {
      throw new LlmError(lastMessage, traeCnWorkErrorCodeForAction(lastAction))
    }
    throw new LlmError(lastMessage, actionErrorCode(lastAction, lastStatus), { status: lastStatus })
  }

  /**
   * 执行一次完整尝试：建会话 → 发消息 → 订阅 SSE。
   *
   * 返回的 `sessionId` **只要建成功就一定有值**，调用方必须在 `finally` 里
   * 拿它去删（即使后续步骤失败）—— 否则建起来的会话会泄漏。
   *
   * 任一步非 200 即返回 `failure`，不抛异常：让换号循环统一处理
   * （抛异常会让「换号」与「直接失败」两条路径分裂成两套代码）。
   */
  private async attemptOnce(
    credential: TraeCnCredential,
    options: GenerateOptions,
    query: string,
  ): Promise<AttemptResult> {
    const base = this.product.apiBase
    const headers = this.headers(credential, 'application/json')

    // ── 第 1 段：建会话 ──
    let createResponse: Response
    try {
      createResponse = await this.fetchImpl(`${base}${TRAE_CN_WORK_SESSIONS_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: TRAE_CN_WORK_SESSION_MODE }),
        signal: options.signal,
      })
    } catch (error) {
      throw this.transportError(error, options, 'create session')
    }
    if (!createResponse.ok) {
      const text = await createResponse.text().catch(() => '')
      return { sessionId: '', status: createResponse.status, failure: `create session failed: ${errorDetail(text) || `HTTP ${createResponse.status}`}`, response: undefined }
    }
    const created = await createResponse.json().catch(() => undefined) as
      { data?: { chat_session_id?: unknown } } | undefined
    const sessionId = typeof created?.data?.chat_session_id === 'string' ? created.data.chat_session_id : ''
    if (sessionId.length === 0) {
      return { sessionId: '', status: createResponse.status, failure: 'create session returned no chat_session_id', response: undefined }
    }

    // ── 第 2 段：发消息 ──
    //
    // body 字段**逐字**取自官方 `buildSendMessageRequest`（真机实测请求体）：
    // `query` 是 **JSON 字符串**（不是数组！），元素形态
    // `{type:"text",data:{content}}` —— 注意是 `data.content`，
    // 与 IDE 路径的 `text_content` 不同。
    let messageResponse: Response
    try {
      messageResponse = await this.fetchImpl(`${base}${TRAE_CN_WORK_SESSIONS_PATH}/${sessionId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          chat_session_id: sessionId,
          content: [],
          query,
          model_name: options.model,
          agent_type: TRAE_CN_WORK_AGENT_TYPE,
          agent_id: TRAE_CN_WORK_AGENT_ID,
          model_selection_strategy: TRAE_CN_WORK_MODEL_SELECTION_STRATEGY,
          origin: TRAE_CN_WORK_ORIGIN,
        }),
        signal: options.signal,
      })
    } catch (error) {
      throw this.transportError(error, options, 'send message')
    }
    if (!messageResponse.ok) {
      const text = await messageResponse.text().catch(() => '')
      return { sessionId, status: messageResponse.status, failure: `send message failed: ${errorDetail(text) || `HTTP ${messageResponse.status}`}`, response: undefined }
    }
    const sent = await messageResponse.json().catch(() => undefined) as
      { data?: { message_id?: unknown } } | undefined
    const messageId = typeof sent?.data?.message_id === 'string' ? sent.data.message_id : ''
    if (messageId.length === 0) {
      return { sessionId, status: messageResponse.status, failure: 'send message returned no message_id', response: undefined }
    }

    // ── 第 3 段：订阅 SSE ──
    let eventResponse: Response
    try {
      eventResponse = await this.fetchImpl(
        `${base}${TRAE_CN_WORK_SESSIONS_PATH}/${sessionId}/events?reply_to_message_id=${encodeURIComponent(messageId)}`,
        { method: 'GET', headers: this.headers(credential, 'text/event-stream'), signal: options.signal },
      )
    } catch (error) {
      throw this.transportError(error, options, 'subscribe events')
    }
    if (!eventResponse.ok) {
      const text = await eventResponse.text().catch(() => '')
      return { sessionId, status: eventResponse.status, failure: `subscribe events failed: ${errorDetail(text) || `HTTP ${eventResponse.status}`}`, response: undefined }
    }
    return { sessionId, status: eventResponse.status, failure: undefined, response: eventResponse }
  }

  /** 网络失败映射为可重试的 TRANSPORT 错误（取消时原样抛）。 */
  private transportError(error: unknown, options: GenerateOptions, stage: string): unknown {
    if (options.signal?.aborted) return error
    if (isTransportError(error)) {
      return new LlmError(
        `trae-cn-work: transport error (${stage}): ${errorMessage(error)}`,
        'TRANSPORT',
        { cause: error as Error },
      )
    }
    return error
  }

  /**
   * 删除会话（收敛云端沙箱与会话列表）。
   *
   * **失败仅告警不抛**：用户要的是回复，会话残留是副作用而非本次请求的失败原因
   * （见模块头）。取消（`signal.aborted`）时也照删 —— 用户按下停止后云端会话
   * 更该被收掉。
   *
   * `sessionId` 为空串时直接返回（建会话就失败，没有会话可删）。
   */
  private async deleteSession(
    credential: TraeCnCredential,
    sessionId: string,
  ): Promise<void> {
    if (sessionId.length === 0) return
    try {
      const response = await this.fetchImpl(`${this.product.apiBase}${TRAE_CN_WORK_SESSIONS_PATH}/${sessionId}`, {
        method: 'DELETE',
        // 取消已发生：不能再用一个已 abort 的 signal（fetch 会立刻拒绝，
        // 清理就永远发不出去）。故这里**不带 signal**，让它独立完成。
        headers: this.headers(credential, 'application/json'),
      })
      // 非 2xx 也算失败：`fetch` 只在**网络层**失败时抛，HTTP 500 是一个正常
      // resolve 的响应。不查 `ok` 会让「服务端拒绝删除」完全无声 ——
      // 而那正是会话开始堆积时最需要看到的信息。
      if (!response.ok) {
        console.warn(`[trae-cn-work] 删除会话 ${sessionId} 返回 HTTP ${response.status}（会话可能残留）`)
      }
    } catch (error) {
      console.warn(`[trae-cn-work] 删除会话 ${sessionId} 失败（不影响本次回复）:`, errorMessage(error))
    }
  }

  /**
   * 消费一次流，并把 outcome 写进调用方给的 cell。
   *
   * 为什么用 cell 而不是生成器的 `return` 值：`for await` 会**丢弃** `return` 值
   * （只保留 `break`/`throw` 语义），所以 outcome 必须走旁路。cell 由调用方分配，
   * 每次尝试一个 —— 用实例字段会在嵌套/并发调用时串号。
   */
  private async *consumeInto(
    response: Response,
    options: GenerateOptions,
    cell: ConsumeCell,
  ): AsyncGenerator<StreamChunk, void, void> {
    const inner = consumeTraeCnWorkStream(response, {
      label: 'trae-cn-work',
      httpStatus: response.status,
      timeouts: { firstFrameMs: resolveFirstFrameTimeoutMs(), chunkMs: resolveChunkTimeoutMs() },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    try {
      cell.outcome = yield* inner
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (error instanceof LlmError) throw error
      if (isTransportError(error)) {
        throw new LlmError(`trae-cn-work: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /**
   * 记录模型级冷却标记（让 Account Hub 亮出徽章）。
   *
   * ⚠️ 池查询用 `poolProviderId`（`trae-cn`）—— 与 `findAccountIdByCredential`
   * 同源，否则标记会写到不存在的 provider 命名空间下（静默失效）。
   */
  private async recordCooldown(
    accountId: string,
    model: string,
    sseErrorCode: string | undefined,
  ): Promise<void> {
    if (!this.options.accountPool || accountId === '') return
    if (!recordsTraeCnWorkCooldown(sseErrorCode)) return
    try {
      await this.options.accountPool.updateModelRateLimit(
        accountId,
        model,
        Date.now() + TRAE_CN_WORK_COOLDOWN_MS,
      )
    } catch (error) {
      console.warn('[trae-cn-work] 记录限流标记失败（不影响本次请求）:', error)
    }
  }

  /**
   * 构造请求头（**仅鉴权三头**）。
   *
   * ## 与 IDE 路径的关键差异：不带网关全套头
   *
   * 调研实测：Work 网页 RPC **不需要** cookie / `x-app-id` / 网关版本头 /
   * UA 伪装 —— 带与不带都 200。故这里保持**最简**：`traeCnAccessHeaders`
   * 给出的鉴权三头（`Authorization: Cloud-IDE-JWT` + `X-Ide-Token` +
   * `X-Cloudide-Token`）加 `Content-Type`，仅此而已。
   *
   * 刻意**不照抄** IDE 路径的 `x-device-id` / `x-os-version` 等设备头：
   * 那些是 IDE 网关的形态校验要求，Work 网页 RPC 没有该要求，
   * 多带只是把一个未经验证的假设塞进请求。
   */
  private headers(credential: TraeCnCredential, accept: string): Record<string, string> {
    return { ...traeCnAccessHeaders(credential, accept) }
  }
}

/** 一次三段式尝试的结果。 */
interface AttemptResult {
  /** 建会话成功后的会话 id（空串 = 建会话就失败了，无需清理）。 */
  sessionId: string
  /** 最近一次 HTTP 状态码。 */
  status: number
  /** 失败描述（成功时为 undefined）。 */
  failure: string | undefined
  /** 订阅成功后的 SSE 响应（失败时为 undefined）。 */
  response: Response | undefined
}

/** 一次流消费的旁路结果（`for await` 会丢弃生成器的 `return` 值，故用 cell 传递）。 */
interface ConsumeCell {
  /** 流消费完成后的结果。 */
  outcome?: TraeCnWorkStreamOutcome
  /** 是否已向外透传过 chunk（决定能否安全换号）。 */
  yielded: boolean
}

/**
 * 在 `ctx.llm` 上注册 Trae CN Work provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动，得到 `trae-cn-work` /
 * `llm-trae-cn-work`。`settingsNs` **必须**与 `src/index.ts` 的
 * `registerProviderSettings` 注册的 namespace 一致，否则模型设置页会因未注册
 * namespace 在 `refFor → deriveKeyRef(provider)` 处崩溃。
 *
 * ⚠️ 注册用的是 `product.id`（`trae-cn-work`），而**账号池**用的是
 * `product.poolProviderId`（`trae-cn`）—— 两者不可混用，详见
 * {@link TraeCnWorkProduct.poolProviderId}。
 */
export function registerTraeCnWorkLlm(ctx: Context, options: TraeCnWorkAdapterOptions): void {
  const product = options.product ?? TRAE_CN_WORK
  ctx.llm.registerConfigurableProviders([
    { provider: product.id, displayName: product.displayName, settingsNs: `llm-${product.id}`, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([product.id], new TraeCnWorkAdapter(options))
}

/**
 * 拉取远端模型目录（`GET /api/remote/v1/models`）。
 *
 * ## 与 IDE 路径相反：这个端点**真的可用**
 *
 * IDE 路径的模型目录刻意不接线（任何 HTTP 端点都拿不到新池，见
 * `TRAE_CN_MODELS_PATH` 的说明）；Work 的目录端点**真机实测 200 且回全 12 项**，
 * 故这里**已接线**，远端是权威来源，静态表只在整体失败时顶替。
 *
 * ## 响应结构（真机实测，注意分组）
 *
 * ```json
 * {"code":0,"data":{"list":[{"function":"solo_coder","models":[ ...12 项... ]}]}}
 * ```
 *
 * `list` 是**按 function 分组**的数组，模型在 `models` 里 —— 不是顶层平铺数组
 * （照抄「`data` 即数组」的猜测会一项都读不到）。
 *
 * 每项字段：`name` / `multimodal` / `is_default` / `display_name` / `is_new` /
 * `is_beta` / `icon` / `features`（**JSON 字符串**）/ `config_source` /
 * `is_preset` / `max_mode` / `context_window_tokens`（`{dev,max}`）。
 * 倍率在 `features.consumption_rate.data.rate`（故 `features` 要**再解析一次**）。
 */
export function parseTraeCnWorkModels(body: unknown): TraeCnWorkRemoteModel[] {
  const list = locateWorkModelArray(body)
  if (list === undefined) return []
  const models: TraeCnWorkRemoteModel[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = firstString(record, ['name', 'model_name', 'model_id', 'id'])
    if (id === undefined) continue
    const display = firstString(record, ['display_name', 'displayName'])
    const contextWindow = readDevContextWindow(record)
    const rate = readConsumptionRate(record)
    models.push({
      id,
      name: display ?? id,
      ...typeof record.multimodal === 'boolean' ? { supportsImages: record.multimodal } : {},
      ...contextWindow === undefined ? {} : { contextWindow },
      ...rate === undefined ? {} : { consumptionRate: rate },
    })
  }
  return models
}

/**
 * 在 `{data:{list:[{models:[...]}]}}` 里找出模型数组。
 *
 * ## 只认**实测形态**，不做形态猜测
 *
 * 真机响应逐字确认：模型嵌在 `data.list[].models` 里（`list` 按 `function`
 * 分组）。这里**刻意不做**「`data` 直接是数组」「`data.models` 是数组」这类
 * 容忍式回退 —— 那些形态**从未被观测到**，写进来只是把未验证的假设固化成代码；
 * 上游真改版时，一个**空目录**（回退到静态表，用户仍能用）比一个「猜对了形状
 * 但字段读错」的半成品目录更容易诊断。
 *
 * 全部落空返回 undefined → `parseTraeCnWorkModels` 返回空数组 → 适配器
 * 回退静态表。
 */
function locateWorkModelArray(body: unknown): readonly unknown[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const list = (data as Record<string, unknown>).list
  if (!Array.isArray(list)) return undefined
  // 分组形态（真机）：把所有分组的 models 拼起来。
  const collected: unknown[] = []
  for (const group of list) {
    if (typeof group !== 'object' || group === null) continue
    const models = (group as Record<string, unknown>).models
    if (Array.isArray(models)) collected.push(...models)
  }
  return collected.length > 0 ? collected : undefined
}

/**
 * 读取上下文窗口的 **dev 档**。
 *
 * 真机形态：`context_window_tokens: {dev: 184000, max: 184000}`。
 * 取 dev 档与 IDE 路径同口径（客户端默认实际使用的窗口）；
 * `qwen-3.6-plus` / `qwen-3.5` 的 `max` 是 0，dev 是唯一可用值。
 */
function readDevContextWindow(record: Record<string, unknown>): number | undefined {
  const holder = record.context_window_tokens
  if (typeof holder !== 'object' || holder === null) return undefined
  const dev = (holder as Record<string, unknown>).dev
  return typeof dev === 'number' && Number.isFinite(dev) && dev > 0 ? dev : undefined
}

/**
 * 读取消耗倍率。
 *
 * 路径（真机实测）：`features`（**JSON 字符串**）→ `consumption_rate.data.rate`。
 * 中间任何一层缺失都返回 undefined —— **不编造默认值 1.0**：
 * 「没读到」与「倍率就是 1」是两件事。
 */
function readConsumptionRate(record: Record<string, unknown>): number | undefined {
  const raw = record.features
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let features: unknown
  try { features = JSON.parse(raw) } catch { return undefined }
  if (typeof features !== 'object' || features === null) return undefined
  const holder = (features as Record<string, unknown>).consumption_rate
  if (typeof holder !== 'object' || holder === null) return undefined
  const data = (holder as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const rate = (data as Record<string, unknown>).rate
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : undefined
}

/** 依次尝试若干键，返回首个非空字符串（去首尾空白）。 */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 拉取 Work 模型目录（供 `src/index.ts` 注入适配器）。
 *
 * 用**同一个凭据**（`traeCnAccessHeaders`，与对话完全一致）——
 * 真机实测该端点带鉴权可 200，且不额外消耗积分。
 */
export async function fetchTraeCnWorkModels(
  credential: TraeCnCredential,
  fetchImpl: typeof fetch = fetch,
  apiBase: string = TRAE_CN_WORK.apiBase,
): Promise<TraeCnWorkRemoteModel[]> {
  const response = await fetchImpl(`${apiBase}${TRAE_CN_WORK_MODELS_PATH}`, {
    method: 'GET',
    headers: traeCnAccessHeaders(credential, 'application/json'),
  })
  if (!response.ok) throw new Error(`trae-cn-work: models HTTP ${response.status}`)
  const body = await response.json()
  return parseTraeCnWorkModels(body)
}

/** 归一模型名（供外部比对用；见 `normalizeTraeCnWorkModelName`）。 */
export { normalizeTraeCnWorkModelName }
