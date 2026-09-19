/**
 * Trae CN（字节跳动 Trae 国内版）**SOLO 通道**的模型目录与网关请求形态。
 *
 * ## 为什么单独成模块（而不是塞进适配器）
 *
 * 本模块同时被**两个**消费者使用：`src/trae-cn-adapter.ts`（chat）与它自己的
 * **目录拉取**（`get_detail_param`）。两者共用同一套网关头，而适配器又必须
 * import 本模块的静态表 —— 若把头构造器留在适配器里，目录拉取就会形成
 * `models → adapter → models` 的循环。故「SOLO 通道的请求形态」在这里成篇：
 * 目录解析、目录拉取、静态回退表、头构造器四件事。
 *
 * ## 端点迁移（2026-09-19 五轮真机取证定案）
 *
 * chat 端点已从旧 aiserver 通道 `/api/ide/v1/chat` 迁到
 * **SOLO 通道 `/api/agent/v3/llm_utils_chat`**。旧通道的 `llm_raw_chat` 场景
 * 只有 5 项旧池，我方请求恒回 `3003 all models failed`，历史零成功；真实客户端的
 * 新池聊天走 `harness.dll` 原生链路（第三方无法复刻），而 SOLO 通道**已用我方
 * 凭据实测走通**（`glm-5.2` 流式正常、`glm-5.3` + tools 结构化调用全绿，HTTP 200 SSE）。
 * host 不变（仍是 {@link TRAE_CN_IDE_API_BASE}），凭据不变。
 *
 * **决定成败的是端点 + body 的 `config_name` / `function` 两字段**（头集合差异
 * 已排除：网关对多余头宽容）。
 *
 * ## 目录：动态拉取 + 静态回退
 *
 * 旧记载「模型目录刻意走静态表、远端不可接」**已作废**：当时试的是
 * `model_list` / `batch_get_detail_param` 等端点，它们确实只回旧池；真正可用的是
 * **`POST /api/ide/v1/get_detail_param`**，按 `function` 分别拉取后取并集。
 */

import { randomUUID } from 'node:crypto'
import { traeCnAccessHeaders } from './trae-cn-oauth.js'
import type { TraeCnCredential } from './trae-cn-oauth.js'
import { TRAE_CN_DEVICE_TYPE, TRAE_CN_OS_VERSION } from './trae-cn-credits.js'
import {
  TRAE_CN_IDE_API_BASE,
  TRAE_CN_IDE_APP_ID,
  TRAE_CN_IDE_VERSION_TYPE,
  TRAE_CN_MODELS_PATH,
  TRAE_CN_REQUEST_TRAFFIC_TYPE,
  TRAE_CN_SOLO_IDE_VERSION,
  TRAE_CN_SOLO_VERSION_CODE,
  TRAE_CN_USER_AGENT_PREFIX,
} from './trae-cn-product.js'

// ── 常量：SOLO 通道 ──

/**
 * CN 区**优先** function（41 项，用户可调的模型基本都在这里）。
 *
 * 静态回退表的 11 项**全部**映射到本 function —— 实测确认它们在
 * `solo_work_remote` 集内，而 `glm-5.3` 等模型**不在** lite 集里（写死 lite 必
 * `4001 param is invalid`）。
 */
export const TRAE_CN_SOLO_REMOTE_FUNCTION = 'solo_work_remote'

/**
 * CN 区**次级** function（`solo_work_lite`）。
 *
 * 它列出的项里混有内部 agent 项（见 {@link isInternalTraeCnConfig}），故只在
 * `solo_work_remote` 拉取失败时作为兜底来源（见 {@link mergeTraeCnDirectory}）。
 */
export const TRAE_CN_SOLO_LITE_FUNCTION = 'solo_work_lite'

/** CN 区目录 function 的拉取顺序（**优先级即数组顺序**，remote 优先）。 */
export const TRAE_CN_SOLO_FUNCTIONS: readonly string[] = [
  TRAE_CN_SOLO_REMOTE_FUNCTION,
  TRAE_CN_SOLO_LITE_FUNCTION,
]

