/**
 * Trae CN **Work**（`work.trae.cn` 网页版 / TraeWork）产品配置。
 *
 * ## 与 `TraeCnProduct`（IDE 路径）的关系
 *
 * 两者**共用同一批账号与同一份凭据**，但**协议完全不同源**：
 *
 * | 项 | Trae CN（IDE 路径） | Trae CN Work（本文件） |
 * |---|---|---|
 * | Host | `trae-api-cn.mchost.guru`（IDE 网关） | `work.trae.cn`（**同源网页 RPC**） |
 * | 网关头 | 必须带齐 `x-app-id` / `x-ide-version-code` 等全套 | **不需要**，仅鉴权三头 |
 * | 请求形态 | 单次 `POST /api/ide/v1/chat`（无状态） | **三段式**：建会话 → 发消息 → 订阅 SSE |
 * | SSE 事件名 | `output` / `thought` / `done` … | `plan_item` / `token_usage` / `done` …（**无一重合**） |
 * | 模型池 | 16 项（`chat_v3` 代际） | **12 项，id 与 IDE 池完全不重合** |
 * | 扣费池 | 通用积分（`available_endpoint=0`） | **Work 专属积分（`available_endpoint=1`）** |
 *
 * 因此**不复用 `TraeCnProduct` 类型**：那个类型的 `clientId` / `clientSecret` /
 * `portalBase` / `defaultCredentialRef` 等字段对 Work 全部无意义（Work 没有
 * 独立登录，凭据由 traeCnAuth 提供）。这里定义**平行**的精简配置，只保留
 * Work 实际需要的常量。
 *
 * ## 为什么必须做成独立 provider（而不是给 trae-cn 加分支）
 *
 * 1. **扣的是另一个池**：用户通用池耗尽、Work 池仍有额度时，IDE 路径必回
 *    `4008`，而 Work 路径正常扣费。两条路径的可用性**互相独立**，合成一个
 *    provider 会让用户在「模型能用」与「积分够不够」之间失去选择权。
 * 2. **模型 id 不重合**：两个池是不同代际的目录，同名模型（如 `Doubao-Seed-Code`）
 *    在两边的能力/倍率都不同，合并目录会产生无法路由的条目。
 *
 * ## 数据来源（**全部真机实测**，2026-09-18）
 *
 * 用与 IDE 路径**完全相同的凭据**走 TraeWork 网页 RPC，两轮真实对话全链路 200：
 * - 模型目录：`GET /api/remote/v1/models` 实测响应（12 项，字段清单见
 *   {@link TRAE_CN_WORK_FALLBACK_MODELS}）；
 * - 三段式与会话清理：见各路径常量；
 * - 扣费：两轮分别扣 Work 池 **0.0652 / 0.0572**，通用池 **0.0000**（未动）。
 *
 * ## 协议漂移风险
 *
 * 这是**浏览器内部 RPC，无公开契约**：`/api/remote/v1/*` 是 TraeWork 前端
 * 自己调的接口，随时可能随前端发版改变字段或路径。故本文件把所有路径与
 * 形态常量集中在此，上游一变只需改这一处（README 的「协议漂移风险」有登记）。
 */

/**
 * Trae CN Work 上游基址（**编译期常量**）。
 *
 * ⚠️ **同源**：三段式全部打在这个 host 上，与 IDE 网关
 * （`TRAE_CN_IDE_API_BASE` = `trae-api-cn.mchost.guru`）**不是**同一个 ——
 * 真机实测该网页 RPC 在 IDE 网关上不存在，反之亦然。
 *
 * 也**不是** `api.trae.cn`（那上面是签到/续期/余额三条协议线）。
 */
export const TRAE_CN_WORK_API_BASE = 'https://work.trae.cn'

/**
 * 第一段：创建会话（`POST`）。
 *
 * body 为 `{"mode":"code"}`，响应 `{"code":0,"data":{"chat_session_id":"...","status":1}}`。
 */
