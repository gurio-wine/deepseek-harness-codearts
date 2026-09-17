/**
 * Trae CN（字节跳动 Trae 国内版）LLM 适配器。
 *
 * 骨架取自 `src/lobsterai-adapter.ts`（本插件已验证的实现），但**协议差异全部重写**：
 * Trae CN 与其它四条线只在「消息结构」这一层相同（OpenAI chat-completions 的消息
 * 数组），其余没有一处能照抄 —— 最本质的是 **SSE 是具名事件流**
 * （`event:output` 而非 `data:{"choices":[...]}`），且**业务失败发生在 HTTP 200 的
 * `event:error` 帧里**。后者决定了本适配器与 lobsterai 在结构上的根本差异：
 * **换号循环必须能接住流内抛出的限流错误**，否则多账号切换在这个 provider 上
 * 等于没实现（lobsterai 的错误都在 `!response.ok` 分支里，流一旦开始就没有换号的
 * 余地）。
 *
 * ## 与其它 provider 的关键差异
 *
 * | 项 | 处理 |
 * |---|---|
 * | 鉴权 | `Cloud-IDE-JWT <access>` + 同值 `X-Ide-Token` / `X-Cloudide-Token` |
 * | `stream` | **恒为 `true`** —— chat 端点只返回 SSE |
 * | 错误判定 | **按 SSE 业务码**，不按 HTTP 状态码（几乎恒为 200），见 `src/trae-cn-errors.ts` |
 * | 端点 | `TRAE_CN_CHAT_PATH` 常量 + 候选表；**待真机校准**，见该常量的说明 |
 * | 图片 | **不支持**，`inputModalities` 恒为 `['text']`（未实测） |
 * | 思考等级 | 仅透传 `reasoning_effort`，不主动补档 |
 *
 * 可原样复用的只有 `src/sse.ts` 的工具函数（它们处理的是 harness 侧的协议层
 * 陷阱，与厂商无关）。
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
import { TRAE_CN, TRAE_CN_CHAT_PATH } from './trae-cn-product.js'
import type { TraeCnProduct } from './trae-cn-product.js'
import {
  classifyTraeCnError,
  recordsTraeCnCooldown,
  shouldSwitchTraeCnAccount,
} from './trae-cn-errors.js'
import type { TraeCnErrorAction } from './trae-cn-errors.js'
import { consumeTraeCnStream, serializeTraeCnMessages, traeCnErrorCodeForAction } from './trae-cn-sse.js'
import type { TraeCnStreamOutcome } from './trae-cn-sse.js'

/** 本适配器注册的 provider 路由名（等价于 `TRAE_CN.id`）。 */
export const PROVIDER = 'trae-cn'

/**
 * 单次请求最多换几个账号（含首次）。
 *
 * 与 lobsterai 侧取同一个值（3）：账号池很大时若逐个试完，一次用户请求会打出
 * N 个上游请求，既放大延迟也放大额度消耗。**减 1** 的缘由见 `stream()` 内注释。
 */
const TRAE_CN_MAX_ROTATE = 3

/** 限流/额度/风控类冷却时长（毫秒，1 小时）。 */
const TRAE_CN_COOLDOWN_MS = 3_600_000

/** 兜底模型目录中的一个条目。 */
export interface TraeCnFallbackModel {
  /** 模型 ID（传给 chat 请求体的 `model`）。 */
  id: string
  /** 展示名。 */
  name: string
  /**
   * 上下文窗口（**估计值，非远端权威值**）。
   *
   * ⚠️ **T8**：调研报告给出 41 个模型 id，但**未给出各自的上下文窗口**。
   * 这里统一填 `131_072`（对齐本插件其它 provider 的取值口径），并在
   * `resolveModel` 里如实标注它是估计值。真机校准前不宜声称精确。
   */
  contextWindow: number
}