/**
 * 目录缓存 TTL（毫秒，12 小时）。
 *
 * 与 LobsterAI 的 `clientVersion` 缓存同一口径（那边也是 12h）：目录变化极慢，
 * 而 `listModels` / `resolveModel` / `stream` 都会触发一次「确保目录就绪」，
 * 没有 TTL 就只能进程级缓存一次，有了 TTL 则长会话也能自愈到新模型。
 */
export const TRAE_CN_MODELS_TTL_MS = 12 * 60 * 60 * 1000

/**
 * SOLO 通道的 `User-Agent`：`Trae/<SOLO 代际版本>`。
 *
 * 与旧 IDE 通道的 `TraeClient/TTNet` **不是一个值** —— 那是旧通道实测的 UA。
 * SOLO 通道的 UA 与**版本头同代际**：实机验证过的成功组合是
 * `x-ide-version-code: 20260820` + `x-ide-version: 0.1.61` + **`User-Agent: Trae/0.1.61`**，
 * 故版本号取 {@link TRAE_CN_SOLO_IDE_VERSION}（`0.1.61`），**不是**签到线的
 * `TRAE_CN_APP_VERSION`（`3.3.102`）—— 后者属另一条协议线，混用会让 UA 与版本头
 * 自相矛盾（迁移前本常量确实取的是它，属于「顺手复用」而非实测值）。
 *
 * 形态前缀仍取 {@link TRAE_CN_USER_AGENT_PREFIX}（`Trae/`，那才是实测的形态本身）。
 */
export const TRAE_CN_SOLO_USER_AGENT = `${TRAE_CN_USER_AGENT_PREFIX}${TRAE_CN_SOLO_IDE_VERSION}`

/**
 * SOLO 通道的 `x-plugin-channel`（实测值）。
 *
 * 它声明「请求来自 iCube 插件通道」，与 `x-app-id` 一样属于**客户端形态标识**：
 * 不是遥测字段，缺了会让网关按另一种形态归因。
 */
export const TRAE_CN_PLUGIN_CHANNEL = 'icube-ai'

/** 目录请求体（`function` 由调用方按 function 填入，其余为实测定案的固定值）。 */
export const TRAE_CN_DIRECTORY_BODY: Readonly<Record<string, unknown>> = {
  config_names: null,
  need_prompt: false,
  current_config_info: null,
  poly_prompt: true,
  mode_type: null,
  agent_type: null,
}

/**
 * 目录里**明确已知的内部项**（不是用户可调的模型）。
 *
 * 这些 id 出现在 SOLO 目录里，但它们是 agent 内部构件（摘要、文件检索子代理、
 * 浏览器/电脑操作子代理），选中即路由到不存在的能力上。逐个点名而不是只靠
 * 模式匹配：名字是实测观察到的，写死才有回归价值。
 */
export const TRAE_CN_INTERNAL_CONFIG_NAMES: readonly string[] = [
  'summary',
  'file_search_agent',
  'explore_sub_agent_v2',
  'browser_use_subagent',
  'computer_use_subagent',
]

/**
 * 内部项的**形态特征**（`agent` / `subagent` 出现在 id 里）。
 *
 * 与 {@link TRAE_CN_INTERNAL_CONFIG_NAMES} 是「点名 + 形态」两道网，理由见
 * {@link isInternalTraeCnConfig}：上游随时可能新增一个 `xxx_agent` 形态的内部项，
 * 而用户可调的模型 id 里没有这个形态（真机 16 项逐字符核对过）。
 */
const TRAE_CN_INTERNAL_NAME_PATTERN = /agent|subagent/i

/**
 * 判定目录项是否为**内部 agent 项**（应当从模型目录里剔除）。
 *
 * ## 两道判据，宁可保守
 *
 * 1. **点名**（{@link TRAE_CN_INTERNAL_CONFIG_NAMES}）；
 * 2. **形态**（id 里含 `agent` / `subagent`）。
 *
 * 反向证据（为什么敢用形态判据）：实测 roster 里**用户可调的项要么两个 function
 * 都在集、要么 remote 独有**，而真机 16 项静态表里没有任何一个 id 含 `agent`。
 * 因此「含 agent」在当前 roster 上等价于「内部项」，不会误杀用户可调的模型。
 *
 * 取**保守**方向（宁可多过滤）：多列一个内部项，用户选中后拿到的是一个语义错乱
 * 的回复；少列一个真模型，用户只是看不到它（静态表仍会补上那 11 项）。
 */