export const TRAE_CN_WORK_SESSIONS_PATH = '/api/remote/v1/chat_sessions'

/**
 * 模型目录（`GET`，**公开可用但带 rate**）。
 *
 * 响应结构（真机实测）：
 * ```
 * {"code":0,"data":{"list":[{"function":"solo_coder","models":[ ...12 项... ]}]}}
 * ```
 * 注意 `list` 是**按 function 分组**的数组，模型在 `models` 里 ——
 * 不是顶层平铺数组（照抄「`data` 即数组」的猜测会一项都读不到）。
 */
export const TRAE_CN_WORK_MODELS_PATH = '/api/remote/v1/models'

/** 建会话请求体的 `mode`（真机 `code`）。 */
export const TRAE_CN_WORK_SESSION_MODE = 'code'

/**
 * 发消息请求体的固定字段（**官方 `buildSendMessageRequest` 逐字**）。
 *
 * 这几个值是**出站身份标识**：服务端按它们把请求归因到 SOLO Code agent。
 * 一个字符都不能动 —— 改动会让服务端认不出 agent 形态（表现为会话建起来
 * 但永远不产生回复，或直接 4xx）。
 */
export const TRAE_CN_WORK_AGENT_TYPE = 'solo_agent_remote'
export const TRAE_CN_WORK_AGENT_ID = 'solo_agent_remote'
export const TRAE_CN_WORK_MODEL_SELECTION_STRATEGY = 'manual'
export const TRAE_CN_WORK_ORIGIN = 'web'

/**
 * 控制面请求超时（毫秒）；流式对话请求不适用。
 *
 * 比 IDE 路径（30s）宽：建会话/发消息在实测里要 1–3 秒，且服务端可能排队。
 */
export const TRAE_CN_WORK_REQUEST_TIMEOUT_MS = 60_000

/**
 * Work 模型目录条目。
 *
 * ## 字段来源（真机 `GET /api/remote/v1/models`，逐字段核对）
 *
 * 服务端每项的**原始字段**：`name` / `multimodal` / `is_default` /
 * `display_name` / `is_new` / `is_beta` / `icon` / `features`（JSON **字符串**）/
 * `config_source` / `is_preset` / `max_mode` / `context_window_tokens`
 * （`{dev,max}`），个别项带 `reasoning_effort_config`。
 *
 * 本接口只保留适配器真正会用到的四列 —— 其余字段（icon / is_beta / max_mode …）
 * 在 DSH 的 `LlmModelInfo` 里**没有位置**（该接口只有
 * `provider`/`id`/`name`/`description`/`inputModalities`），记录下来也无处安放。
 */
export interface TraeCnWorkFallbackModel {
  /** 模型 ID（原样进请求体的 `model_name`）。 */
  id: string
  /** 展示名（真机 `display_name`）。 */
  name: string
  /** 是否接受图片输入（真机 `multimodal`）。 */
  supportsImages: boolean
  /**
   * 上下文窗口（真机 `context_window_tokens.dev`）。
   *
   * 取 **dev 档**而非 max 档，与 IDE 路径同口径：dev 是客户端默认实际使用的
   * 窗口，而 `resolveModel` 声明的窗口会被 DSH 用来决定何时压缩上下文 ——
   * 按理论上限声明会让压缩迟迟不触发。
   *
   * ⚠️ 真机里 `qwen-3.6-plus` / `qwen-3.5` 的 `max` 是 **0**（未标定），
   * `dev` 均为 200000，故 dev 档同时也是唯一可用的一档。
   */
  contextWindow: number
  /**
   * 消耗倍率（真机 `features` JSON 里的 `consumption_rate.data.rate`）。
   *
   * **刻意只记录、不展示**：DSH 的 `LlmModelInfo` 没有放自定义元数据的位置，
   * 塞进 `description` 会污染模型选择器文案（用户看到「GLM-5.1 ×0.83」这种
   * 非描述性文字）。与 IDE 路径的 `TraeCnRemoteModel.consumptionRate` 同处置。
   */
  consumptionRate: number
}

