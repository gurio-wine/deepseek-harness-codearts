/**
 * CodeBuddy 系产品配置。
 *
 * 这些产品同源：共用同一 CLI 内核、同一认证协议（cli-external-link）与同一套
 * ProductProvider 机制，差异全部收敛到这里，使多个 provider 共用一套实现。
 *
 * 实测依据（2026-09-14，逆向各产品 cli/product.json + 真实请求）：
 *
 * | 产品              | endpoint                    | platform       | genieVersion |
 * |-------------------|-----------------------------|----------------|--------------|
 * | CodeBuddy（中国） | https://copilot.tencent.com | ide            | —            |
 * | WorkBuddy（国际） | https://www.workbuddy.ai    | workbuddy-ai   | 5.5.2        |
 *
 * 关于「模型列表为何不能共用」：两者的**路径与响应解析完全相同**
 * （`GET /v3/config` → `data.data.models` / `data.data.agents`），
 * 差异只来自 endpoint —— 不同区域的后端返回不同的模型池
 * （中国版含 glm/hy/deepseek 系，国际版含 claude/gpt/gemini/kimi 系）。
 * 因此 endpoint 必须随产品切换，不能被当成全局常量。
 *
 * 迁移关系（重要）：
 * 本模块中与 `src/buddy.ts` / `src/buddy-auth.ts` 重名的取值，将从后者**迁移**到
 * 本模块，由本模块作为唯一真相源（single source of truth）。在后续参数化任务完成、
 * 旧常量被删除之前，本模块的这些字面量必须与 `src/buddy.ts` / `src/buddy-auth.ts`
 * 中的对应常量**保持完全一致**：任何一处取值变更都必须同步另一处，否则各产品的
 * 认证/请求行为会分叉。
 *
 * 之所以此处仍写死字面量而不 import 常量：`buddy-auth.ts` 后续任务将改为
 * `import product.ts`，若本模块反向 import `buddy-auth.ts` 会形成循环依赖；
 * 为保持一致性，这些字段全部维持字面量写法。
 */

/** 兜底模型目录中的一个条目（字段对齐远端 `/v3/config` 的 `data.models[]`）。 */
export interface BuddyFallbackModel {
  id: string
  name: string
  /** 上下文窗口（对应远端 `maxInputTokens`）。 */
  contextWindow?: number
  /** 是否接受图片输入（对应远端 `supportsImages`）。 */
  supportsImages?: boolean
  /** 可选思考等级（对应远端 `reasoning.supportedEfforts`）。 */
  reasoningEfforts?: readonly string[]
  /** 默认思考等级（对应远端 `reasoning.defaultEffort`）。 */
  defaultReasoningEffort?: string
}

/** 一条「模型族 → User-Agent」覆盖规则。 */
export interface BuddyUserAgentRule {
  /** 模型 id 前缀；命中即采用本规则的 ua。 */
  match: string
  /** 命中后使用的 User-Agent。 */
  ua: string
}

/**
 * 国际版（WorkBuddy AI）模型线 → UA 分档规则。
 *
 * 判据来自 IDE 客户端形态：国际版产品名是 `WorkBuddy AI`，其客户端出站 UA
 * 遵循官方三段式 `WorkBuddy/<ver> WorkBuddy AI/<ver> CLI/<ver>`。GPT / Gemini
 * 系仅在国际版池中提供，归入国际版形态；国内系模型（glm/hy/kimi/minimax）
 * 虽在国际版池中也可见，但仍沿用国内客户端形态（`WorkBuddy/<ver> WorkBuddy/...`），
 * 与 realm 无关。
 */
const WORKBUDDY_UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const WORKBUDDY_UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'