export function isInternalTraeCnConfig(id: string): boolean {
  if (TRAE_CN_INTERNAL_CONFIG_NAMES.includes(id)) return true
  return TRAE_CN_INTERNAL_NAME_PATTERN.test(id)
}

// ── 模型条目与静态表 ──

/**
 * 静态回退表里的一个条目（**真机 16 项中剔除 5 项 SOLO 不可调 id 后的 11 项，
 * 逐字符照抄**）。
 *
 * 本表**只在动态目录整体失败时顶替**（见 {@link TRAE_CN_FALLBACK_MODELS}）。
 */
export interface TraeCnFallbackModel {
  /** 模型 ID（传给 chat 请求体的 `model` / `config_name`）。 */
  id: string
  /** 展示名。 */
  name: string
  /**
   * 上下文窗口（**真机目录给出的开发档，非估计值**）。
   *
   * 真机目录（2026-09-18）为每项给出 `ctx(dev/max)` 两档，本字段取 **dev 档**：
   * 它是客户端默认实际使用的窗口（如 `262144/1048576` → 262144）。
   * max 档（多数为 1048576）**刻意不取** —— 目录里它是理论上限，
   * 而 `resolveModel` 声明的窗口会被 DSH 用来决定何时压缩上下文，
   * 按上限声明会让压缩迟迟不触发。
   */
  contextWindow: number
  /**
   * 是否接受图片输入（真机目录的「多模态」标记，原 16 项里 12 项为真；本表现存
   * 11 项中 7 项为真 —— 被剔除的 5 项恰好全是多模态项）。
   *
   * 与 `src/product.ts` 的 `supportsImages` 同语义同字段名：适配器据此在
   * `listModels` / `resolveModel` 里输出 `['text','image']` 或 `['text']`。
   */
  supportsImages: boolean
  /**
   * 该模型的最大输出 token 数（真机目录的 `max_tokens`：`64000` 或 `32000`）。
   *
   * **刻意只记录、不落进 `defaultMaxTokens`**：DSH 的
   * `LlmResolvedModelInfo.defaultMaxTokens` 会在调用方未给 `maxTokens` 时自动
   * 填进请求体，而本仓库另外四个 provider 一个都没设该字段
   * （`grep defaultMaxTokens src/` 零命中）—— 由适配器替用户决定输出上限是
   * 行为变更。保留字段是为了让目录与真机逐列对齐（否则后来者会以为目录里本来
   * 就没有它）。
   */
  maxTokens: number
  /**
   * 可选思考档位（真机 vscdb `reasoning_effort_config.options`，逐字符照抄）。
   *
   * 空/缺省 = **不暴露选择器**：DSH 的模型选择器只读 `resolveModel().reasoning`，
   * 不声明该字段时显示「当前模型未提供推理等级」，这是诚实的（同
   * `src/buddy-adapter.ts` 的 `reasoningEfforts` 约定）。
   */
  reasoningEfforts?: readonly string[]
  /**
   * 默认档位（真机 `reasoning_effort_config.default_level`），**必须**在
   * {@link reasoningEfforts} 内。
   *
   * DSH 的 `resolveCallInfo` 会在调用方省略 `reasoningEffort` 时把它 materialize
   * 进请求，故它同时是「用户没选档位时实际下发的值」。声明了却不在
   * efforts 里会被 DSH 判为 `INVALID_MODEL_REASONING` 直接抛错。
   */
  defaultReasoningEffort?: string
}