/**
 * 静态模型目录 —— **真机 12 项**（2026-09-18）。
 *
 * ## 与 IDE 池的关系：**完全不重合**
 *
 * IDE 池是 16 项 `chat_v3` 代际（`Doubao-Seed-Evolving` / `glm-5.3` /
 * `kimi-k3` / `qwen3.8-max` …），Work 池是 12 项 SOLO 代际
 * （`glm-5.1` / `kimi-k2.6` / `DeepSeek-V4-Pro` …）。**两池只有
 * `Doubao-Seed-Code` 一个同名 id**，且它在两边的展示名与倍率都不同
 * （IDE 展示 `Seed-Code`，Work 同样 `Seed-Code` 但上下文窗口不同）。
 * 这直接印证了「两个池是不同代际的目录」这条判断。
 *
 * ## 为什么是「兜底表」而不是「权威表」
 *
 * 与 IDE 路径**相反**：Work 的目录端点**真的可用**（真机 200，12 项全回）。
 * 故 `fetchRemoteModels` **已接线**，远端是权威来源，本表只在远端整体失败时顶替。
 * 两表字段一致（都来自同一次真机响应的同一批字段），故切换不会产生口径差。
 *
 * ## 倍率实测值与任务书简报的差异（以**实测**为准）
 *
 * 简报里记的是 `DeepSeek-V4-Pro 0.72` / `DeepSeek-V4-Flash 0.16` /
 * `qwen-3.5-plus` / `qwen-3.6-plus`；真机响应里是 **0.36 / 0.08**，
 * 且 id 为 `qwen-3.5` / `qwen-3.6-plus`（展示名 `Qwen3.5-Plus` / `Qwen3.6-Plus`）。
 * 本表按**真机响应逐字**写，不以简报为准。
 */
export const TRAE_CN_WORK_FALLBACK_MODELS: readonly TraeCnWorkFallbackModel[] = [
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao-Seed-2.0-Code', supportsImages: true, contextWindow: 184_000, consumptionRate: 0.39 },
  { id: 'Doubao-Seed-Code', name: 'Seed-Code', supportsImages: true, contextWindow: 184_000, consumptionRate: 0.06 },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', supportsImages: false, contextWindow: 200_000, consumptionRate: 0.27 },
  { id: 'glm-5.1', name: 'GLM-5.1', supportsImages: false, contextWindow: 200_000, consumptionRate: 0.83 },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', supportsImages: true, contextWindow: 200_000, consumptionRate: 0.51 },
  { id: 'glm-5', name: 'GLM-5', supportsImages: false, contextWindow: 200_000, consumptionRate: 0.7 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', supportsImages: false, contextWindow: 200_000, consumptionRate: 0.36 },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash', supportsImages: false, contextWindow: 200_000, consumptionRate: 0.08 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', supportsImages: true, contextWindow: 200_000, consumptionRate: 0.75 },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', supportsImages: true, contextWindow: 200_000, consumptionRate: 0.48 },
  { id: 'qwen-3.6-plus', name: 'Qwen3.6-Plus', supportsImages: true, contextWindow: 200_000, consumptionRate: 0.26 },
  { id: 'qwen-3.5', name: 'Qwen3.5-Plus', supportsImages: true, contextWindow: 200_000, consumptionRate: 0.26 },
]

/**
 * 真机默认模型 id（`is_default: true` 的那一项）。
 *
 * 仅用于诊断与测试断言；请求体的 `model_name` 恒取调用方给的 `options.model`，
 * **不**在这里做默认值填充（DSH 已按模型选择器决定目标模型，适配器再兜一次
 * 会与 DSH 的口径分叉）。
 */
export const TRAE_CN_WORK_DEFAULT_MODEL = 'Doubao-Seed-Code'