/** 一个 CodeBuddy 系产品的全部差异配置。 */
export interface BuddyProduct {
  /** provider 标识：注册到 ctx.llm 的路由名，也是账号列表的 provider 字段值 */
  id: 'buddy' | 'workbuddy'
  /** auth/state 的 platform 查询参数 */
  platform: string
  /**
   * API endpoint（含协议），所有 `/v2/plugin/*`、`/v3/config` 与 chat 请求
   * 都以此为基址。**这是不同区域产品之间最关键的差异**：模型池由它决定。
   */
  endpoint: string
  /**
   * 用于 `X-Domain` 请求头的域名（通常等于 endpoint 的主机名）。
   * 注意与 `endpoint` 分开：历史实现里该头传的是不带协议的域名。
   */
  apiDomain: string
  /** 设置页展示名 */
  displayName: string
  /** X-Product-Code 请求头值 */
  productCode: string
  /**
   * 默认 User-Agent（无按模型分档命中时使用）。
   *
   * 腾讯后台的「使用端」列按出站 UA 归因，故该值必须**含对应产品品牌字样**
   * （`WorkBuddy/...` 或 `CodeBuddyIDE/...`），否则账单显示为 `-`。
   */
  userAgent: string
  /**
   * 按模型族覆盖 User-Agent 的规则表（先命中先返回）。
   *
   * 为什么需要按模型分档：国际版与国内版共用同一后端协议，但模型池分属不同
   * 产品线 —— 实测同一账号下，走 `gpt-*` 系与走 `glm-*` 系时官方客户端形态
   * 并不一致，后台按 UA 归因的「使用端」也随之不同。仅用一个全局 UA 无法让
   * 两类模型都归因正确。
   *
   * 匹配规则：`match` 为模型 id 前缀（大小写敏感，与模型 id 一致）；
   * 空数组或未提供时全部回退到 {@link BuddyProduct.userAgent}。
   */
  userAgentByModelFamily?: readonly BuddyUserAgentRule[]
  /**
   * 归属头名（`X-IDE-Name` / `X-IDE-Type` / `X-Product` 三头共用同一取值）。
   *
   * 注意语义：`X-Product` 是**用量归属名**，不是部署类型 —— 历史实现把它发成
   * `SaaS`（部署类型语义）导致后台归因不到产品，故此处按产品名下发。
   */
  attributionName: string
  /** `X-IDE-Version` 头取值（客户端形态版本号） */
  clientVersion: string
  /** User-Agent 第三段 `CLI/<ver>` 的版本号 */
  cliVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退） */
  defaultCredentialRef: string
  /**
   * 远端模型列表不可用时的**兜底模型目录**。
   *
   * 为什么需要它：各产品的模型池只由服务端按认证上下文下发，而插件的
   * CLI token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能
   * 拿到 13 个别名，拿不到 GPT 系列）。此表是 IDE 自身也在用的机制 ——
   * IDE 的 `product.json` 内置静态模型表，远端配置只是覆盖层。
   *
   * 取值来自 IDE 的本地缓存（`~/.workbuddy-ai/local_storage/*.info`，
   * 由 `WorkbuddyAuthProductCoordinator` 写入），即 IDE 输入框实际使用的清单。
   */
  fallbackModels?: readonly BuddyFallbackModel[]
  /**
   * 登录 URL 是否需要追加 `version` 与 `loginSessionId`。
   * CodeBuddy 不需要；WorkBuddy 需要（对齐 workbuddy-desktop 认证配置）。
   */
  appendSessionParams: boolean
  /** 追加到登录 URL 的版本号（appendSessionParams 为 true 时使用） */
  pluginVersion?: string
}

/**
 * CodeBuddy（腾讯 CodeBuddy，中国版），platform = ide。
 *
 * 以下字段与既有常量重复，属**待删除的重复定义**（等后续参数化任务把
 * `src/buddy.ts` / `src/buddy-auth.ts` 改为从本模块取值后即可删除）：
 * - `platform: 'ide'`          ↔ `src/buddy.ts:24`  `PLATFORM`
 * - `productCode: 'codebuddy'` ↔ `src/buddy.ts:79`  `BUDDY_PRODUCT_CODE`
 * - `userAgent: 'CodeBuddyIDE/1.106.1'` ↔ `src/buddy.ts:77`  `BUDDY_USER_AGENT`
 * - `defaultCredentialRef: 'BUDDY_ACCESS_TOKEN'` ↔ `src/buddy-auth.ts:27`  `BUDDY_CREDENTIAL_REF`
 * - `endpoint`/`apiDomain`     ↔ `src/buddy.ts:20/86`  `API_ENDPOINT` / `API_DOMAIN`
 *
 * 迁移完成前两处取值必须保持一致，改动需同步（见文件头「迁移关系」）。
 */
/**
 * CodeBuddy（中国版）的内置模型目录。
 *
 * 数据来源：`/v3/config` 的 `craft` agent 白名单，并**逐个用真实请求验证可用**
 * （`POST /v2/chat/completions`，stream 模式）。只收录实测返回可用的模型 ——
 * 远端 `data.models` 里另有一批 `code=11102 service info not found` 的条目
 * （glm-4.6/4.7/5.0、minimax-m2.5、kimi-k2.5/k2.8-preview、hunyuan-* 等），
 * 列进选择器只会让用户选中后报错，故一律不收录。
 */
const CODEBUDDY_FALLBACK_MODELS: readonly BuddyFallbackModel[] = [
  {
    id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, supportsImages: true, reasoningEfforts: ['medium'] },
]

export const CODEBUDDY: BuddyProduct = {
  id: 'buddy',
  platform: 'ide',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  displayName: 'CodeBuddy (腾讯)',
  productCode: 'codebuddy',
  userAgent: 'CodeBuddyIDE/1.106.1',
  // 中国版只有一条产品线，无需按模型分档：全部模型沿用 IDE UA。
  userAgentByModelFamily: [],
  attributionName: 'CodeBuddy',
  clientVersion: '1.106.1',
  cliVersion: '2.137.1',
  defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
  appendSessionParams: false,
  fallbackModels: CODEBUDDY_FALLBACK_MODELS,
}