/**
 * 静态模型目录 —— **11 项**（真机 `chat_v3` 16 项中剔除 5 项 SOLO 不可调 id）。
 *
 * ## 来源
 *
 * 真机 `chat_v3` 模型目录（2026-09-18），由 Trae 客户端 **vscdb 缓存**与
 * **160 处日志事件**互证得到；id / 展示名 / 多模态标记 / max_tokens /
 * 上下文窗口**逐字符**照抄。id 的形态极不规则（`qwen3.8-flash` 无连字符、
 * `qwen-3.7-plus` 有、`deepseek-v4.1-flash` 是点号、`minimax-m3` 全小写），
 * 任何「规整化」都会让请求打到不存在的模型上 —— 故原样保留，不要改写。
 *
 * ## ⚠️ 为什么从 16 项缩到 11 项（2026-09-19 二次取证）
 *
 * 原表 16 项录自**旧 IDE 通道**的 `chat_v3` 目录。chat 迁到 **SOLO 通道**后，
 * 该通道的 roster 只有 **41 项**，其中 5 项**不在** SOLO roster 内（实测）：
 *
 * | 剔除的 id | 说明 |
 * |---|---|
 * | `Doubao-Seed-Code` | SOLO 41 项里没有它 |
 * | `glm-5.3-flash` | 同上 |
 * | `deepseek-v4.1-flash` | 同上 |
 * | `kimi-k2.8-preview` | 同上 |
 * | `qwen3.8-flash` | 同上 |
 *
 * 剔除的理由不是「表要精简」，而是**本 provider 只走 SOLO 通道**（IDE 通道已由
 * 五轮真机取证定案废弃：`llm_raw_chat` 恒回 `3003 all models failed`）。回退表里
 * 留着 SOLO 调不了的 id，唯一效果是**在模型选择器里产出必然 `4001` 的选项** ——
 * 用户选中即失败，且失败原因（版本头/表不匹配）与模型本身无关，极难自行诊断。
 * 动态目录成功时本来也不会列出它们（它们不在 SOLO roster 里），故剔除后两条
 * 路径的目录**首次一致**。
 *
 * 注意 `Doubao-Seed-Code` 的剔除**只针对本 provider**：它在
 * `trae-cn-work`（`solo_agent_remote` 代际）里是**默认模型**，两张表互不影响。
 *
 * ## 现在的角色：**回退表**（不再是唯一目录）
 *
 * 动态目录（`get_detail_param`）是权威来源；本表在动态目录整体失败时顶替
 * （见 `src/trae-cn-adapter.ts` 的 `ensureRemoteModels`）。它仍是**唯一**记录
 * 「多模态标记」的地方 —— 目录端点不带该字段（见
 * {@link applyTraeCnStaticModalities}）。
 *
 * ## 4 个旧死 id 的下落（原 8 项静态表里的）
 *
 * | 旧 id | 现状 |
 * |---|---|
 * | `qwen3.7-max` | **已下线**（真机目录里没有它） |
 * | `deepseek-v4-flash` | 拼写错误的近似形态（真机是 `deepseek-v4.1-flash`，该 id 亦已剔除） |
 * | `doubao-seed-2-1-pro` | 同上（真机是 `Doubao-Seed-2.1-Pro`） |
 * | `MiniMax-M3` | 大小写错误的近似形态（真机是 `minimax-m3`） |
 *
 * 真机目录里**没有** `deepseek//deepseek-chat` 与 `deepseek//deepseek-reasoner`：
 * 那两个是账号自定义的 BYOK 条目，不属于云端目录，故**排除**。
 */
export const TRAE_CN_FALLBACK_MODELS: readonly TraeCnFallbackModel[] = [
  { id: 'Doubao-Seed-Evolving', name: 'Seed-Evolving', supportsImages: true, contextWindow: 262_144, maxTokens: 64_000 },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Seed-2.1-Pro-0915', supportsImages: true, contextWindow: 262_144, maxTokens: 64_000, reasoningEfforts: ['light', 'high'], defaultReasoningEffort: 'high' },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Seed-2.1-Turbo', supportsImages: true, contextWindow: 262_144, maxTokens: 32_000, reasoningEfforts: ['light', 'high'], defaultReasoningEffort: 'high' },
  { id: 'glm-5.3', name: 'GLM-5.3', supportsImages: false, contextWindow: 119_040, maxTokens: 64_000, reasoningEfforts: ['light', 'high', 'extra_high'], defaultReasoningEffort: 'high' },
  { id: 'glm-5.2', name: 'GLM-5.2', supportsImages: false, contextWindow: 119_040, maxTokens: 64_000, reasoningEfforts: ['high', 'extra_high'], defaultReasoningEffort: 'high' },
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash 正式版', supportsImages: false, contextWindow: 119_040, maxTokens: 64_000, reasoningEfforts: ['light', 'high', 'extra_high'], defaultReasoningEffort: 'high' },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro 正式版', supportsImages: false, contextWindow: 119_040, maxTokens: 64_000, reasoningEfforts: ['light', 'high', 'extra_high'], defaultReasoningEffort: 'high' },
  { id: 'kimi-k3', name: 'Kimi-K3', supportsImages: true, contextWindow: 204_800, maxTokens: 64_000, reasoningEfforts: ['light', 'high', 'extra_high'], defaultReasoningEffort: 'extra_high' },
  { id: 'minimax-m3', name: 'MiniMax-M3', supportsImages: true, contextWindow: 119_040, maxTokens: 64_000 },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', supportsImages: true, contextWindow: 204_800, maxTokens: 64_000, reasoningEfforts: ['light', 'high', 'extra_high'], defaultReasoningEffort: 'high' },
  { id: 'qwen-3.7-plus', name: 'Qwen3.7-Plus', supportsImages: true, contextWindow: 204_800, maxTokens: 64_000 },
]