/**
 * 静态兜底模型目录（**从调研报告实测的 41 项里取核心几项**）。
 *
 * 取舍说明（任务书要求「报告里说明取舍」）：
 * - 报告实测到 41 项，**全量抄录没有意义** —— 远端 `get_detail_param` 才是权威源，
 *   静态表只在远端失败时顶替（如离线、网关故障、T6 字段名猜错导致解析为空）；
 * - 这里取的是**用户最可能需要的几个家族各一项**：DeepSeek（官方直连）、
 *   GLM、Kimi、Doubao/Seed、MiniMax、Qwen。留一个家族一项而不是把 41 项抄全，
 *   是为了让「兜底表在生效」这件事**在 UI 上一眼可见**（模型选择器只有 8 项而不是
 *   41 项时，用户/排查者立刻知道远端拉取失败了）；
 * - `DeepSeek-V4-Flash-Official` / `DeepSeek-V4-Pro-Official` 是报告里明确给出的
 *   两个**确切 id**（含 `-Official` 后缀），故原样保留；其余按报告的 id 形态
 *   （`glm-5.2` / `kimi-k3` 这类小写连字符风格）取同族代表。
 */
export const TRAE_CN_FALLBACK_MODELS: readonly TraeCnFallbackModel[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash (官方)', contextWindow: 131_072 },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek V4 Pro (官方)', contextWindow: 131_072 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 131_072 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 131_072 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 131_072 },
  { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 131_072 },
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', contextWindow: 131_072 },
]

/**
 * Trae CN 远端模型条目。
 *
 * 远端 `POST /api/ide/v1/get_detail_param` 返回 41 项，除 id/展示名外还带
 * `display_contact_config.consumption_rate.data.rate`（消耗倍率）。
 *
 * **倍率刻意不塞进 `LlmModelInfo`**：DSH 的该接口只有
 * `provider` / `id` / `name` / `description` / `inputModalities` 五个字段
 * （实测见 `dsh-llm/lib/types/types.d.ts` 的 `LlmModelInfo`），没有任何放自定义
 * 元数据的位置。可行做法只有把倍率拼进 `description`，但那会污染模型选择器的
 * 展示文案（用户看到「GLM-5.2 ×1.5」这种非描述性文字），故**不塞**：倍率只在
 * 本适配器内部解析出来备用（如将来的积分预估），当前不参与任何判定。
 */
export interface TraeCnRemoteModel {
  id: string
  name: string
  /** 消耗倍率（远端提供时才有）。 */
  consumptionRate?: number
}

/**
 * 解析 `get_detail_param` 的响应。
 *
 * ⚠️ **T6 待校准**：调研报告给出了端点与「41 项」这个数量，但**未给出每个条目的
 * 确切字段名与信封层级**。这里按客户端里出现过的形态做**容忍式读取**：从若干
 * 候选键里取第一个可用的 id 与展示名，信封层级也做多形态尝试。全部落空时返回
 * 空数组 —— 调用方据此回退静态表，而不是拿到一堆 id 为空串的条目。
 * 真机一次请求即可把候选收敛成唯一形态。
 */
export function parseTraeCnModels(body: unknown): TraeCnRemoteModel[] {
  const list = locateModelArray(body)
  if (list === undefined) return []
  const models: TraeCnRemoteModel[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = firstString(record, ['model_name', 'model_id', 'modelName', 'modelId', 'name', 'id'])
    if (id === undefined) continue
    const display = firstString(record, ['display_name', 'displayName', 'model_display_name', 'config_name', 'title'])
    const rate = readConsumptionRate(record)
    models.push({
      id,
      name: display ?? id,
      ...rate === undefined ? {} : { consumptionRate: rate },
    })
  }
  return models
}

/** 在若干候选位置寻找模型数组（容忍不同信封层级）。 */
function locateModelArray(body: unknown): readonly unknown[] | undefined {
  const direct = asArray(body)
  if (direct !== undefined) return direct
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const key of ['data', 'models', 'model_list', 'modelList', 'result', 'items']) {
    const nested = record[key]
    const array = asArray(nested)
    if (array !== undefined) return array
    // 再剥一层信封（`{data:{models:[...]}}`）。
    if (typeof nested === 'object' && nested !== null) {
      const inner = nested as Record<string, unknown>
      for (const innerKey of ['models', 'model_list', 'modelList', 'list', 'items', 'data']) {
        const array2 = asArray(inner[innerKey])
        if (array2 !== undefined) return array2
      }
    }
  }
  return undefined
}