/**
 * WorkBuddy 国际版的内置模型目录。
 *
 * 数据来源：IDE 的本地缓存 `~/.workbuddy-ai/local_storage/*.info`
 * （`WorkbuddyAuthProductCoordinator` 写入的 ProductManager 合并结果），
 * 即 IDE 模型选择器实际展示的清单与元数据。
 *
 * 顺序即 IDE 的展示顺序（`cli` agent 白名单顺序），不要随意重排。
 */
const WORKBUDDY_FALLBACK_MODELS: readonly BuddyFallbackModel[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176_000, supportsImages: true },
  { id: 'fast-model', name: 'Fast', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'primary-model', name: 'Primary', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['high'] },
  { id: 'deep-model', name: 'Deep', contextWindow: 176_000, supportsImages: true },
  {
    id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high'], defaultReasoningEffort: 'high',
  },
  {
    id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true,
    reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
  },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high'] },
  {
    id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  {
    id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000, supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', contextWindow: 272_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'] },
  {
    id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
  },
  {
    id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true,
    reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high',
  },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'] },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'] },
]

/**
 * WorkBuddy 国际版（腾讯 WorkBuddy AI），platform = workbuddy-ai。
 *
 * 逆向自 `C:\Users\Jet\AppData\Local\Programs\WorkBuddyAI`（5.5.2）的 cli/product.json：
 * - `applicationName` = "workbuddy-ai"
 * - `endpoint` = "https://www.workbuddy.ai"（**与中国版不同**，模型池随区域变化）
 * - `authentication.attributes.platform` = "workbuddy-ai"
 * - `prefixPath` = "/plugin"（与中国版相同）
 *
 * 该产品**没有**每日签到积分接口（内核中只有 `/v2/billing/meter/get-dosage-notify`），
 * 因此 Jet Hub 不为其渲染「一键领取积分」按钮；积分领取在 CodeBuddy 侧完成。
 */
export const WORKBUDDY: BuddyProduct = {
  id: 'workbuddy',
  platform: 'workbuddy-ai',
  endpoint: 'https://www.workbuddy.ai',
  apiDomain: 'www.workbuddy.ai',
  displayName: 'WorkBuddy (国际版)',
  productCode: 'workbuddy',
  // 默认档：国际版产品形态（无按模型命中时使用）。
  userAgent: WORKBUDDY_UA_INTL,
  userAgentByModelFamily: [
    // 国际版独有模型线（GPT / Gemini / Claude 系）→ 国际版形态。
    { match: 'gpt-', ua: WORKBUDDY_UA_INTL },
    { match: 'gemini-', ua: WORKBUDDY_UA_INTL },
    { match: 'claude-', ua: WORKBUDDY_UA_INTL },
    // 国内系模型（glm / hy / kimi / minimax）→ 国内客户端形态。
    { match: 'glm-', ua: WORKBUDDY_UA_CN },
    { match: 'hy', ua: WORKBUDDY_UA_CN },
    { match: 'kimi-', ua: WORKBUDDY_UA_CN },
    { match: 'minimax-', ua: WORKBUDDY_UA_CN },
  ],
  attributionName: 'WorkBuddy',
  clientVersion: '5.5.2',
  cliVersion: '5.5.2',
  defaultCredentialRef: 'WORKBUDDY_ACCESS_TOKEN',
  appendSessionParams: true,
  pluginVersion: '5.5.2',
  fallbackModels: WORKBUDDY_FALLBACK_MODELS,
}

/** 全部产品配置，供按 id 查询与遍历注册使用。 */
export const ALL_PRODUCTS: readonly BuddyProduct[] = [CODEBUDDY, WORKBUDDY]

/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function productById(id: string): BuddyProduct | undefined {
  return ALL_PRODUCTS.find((product) => product.id === id)
}

/**
 * 按模型 id 解析该产品应使用的 User-Agent（按模型族分档）。
 *
 * 命中规则：`userAgentByModelFamily` 中**先命中先返回**（`match` 为前缀）。
 * 未命中任何规则时回退到 `product.userAgent`。这条回退链保证新模型上线时
 * 仍有一个确定的、含产品品牌字样的 UA，不会退化成框架默认的 harness UA。
 *
 * @param product - 产品配置
 * @param model - 模型 id（如 `gpt-5.6-sol` / `glm-5.2`）
 */
export function resolveUserAgent(product: BuddyProduct, model: string): string {
  for (const rule of product.userAgentByModelFamily ?? []) {
    if (model.startsWith(rule.match)) return rule.ua
  }
  return product.userAgent
}