/**
 * 目录条目（**动态与静态两个来源共用同一种形态**）。
 *
 * `function` 是本类型的核心字段：它记录**该模型从哪个 function 拉到的**，
 * chat 请求的 `function` 字段照它下发。写死 `solo_work_lite` 会让
 * `glm-5.3` 等模型回 `4001 param is invalid`（真机实测）。
 */
export interface TraeCnModelEntry {
  id: string
  name: string
  /**
   * 是否接受图片输入。
   *
   * **缺省 = 未知**（目录端点不带该字段）→ 适配器按**纯文本**声明。
   * 静态表条目一律有值（真机 vscdb 的多模态标记）。
   */
  supportsImages?: boolean
  /** 上下文窗口（目录给的 dev 档 / `prompt_max_tokens`）。缺省 = 未提供。 */
  contextWindow?: number
  /** 最大输出 token（**只记录，不 materialize**，见 TraeCnFallbackModel.maxTokens）。 */
  maxTokens?: number
  /** 可选思考档位；缺省 = 不声明（选择器不渲染该行）。 */
  reasoningEfforts?: readonly string[]
  /** 默认档位，必须在 {@link reasoningEfforts} 内。 */
  defaultReasoningEffort?: string
  /** 该模型的来源 function（chat 请求的 `function` 字段）。 */
  function: string
}

/** 静态回退表 → 目录条目（全部映射到 {@link TRAE_CN_SOLO_REMOTE_FUNCTION}）。 */
export function fallbackTraeCnCatalog(): TraeCnModelEntry[] {
  return TRAE_CN_FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    supportsImages: model.supportsImages,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts },
    ...model.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: model.defaultReasoningEffort },
    function: TRAE_CN_SOLO_REMOTE_FUNCTION,
  }))
}

/**
 * 用静态表补**多模态标记**（目录端点不提供该字段）。
 *
 * ## 为什么需要这一步
 *
 * `get_detail_param` 的条目里**没有**多模态标记（对照实现只读
 * `config_name` / `display_config` / `model_detail_list` / `context_window_tokens`），
 * 而静态表是真机 vscdb 逐项记录的模态标记（原 16 项里 12 项、现存 11 项里 7 项）。
 * 不补的话，动态目录一旦生效，这些支持图片的模型会**全部**变成纯文本 ——
 * 同一模型在「目录拉取成功」与「目录拉取失败」两条路径下报出不同模态，是自相矛盾。
 *
 * ## 边界（**不是**「接 remote 骨架」）
 *
 * 只对**静态表里已有的 id** 补值，**不新增**任何条目：远端独有 id 的多模态
 * 仍然未知（按纯文本）。骨架合并（把远端独有项也列出来）**刻意不做** ——
 * 那会引入 `join` 不到的不可调项（如旧表里的 `Doubao-Seed-Code`），选中即失败。
 *
 * 已被目录给出模态的条目不覆盖（目录将来若带上该字段，以目录为准）。
 */