/**
 * Trae CN Work 产品配置。
 *
 * 与 `TraeCnProduct` / `BuddyProduct` / `LobsteraiProduct` **平行**，字段只保留
 * Work 实际需要的三个：注册路由名、展示名、上游基址。
 */
export interface TraeCnWorkProduct {
  /**
   * provider 标识：注册到 `ctx.llm` 的路由名，也是模型黑名单的键。
   *
   * **带连字符**，与 `trae-cn` 同风格。它**不能**直接派生 cordis 服务名
   * （`trae-cn-workAuth` 不是合法的标识符风格）—— 但本 provider **不注册
   * 独立 auth 服务**（见 {@link TraeCnWorkProduct.poolProviderId}），
   * 故没有服务名可派生。
   */
  id: 'trae-cn-work'
  /** 模型选择器 / 设置页展示名。 */
  displayName: string
  /**
   * 模型选择器里的 provider 描述。
   *
   * 由 `registerConfigurableProviders` 的 `description` 字段承载，向用户说明
   * 「这个 provider 走的是另一条协议、扣的是另一个池」——这是本 provider 存在
   * 的唯一理由，不写用户无法从 UI 分辨它与 `trae-cn` 的区别。
   */
  description: string
  /** 上游基址（不含路径）。 */
  apiBase: string
  /**
   * **账号池的 provider 键**（不是 `id`！）。
   *
   * ## 这是本 provider 唯一的非常规接线，改错会静默失效
   *
   * Work **没有独立登录**：账号、凭据（`TRAE_CN_ACCOUNT_*`）、限流切换全部
   * 复用 `trae-cn` 那一套（同一批 Trae CN 账号）。故：
   *
   * | 用途 | 取值 |
   * |---|---|
   * | 注册到 `ctx.llm` 的路由名 / settingsNs / 模型黑名单 | `id` = `trae-cn-work` |
   * | **账号池查询**（`getAvailableAccount` / `findAccountIdByCredential` / `updateModelRateLimit`） | 本字段 = `trae-cn` |
   *
   * 两者**必须分开**，且**不能互相顶替**：
   * - 池查询若用 `id`：账号条目的 `provider` 字段是 `trae-cn`，按
   *   `trae-cn-work` 过滤**一个账号都匹配不到** → 适配器每次都拿到
   *   `MISSING_CREDENTIAL`（「请先登录」），而账号明明在列表里；
   * - 路由名若用 `poolProviderId`：`trae-cn-work` 这个 provider 根本不会
   *   出现在模型选择器里。
   *
   * 两个方向的错误**都是静默的**（不报错，只是查不到/不出现），故在类型上
   * 显式命名、在 AGENTS.md 里单独登记。
   */
  poolProviderId: string
}

/** Trae CN Work provider 配置。 */
export const TRAE_CN_WORK: TraeCnWorkProduct = {
  id: 'trae-cn-work',
  displayName: 'Trae CN Work',
  description: 'TraeWork 网页协议，消耗 Work 专属积分池',
  apiBase: TRAE_CN_WORK_API_BASE,
  // 复用 trae-cn 的账号池：同一批账号、同一份 TRAE_CN_ACCOUNT_* 凭据、
  // 同一套限流切换。Work 无独立登录，故**不注册独立 auth 服务**。
  poolProviderId: 'trae-cn',
}

/** 全部 Trae CN Work 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_TRAE_CN_WORK_PRODUCTS: readonly TraeCnWorkProduct[] = [TRAE_CN_WORK]

/**
 * 按 provider id 取 Work 产品配置；未知 id 返回 undefined。
 *
 * 与 `traeCnProductById` 分开：两者返回**不同类型**（Work 配置没有
 * `clientId` / `serviceName` 等字段），合并会让调用方拿到联合类型。
 */
export function traeCnWorkProductById(id: string): TraeCnWorkProduct | undefined {
  return ALL_TRAE_CN_WORK_PRODUCTS.find((product) => product.id === id)
}