/** 严格判数组，非数组返回 undefined。 */
function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
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
 * 读取消耗倍率。
 *
 * 路径（调研实测）：`display_contact_config.consumption_rate.data.rate`。
 * 中间任何一层缺失都返回 undefined —— **不编造默认值 1.0**：「没读到」与
 * 「倍率就是 1」是两件事，前者不该被当成事实。
 */
function readConsumptionRate(record: Record<string, unknown>): number | undefined {
  const contact = record.display_contact_config ?? record.displayContactConfig
  if (typeof contact !== 'object' || contact === null) return undefined
  const holder = (contact as Record<string, unknown>).consumption_rate
    ?? (contact as Record<string, unknown>).consumptionRate
  if (typeof holder !== 'object' || holder === null) return undefined
  const data = (holder as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return undefined
  const rate = (data as Record<string, unknown>).rate
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : undefined
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

/**
 * 把分类动作映射为**无账号池 / 池已试遍时**抛出的错误码。
 *
 * 有账号池时换号循环会先跑完（见 `stream()`）。`switch-account` 在 HTTP 200
 * 的语境下（业务限流）映射为 `RATE_LIMIT`，否则按真实状态码。
 */
function actionErrorCode(action: TraeCnErrorAction, status: number): string {
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
 * 分两阶段：等待首帧的窗口与两次 chunk 之间的最大静默，均可用环境变量覆盖
 * （便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取** ——
 * 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，adapter 的
 * generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstFrameTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_CN_SSE_FIRST_FRAME_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_TRAE_CN_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** `TraeCnAdapter` 的构造选项。 */
export interface TraeCnAdapterOptions {
  credentialRef: CredentialRef
  /**
   * 从凭据存储解析凭据。
   *
   * `model` 是**本次请求的目标模型**，由 `stream()` 从 `options.model` 透传，
   * 供多账号池跳过「对该模型仍有限流/额度标记」的账号。无目标模型的场景
   * （拉模型目录）省略该参数。
   */
  resolveCredential: (model?: string) => Promise<TraeCnCredential | undefined>
  /**
   * 静默续期凭据。
   *
   * `model` 与 {@link TraeCnAdapterOptions.resolveCredential} 同源。**必须用同一个
   * model 选号**：`refresh` 是「按账号池选号再续期该账号」，若它与解析时用的过滤
   * 口径不同（例如这里漏传 model），就会出现「解析到 B、却刷新了 A」—— B 的过期
   * token 永不更新，用户看到「刚登录好却一直认证失败」而日志全绿（历史上的 S1
   * 缺陷，回归测试见 `tests/unit/lobsterai-wiring.spec.ts`）。
   */
  refresh: (model?: string) => Promise<void>
  /** 动态拉取远端模型列表；失败或未注入时回退 {@link TRAE_CN_FALLBACK_MODELS}。 */
  fetchRemoteModels?: () => Promise<TraeCnRemoteModel[]>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号）。 */
  accountPool?: AccountPool
  /** 产品配置；默认 `TRAE_CN`。 */
  product?: TraeCnProduct
}

/** Trae CN 模型适配器。使用 `Cloud-IDE-JWT` 鉴权，仅支持 SSE。 */
export class TraeCnAdapter extends LlmAdapter {
  private readonly product: TraeCnProduct
  private readonly fetchImpl: typeof fetch
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: TraeCnRemoteModel[] | undefined
  /** 静态兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, TraeCnFallbackModel>

  constructor(private readonly options: TraeCnAdapterOptions) {
    super()
    this.product = options.product ?? TRAE_CN
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(TRAE_CN_FALLBACK_MODELS.map((model) => [model.id, model]))
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

  /**
   * 静态兜底模型目录。
   *
   * **不做 buddy 那样的「以兜底表为准」裁剪**（`reconcileWithFallback`）：远端接口是
   * **权威的**，远端可用时应完全采信，兜底只在远端整体失败时顶替。
   */
  private staticFallbackModels(): readonly { id: string; name: string }[] {
    return TRAE_CN_FALLBACK_MODELS.map((model) => ({ id: model.id, name: model.name }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.staticFallbackModels()
    // 用户在 Account Hub 关闭的模型（黑名单制：不在表里即默认打开）。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // 图片输入未实测支持，一律只报文本。
      inputModalities: ['text'] as const,
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const remoteName = this.remoteModels?.find((entry) => entry.id === model)?.name
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: remoteName ?? this.fallbackIndex.get(model)?.name ?? model,
      inputModalities: ['text'],
    }
    // 上下文窗口：只用兜底表的值（远端目录不含该字段，见 TraeCnFallbackModel 的 T8 说明）。
    const contextWindow = this.fallbackIndex.get(model)?.contextWindow
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    // 思考等级：**刻意不声明**。Trae 是否支持 `reasoning_effort` 未实测；不声明时
    // 模型选择器会显示「当前模型未提供推理等级」，这是诚实的；声明了却无效会让
    // 用户以为档位生效了。
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本基类尚未
   * 提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
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
    // 图片：未实测支持，明确报错而不是静默丢弃（静默丢弃会让用户以为模型看到了
    // 图片）。检查在取凭据之前，省掉一次无谓的凭据读取。
    for (const message of options.messages) {
      if (!Array.isArray(message.content)) continue
      const hasImage = message.content.some((block) =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'image')
      if (hasImage) throw new LlmError('trae-cn: 当前 provider 不支持图片输入', 'UNSUPPORTED_CONTENT')
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
      throw new LlmError('trae-cn: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 记录当前账号（限流时可切换）
    let currentAccountId = ''
    if (this.options.accountPool) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id, credential.access_token,
        )
        if (currentAccountId === '') {
          console.warn('[trae-cn] 当前凭据未匹配到账号池条目，限流记录将被跳过')
        }
      } catch (error) {
        console.warn('[trae-cn] 账号匹配失败（不影响本次请求）:', error)
      }
    }

    await this.ensureRemoteModels()
    const body = this.buildBody(options)

    // 3. 发送首个请求（401/403 时先续期一次再重试）
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      await this.options.refresh(options.model)
      const refreshed = await this.options.resolveCredential(options.model)
      if (refreshed === undefined || refreshed.access_token.length === 0) {
        throw new LlmError('trae-cn: credential expired and refresh failed', 'AUTH', { status: response.status })
      }
      credential = refreshed
      response = await this.send(credential, body, options)
    }

    /**
     * 已试过的账号 id。
     *
     * 换号时必须传给池：失败类别为 5xx / 请求错误时**不写冷却标记**，
     * 刚失败的账号仍是池里排序第一，不排除就会拿回同一个账号、命中 `tried.has`
     * 而立即中断 —— 换号形同虚设。对齐 Go 的 `PickExcluding(tried)`。
     */
    const tried = new Set<string>()
    let accountId = currentAccountId
    if (accountId !== '') tried.add(accountId)

    /** 最后一次失败的成组状态（message / action / status / 业务码必须同源）。 */
    let lastMessage = ''
    let lastAction: TraeCnErrorAction = 'fail'
    let lastStatus = response.status
    let lastSseCode: string | undefined

    // 4. 换号循环。
    //
    // 这一个循环覆盖**两条**失败路径，因为它们在本 provider 上同等重要：
    // - **HTTP 失败**（无业务码，按状态码分类）：401/403 已在上面处理过一次，
    //   这里接住的是 429/5xx；
    // - **流内业务错误**（HTTP 200 + `event:error`，按业务码分类）：限流 / 额度 /
    //   风控 / 账号失效**全部**走这条 —— 这是本 provider 最主要的失败模式，
    //   也是它与 lobsterai 在结构上的根本差异（后者的错误都在 `!response.ok` 里，
    //   流一旦开始就没有换号的余地）。
    //
    // ⚠️ **上限减 1**：首个账号在循环外已经发过一次请求；不减的话总请求数会变成
    // 1 + MaxRotate，比 `TRAE_CN_MAX_ROTATE` 的设计值多一次。
    const maxRotate = TRAE_CN_MAX_ROTATE - 1
    for (let round = 0; ; round++) {
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        lastAction = classifyTraeCnError({ httpStatus: response.status })
        lastStatus = response.status
        lastMessage = `trae-cn: ${errorDetail(text) || `HTTP ${response.status}`}`
        lastSseCode = undefined
      } else {
        // 消费流：chunk **实时透传**（用户要看到逐字输出），同时记录是否已有产出。
        const cell: ConsumeCell = { yielded: false }
        for await (const chunk of this.consumeInto(response, options, cell)) {
          cell.yielded = true
          yield chunk
        }
        const outcome = cell.outcome!

        if (outcome.sseError === undefined && outcome.produced) {
          // 成功收尾。三种「不完整」都必须报告 max-tokens 而非 tool-calls：
          // - 未收到 done 帧：连接被中途掐断，工具参数必然是半截 JSON；
          // - 工具参数无法解析：分片在流式下发中丢失。
          // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，模型收到
          // 莫名错误后陷入重试循环；报告 max-tokens 则丢弃并重试（与其它 provider
          // 同策略）。
          yield {
            type: 'finish',
            reason: !outcome.done || outcome.argumentsTruncated
              ? { kind: 'max-tokens' }
              : outcome.hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' },
          }
          return
        }

        if (outcome.sseError === undefined) {
          // 用了 `done` 帧却一个内容块都没有：报 EMPTY_RESPONSE 让 DSH 重试，而不是
          // 把一条空 assistant 消息交给用户（那会静默结束本轮）。**不换号** ——
          // 空回复不是账号问题，换个账号只会再拿到一次空回复。
          throw new LlmError(
            'trae-cn: 上游返回空回复（done 帧后无任何内容块）',
            'EMPTY_RESPONSE',
            { status: response.status },
          )
        }

        lastStatus = response.status
        lastSseCode = outcome.sseError.code === undefined ? undefined : String(outcome.sseError.code)
        lastMessage = `trae-cn: ${outcome.sseError.message}`
          + (lastSseCode === undefined ? '' : ` (code=${lastSseCode})`)
        // 已经透传出内容时不再换号：换号会让用户看到「半截回答 + 完整回答」两段
        // 内容，比直接报错更糟。降级为直报 —— 下面的 `shouldSwitchTraeCnAccount`
        // 因此为假，循环会带着这次失败的真实原因退出。
        //
        // 用 `cell.yielded`（而不是 `outcome.produced`）：前者涵盖所有已发出的
        // chunk（含 `usage`），后者只涵盖正文/思考/工具块。只发过 usage 就失败时
        // 同样不能重来，否则用量会被重复计入。
        //
        // 注意**不要**在这里 break：那样会跳过 `recordCooldown`，让一个真实发生的
        // 限流不留任何痕迹（用户事后无从知道是限流导致的）。
        lastAction = cell.yielded ? 'fail' : outcome.sseError.action
      }

      // **先记冷却，再决定是否换号**。
      //
      // 顺序不能颠倒：`recordCooldown` 只对**换号类**的码写标记（见其说明），
      // 而 `accountId` 在下面会被推进到下一个账号 —— 先记才不会记到别人头上。
      // 退避类（软限流 / 排队）在这里**不写标记**：写了下一次选号就会跳过该账号，
      // 等于偷偷换号，与「排队不换号」的决策相矛盾。
      await this.recordCooldown(accountId, options.model, lastSseCode)

      if (!this.options.accountPool) break
      if (!shouldSwitchTraeCnAccount(lastAction)) break
      if (round >= maxRotate) break

      const next = await this.options.accountPool.getAvailableAccount(this.product.id, options.model, tried)
      if (!next || tried.has(next.entry.id)) break
      tried.add(next.entry.id)
      accountId = next.entry.id
      response = await this.send(next.credential as TraeCnCredential, body, options)
    }

    // 5. 试遍候选（或本就没有池、或已产出过内容不能再换号）：抛出**最后一次**的
    // 真实原因，不吞诊断信息。
    //
    // 两条路径的错误码来源不同，不能混用：
    // - **无业务码**（HTTP 层失败）→ 按状态码映射（401→AUTH、429/5xx→可重试）；
    // - **有业务码**（流内业务失败）→ 按业务码映射（`4006` → CONTEXT_WINDOW_EXCEEDED
    //   触发上下文压缩，其余 fail → INVALID_REQUEST）。若这里误用状态码，
    //   一个「请求超长」的业务错误会被映射成 `HTTP_200`，既不可重试也不触发压缩，
    //   用户只看到一句无意义的错误码。
    if (lastSseCode !== undefined) {
      throw new LlmError(lastMessage, traeCnErrorCodeForAction(lastAction, lastSseCode))
    }
    throw new LlmError(lastMessage, actionErrorCode(lastAction, lastStatus), { status: lastStatus })
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
    const inner = consumeTraeCnStream(response, {
      label: 'trae-cn',
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
        throw new LlmError(`trae-cn: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /** 上一次 {@link consume} 的 outcome（生成器的 return 值无法经 `for await` 传出）。 */
  private lastOutcome: TraeCnStreamOutcome | undefined

  /**
   * 记录模型级冷却标记（让 Account Hub 亮出徽章）。
   *
   * 只对 `recordsTraeCnCooldown` 认可的码记录，即**换号类**的限流 / 额度 / 风控码。
   *
   * **退避类（软限流 / 排队）刻意不记**，这是功能性的取舍而非遗漏：
   * 冷却标记的作用是让 `getAvailableAccount` 在**下一次选号时跳过该账号**，
   * 而退避的语义恰恰是「不换号、稍后重试同一个账号」。若给 4007 / 4000005 记上
   * 标记，DSH 重试时账号池会把该账号过滤掉、改用另一个账号 —— 那就等于偷偷换号，
   * 与用户确认的「排队不换号」决策相矛盾（排队是全局状态，换号无益）。
   *
   * 账号失效码（1001/1002/4010/4014）同理不记：唯一的解法是重新登录，
   * 给它记一个「等待重置」的徽章是虚假信息（详见 `trae-cn-errors.ts`）。
   */
  private async recordCooldown(
    accountId: string,
    model: string,
    sseErrorCode: string | undefined,
  ): Promise<void> {
    if (!this.options.accountPool || accountId === '') return
    if (!recordsTraeCnCooldown(sseErrorCode)) return
    try {
      await this.options.accountPool.updateModelRateLimit(
        accountId,
        model,
        Date.now() + TRAE_CN_COOLDOWN_MS,
      )
    } catch (error) {
      console.warn('[trae-cn] 记录限流标记失败（不影响本次请求）:', error)
    }
  }

  /** 构造 chat 请求体。 */
  private buildBody(options: GenerateOptions): string {
    const messages = serializeTraeCnMessages(options.messages)
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      // **恒为 true**：chat 端点只返回 SSE。
      stream: true,
    }
    if (tools !== undefined && tools.length > 0) body.tools = tools
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.stop !== undefined && options.stop.length > 0) body.stop = options.stop
    // 思考等级：仅在调用方显式传入时透传，不主动补档（未在 Trae 上实测支持，
    // 补档可能造成非法参数 400）。
    if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort
    return JSON.stringify(body)
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: TraeCnCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    // `Accept: text/event-stream` 由 traeCnAccessHeaders 的 accept 参数给出。
    // 注意：这里不用 `new Headers(...)` —— Headers 构造器会丢弃/规范化部分头，
    // 普通对象逐字传递（与 credits 模块一致），避免两处请求头形态不一致。
    const headers = traeCnAccessHeaders(credential, 'text/event-stream')
    try {
      return await this.fetchImpl(`${this.product.apiBase}${TRAE_CN_CHAT_PATH}`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`trae-cn: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }
}

/** 一次流消费的旁路结果（`for await` 会丢弃生成器的 `return` 值，故用 cell 传递）。 */
interface ConsumeCell {
  /** 流消费完成后的结果。 */
  outcome?: TraeCnStreamOutcome
  /** 是否已向外透传过 chunk（决定能否安全换号）。 */
  yielded: boolean
}

/**
 * 在 `ctx.llm` 上注册 Trae CN provider 路由与适配器。
 *
 * 路由名、配置页展示名与 settingsNs 全部由产品配置驱动，得到 `trae-cn` /
 * `llm-trae-cn`。`settingsNs` **必须**与 `src/index.ts` 的
 * `registerProviderSettings` 注册的 namespace 一致，否则模型设置页会因未注册
 * namespace 在 `refFor → deriveKeyRef(provider)` 处崩溃。
 */
export function registerTraeCnLlm(ctx: Context, options: TraeCnAdapterOptions): void {
  const product = options.product ?? TRAE_CN
  ctx.llm.registerConfigurableProviders([
    { provider: product.id, displayName: product.displayName, settingsNs: `llm-${product.id}`, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([product.id], new TraeCnAdapter(options))
}