export function applyTraeCnStaticModalities(entries: readonly TraeCnModelEntry[]): TraeCnModelEntry[] {
  const staticFlags = new Map(TRAE_CN_FALLBACK_MODELS.map((model) => [model.id, model.supportsImages]))
  return entries.map((entry) => {
    if (entry.supportsImages !== undefined) return entry
    const known = staticFlags.get(entry.id)
    return known === undefined ? entry : { ...entry, supportsImages: known }
  })
}

// ── 目录解析 ──

/**
 * 解析 `get_detail_param` 的响应（**只认实测形态**）。
 *
 * ```json
 * {"config_info_list":[{"config_name":"glm-5.3","display_config":{"display_name":"GLM-5.3"},
 *   "model_detail_list":[{"prompt_max_tokens":119040,"max_tokens":64000}],
 *   "context_window_tokens":{"dev":119040,"max":1048576}}, ...]}
 * ```
 *
 * ## 与旧解析器的区别（旧的已删除）
 *
 * 旧 `parseTraeCnModels` 是**容忍式猜测**：从 `data` / `models` / `model_list` /
 * `result` / `items` 等一堆候选键里找数组，字段名也试五六个候选。那是为「远端
 * 不接线、留个入口」写的，从未被真机响应校准过。现在端点已实测，本函数**只读
 * 实测路径**（顶层 `config_info_list`），不做信封猜测 —— 上游真改版时，一个
 * **空目录**（回退静态表，用户仍能用）比「猜对形状但读错字段」的半成品更容易诊断。
 *
 * 字段读取：
 * - id：`config_name`（空串跳过）；
 * - 展示名：`display_config.display_name`，缺省回退 id；
 * - 上下文窗口：`model_detail_list[0].prompt_max_tokens`，回退 `context_window_tokens.dev`；
 * - 输出上限：`model_detail_list[0].max_tokens`；
 * - 思考档位：`reasoning_effort_config`（`support_thinking === true` 且 `options`
 *   是非空字符串数组才声明，`default_level` 不在 options 内时只丢默认档）。
 *
 * @param body - 响应体（任意形态，非对象/缺数组时返回空数组）。
 * @param functionName - 本次拉取用的 function（写进每个条目的 `function`）。
 */
export function parseTraeCnDirectory(body: unknown, functionName: string): TraeCnModelEntry[] {
  if (typeof body !== 'object' || body === null) return []
  const list = (body as Record<string, unknown>).config_info_list
  if (!Array.isArray(list)) return []

  const entries: TraeCnModelEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = readString(record.config_name)
    if (id === undefined) continue
    const display = asRecord(record.display_config)
    const detail = firstRecord(record.model_detail_list)
    const contextTokens = asRecord(record.context_window_tokens)
    const contextWindow = readPositive(detail?.prompt_max_tokens) ?? readPositive(contextTokens?.dev)
    const maxTokens = readPositive(detail?.max_tokens)
    const reasoning = readReasoningConfig(record)
    entries.push({
      id,
      name: readString(display?.display_name) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...reasoning,
      function: functionName,
    })
  }
  return entries
}

/**
 * 读取 `reasoning_effort_config`（形态 `{support_thinking, options, default_level}`）。
 *
 * 判据与 `src/trae-cn-work-adapter.ts` 的同名函数**刻意保持一致**（两条 Trae
 * 协议线共用同一份真机形态）：只在 `support_thinking === true` **且** `options`
 * 是非空字符串数组时声明档位；`default_level` 不在 `options` 内时只丢默认档、
 * 保留档位列表（上游发出不自洽组合时，用户仍能手动选档）。
 *
 * 档位 id **逐字符照抄**（`light` / `high` / `extra_high`），不做规整化 ——
 * 它会原样进请求体。
 */
function readReasoningConfig(record: Record<string, unknown>): {
  reasoningEfforts?: readonly string[]
  defaultReasoningEffort?: string
} {
  const holder = record.reasoning_effort_config
  if (typeof holder !== 'object' || holder === null) return {}
  const config = holder as Record<string, unknown>
  if (config.support_thinking !== true) return {}
  const options = config.options
  if (!Array.isArray(options)) return {}
  const efforts = options.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  if (efforts.length === 0) return {}
  const defaultLevel = typeof config.default_level === 'string' ? config.default_level.trim() : ''
  return {
    reasoningEfforts: efforts,
    ...efforts.includes(defaultLevel) ? { defaultReasoningEffort: defaultLevel } : {},
  }
}

/** 读非空字符串（去首尾空白），否则 undefined。 */
function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** 读正有限数，否则 undefined（**不把 0 当成有效窗口**）。 */
function readPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 严格判对象（非对象/数组返回 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 取数组首个对象元素。 */
function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return asRecord(value[0])
}

// ── 目录合并与拉取 ──

/** 一次目录拉取里，某个 function 的返回（失败则该 function 不出现）。 */
export interface TraeCnDirectoryGroup {
  /** 拉取用的 function。 */
  function: string
  /** 该 function 返回的条目。 */
  entries: readonly TraeCnModelEntry[]
}

/**
 * 合并多个 function 的目录（**first wins，调用方按优先级给顺序**）。
 *
 * ## 两条规则
 *
 * 1. **remote 优先**：先到的 function 拥有该 id（{@link TRAE_CN_SOLO_FUNCTIONS}
 *    的顺序即优先级）。同名 id 在两条 function 下**可能不是同一个可调项**
 *    （`glm-5.3` 只在 remote 集里），故不能后到覆盖先到。
 * 2. **remote 成功时剔除 lite 独有项**：实测「用户可调的项要么两 function 都在集、
 *    要么 remote 独有」，故**只在 lite 出现**的项就是内部 agent 项
 *    （见 {@link isInternalTraeCnConfig}）。remote 整体失败时这条规则不生效 ——
 *    那时 lite 是唯一数据源，留着它的非内部项比空目录有用（空目录会退回静态表）。
 *
 * 内部项（点名或形态命中）在两条路径上都会被过滤掉。
 */
export function mergeTraeCnDirectory(
  groups: readonly TraeCnDirectoryGroup[],
  remoteSucceeded: boolean,
): TraeCnModelEntry[] {
  const byId = new Map<string, TraeCnModelEntry>()
  for (const group of groups) {
    for (const entry of group.entries) {
      if (isInternalTraeCnConfig(entry.id)) continue
      if (byId.has(entry.id)) continue
      byId.set(entry.id, entry)
    }
  }
  if (remoteSucceeded) {
    // first wins ⇒ 此时还留在表里的非 remote 项必然是「lite 独有」。
    for (const [id, entry] of byId) {
      if (entry.function !== TRAE_CN_SOLO_REMOTE_FUNCTION) byId.delete(id)
    }
  }
  return [...byId.values()]
}

/** {@link fetchTraeCnDirectory} 的入参。 */
export interface TraeCnDirectoryOptions {
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 覆盖网关基址（默认 {@link TRAE_CN_IDE_API_BASE}）。 */
  apiBase?: string
  /** 取消信号。 */
  signal?: AbortSignal
}

/**
 * 拉取动态模型目录（CN 区两个 function 各一次，取并集）。
 *
 * 用**与 chat 完全相同的凭据与网关头**（{@link traeCnSoloHeaders}）——真机实测该
 * 端点带鉴权即 200，且不消耗积分。单个 function 失败**不阻断**另一个：目录是
 * 「尽力而为」的数据，整体落空时适配器回退静态表。
 */
export async function fetchTraeCnDirectory(
  credential: TraeCnCredential,
  options: TraeCnDirectoryOptions = {},
): Promise<TraeCnModelEntry[]> {
  const fetcher = options.fetchImpl ?? fetch
  const apiBase = options.apiBase ?? TRAE_CN_IDE_API_BASE
  const groups: TraeCnDirectoryGroup[] = []
  let remoteSucceeded = false

  for (const functionName of TRAE_CN_SOLO_FUNCTIONS) {
    try {
      const response = await fetcher(`${apiBase}${TRAE_CN_MODELS_PATH}`, {
        method: 'POST',
        headers: traeCnSoloHeaders(credential, 'application/json'),
        body: JSON.stringify({ function: functionName, ...TRAE_CN_DIRECTORY_BODY }),
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      if (!response.ok) continue
      const entries = parseTraeCnDirectory(await response.json(), functionName)
      if (functionName === TRAE_CN_SOLO_REMOTE_FUNCTION) remoteSucceeded = true
      groups.push({ function: functionName, entries })
    } catch {
      // 单 function 失败：继续拉下一个（整体失败由调用方回退静态表）。
    }
  }

  return applyTraeCnStaticModalities(mergeTraeCnDirectory(groups, remoteSucceeded))
}

// ── 网关头 ──

/**
 * 构造 SOLO 通道的请求头（chat 与目录**共用同一份**）。
 *
 * ## 与旧 IDE 通道的差异（逐项都是实测值）
 *
 * | 头 | 旧通道 | **SOLO 通道** |
 * |---|---|---|
 * | `request-traffic-type` | `normal` | **`prod`** |
 * | `x-plugin-channel` | 无 | **`icube-ai`** |
 * | `User-Agent` | `TraeClient/TTNet` | **`Trae/<SOLO 代际版本>`** |
 * | 追踪头 | 无 | **`x-request-id` / `x-trae-request-id` / `x-custom-trace-id` / `x-flow-traceparent`** |
 * | `x-uid` | 无 | **凭据的 `user_id`** |
 *
 * ⚠️ **版本头必须换成 SOLO 代际**（`20260820` / `0.1.61` / `Trae/0.1.61`），
 * **不能**沿用旧 IDE 通道的 `107` / `1.107.1`：SOLO 网关按 `x-ide-version-code`
 * **选模型配置表**，`107` 选出的是一张**空表**，任何模型都恒回
 * `4001 param is invalid`（迁移后 chat 全败的根因）。三个头取自**实机验证过的
 * 成功组合**（`glm-5.3-flash` 流式正常），须成对使用 —— 见
 * {@link TRAE_CN_SOLO_VERSION_CODE} / {@link TRAE_CN_SOLO_IDE_VERSION}。
 *
 * 追踪头三者**同源**：`requestId` 是一个 UUID，`x-custom-trace-id` 是它去横线后
 * 的前 32 字符，`x-flow-traceparent` 是 W3C 形态 `04-<traceId>-<traceId 前 16>-01`。
 * 生成一次、三处复用 —— 每处各 randomUUID() 会让上游的调用链对不上。
 *
 * 刻意**不用** `new Headers(...)`：Headers 构造器会规范化/丢弃部分头，
 * 普通对象逐字传递（与 credits 模块一致），避免两处请求头形态不一致。
 */
export function traeCnSoloHeaders(
  credential: TraeCnCredential,
  accept = 'text/event-stream',
): Record<string, string> {
  const requestId = randomUUID()
  const traceId = requestId.replace(/-/g, '').slice(0, 32)
  return {
    // 三个等值 token 头（Authorization: Cloud-IDE-JWT + X-Ide-Token + X-Cloudide-Token）
    // 由 oauth 模块统一构造：chat / 目录 / 签到走同一份鉴权形态。
    ...traeCnAccessHeaders(credential, accept),
    'x-app-id': TRAE_CN_IDE_APP_ID,
    // SOLO 代际的版本码（**不是** IDE 代际的 `107` —— 那会选出空配置表 → 4001）。
    'x-ide-version-code': TRAE_CN_SOLO_VERSION_CODE,
    // 已隔离验证：本头与选表**无关**；同发 SOLO 代际只为两个版本头不自相矛盾。
    'x-app-version-code': TRAE_CN_SOLO_VERSION_CODE,
    'x-ide-version': TRAE_CN_SOLO_IDE_VERSION,
    'x-ide-version-type': TRAE_CN_IDE_VERSION_TYPE,
    'request-traffic-type': TRAE_CN_REQUEST_TRAFFIC_TYPE,
    'x-plugin-channel': TRAE_CN_PLUGIN_CHANNEL,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    // `x-uid` 取凭据的 user_id（登录 exchange 的 `UserID`），不是昵称也不是设备号。
    'x-uid': credential.user_id,
    // 设备三件套**取自凭据/运行时**，与签到端点同一套身份（见 README 的
    // 「设备号在本项目里是两个位置」）。
    'x-device-id': credential.device_id,
    'x-device-type': TRAE_CN_DEVICE_TYPE,
    'x-os-version': TRAE_CN_OS_VERSION,
    'User-Agent': TRAE_CN_SOLO_USER_AGENT,
  }
}
