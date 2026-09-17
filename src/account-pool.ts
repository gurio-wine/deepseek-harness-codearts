import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'
import type {
  CodeArtsCredential,
  ProviderAccountEntry,
  ProviderAccountStatus,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    accountPool: AccountPool
  }
}

/** Jet Hub schema namespace（必须在 ctx.settings 中注册后才能读写） */
export const JET_HUB_NS = 'jet-hub'

/**
 * 模型黑名单：provider id → **被关闭**的模型 id 列表。
 *
 * 采用**黑名单制**：只有出现在这里、且 `disabled` 为 true 的模型会被隐藏，
 * 未记录的模型一律视为默认打开。这样服务端新增模型时无需任何配置即自动可见，
 * 不会像白名单那样把新模型静默挡在门外。
 */
export type ModelDisableMap = Record<string, Record<string, boolean>>

/** 账号池在 settings 中存储的值结构。 */
interface JetHubSettingsValue {
  accounts?: ProviderAccountEntry[]
  /** 模型黑名单（见 {@link ModelDisableMap}）。 */
  disabledModels?: ModelDisableMap
}

/** ctx.settings.register() 返回的 owner scope（只用到 get/replace）。 */
interface SettingsScopeLike {
  get(): unknown
  replace(section: object): Promise<void>
}

/** ctx.settings 服务的最小接口。schema 必须是 schemastery schema。 */
interface SettingsServiceLike {
  register(ns: string, schema: unknown): SettingsScopeLike
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; value: unknown }>
}

/**
 * Jet Hub 的 settings schema。
 *
 * 必须是 **schemastery schema**，不能是裸函数。schemastery 对象既可调用
 * （`schema(value)` 解析，满足 SettingsProvider.resolve 的用法），又有
 * `toJSON()` 与 `redactSecrets()` 所需的结构；而裸函数只有前者 ——
 * `settings.describe()` 会对每个注册项无条件调用 `schema.toJSON()`，
 * 裸函数会让整条 describe() 抛
 * `TypeError: registration.schema.toJSON is not a function`，
 * 进而使模型设置页、主题设置，以及 sidebar 的
 * `/sidebar/api/settings.get`、`/api/shell.get` 全部 500。
 *
 * 账号列表是动态结构，此处用 `Schema.array(Schema.any())` 承接，
 * 单项字段由 AccountPool 自身在读写时保证。
 */
const jetHubSchema = Schema.object({
  accounts: Schema.array(Schema.any()).default([]),
  // 模型黑名单：对象（provider id → 模型 id → boolean）而非数组。
  //
  // 为什么用 `Schema.dict(Schema.any())` 而不是 `Schema.array(...)`：与账号
  // 列表同理，单项字段由 AccountPool 自身在读写时保证；这里只需让 settings
  // 的 schema 校验不把动态结构（任意 provider、任意模型 id）拒之门外。
  //
  // 为什么带 `.default({})`：namespace 首次注册时配置文件里没有该字段，
  // 没有默认值的话 `scope.get()` 会返回 undefined，需在读取处层层判空。
  disabledModels: Schema.dict(Schema.any()).default({}),
})

/**
 * 空黑名单的共享只读实例。
 *
 * 适配器的 `listModels` 每次都会被模型目录调用，绝大多数 provider/时刻都
 * 没有黑名单；共享同一个冻结集合可以避免每次调用都分配一个新 Set。
 */
const EMPTY_MODEL_SET: ReadonlySet<string> = new Set<string>()

/**
 * 把 settings 里读到的原始值归一化为 {@link ModelDisableMap}。
 *
 * 配置文件可能被手工编辑过，也可能残留老版本格式（如数组），因此这里
 * 逐层校验：任何一层不是对象就丢弃那一层，只保留"provider → 模型 → true"
 * 这种合法结构，其余一律忽略而不是抛错——设置页读不出黑名单不该让整个
 * 账号管理功能不可用。
 */
function sanitizeDisabledModels(raw: unknown): ModelDisableMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: ModelDisableMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, boolean> = {}
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      // 只把显式 true 视为"关闭"；false / 其他值既不算关闭，也不写回内存，
      // 避免 `disabledModelsFor` 的判定与配置文件内容产生分歧。
      if (flag === true) perProvider[modelId] = true
    }
    // 空表不保留：让配置文件里不留 `{ provider: {} }` 这类无意义噪音。
    if (Object.keys(perProvider).length > 0) result[provider] = perProvider
  }
  return result
}

/**
 * AccountPool —— 多账号管理核心
 *
 * 职责：
 * - 账号列表 CRUD（索引存于 ctx.settings namespace jet-hub
 *   → 配置文件，凭据存于 ctx.credentials，各自独立）
 * - 获取指定 provider + 模型的下一个可用账号
 *   算法：enabled=true 且模型不在重置期内 → 取第一个
 * - 更新模型重置时间（收到限流错误后调用）
 *
 * 注意：DSH 的 settings 服务要求 namespace 先注册再读写，
 * 因此构造时调用 ctx.settings.register(JET_HUB_NS, schema)。
 * 注册失败（服务缺失）时退化为内存态，保证不抛错。
 */
export class AccountPool {
  /** 已注册的 settings scope；未注册成功时为 undefined。 */
  private scope: SettingsScopeLike | undefined
  /**
   * 账号列表的**权威进程内副本**。
   *
   * 不直接依赖 `scope.get()`：settings 服务的 resolved 快照在 replace() 后
   * 未必立即更新，而本类的每次写入都是「读 → 改 → 整体 replace」。
   * 若以滞后快照为读源，并发/连续的 updateModelRateLimit 会互相覆盖
   * （典型表现：多个账号触发限流后，settings.yaml 里一条 modelRateLimits
   * 都没有）。因此首次从 scope 载入后，这份副本即为唯一读源。
   */
  private cache: ProviderAccountEntry[] = []
  /**
   * 模型黑名单的**权威进程内副本**（与 {@link cache} 同理：settings 的
   * resolved 快照在 replace() 后未必立即更新，因此加载一次后即以本副本为准）。
   */
  private modelCache: ModelDisableMap = {}
  /** 是否已从 settings scope 完成首次载入。 */
  private loaded = false

  constructor(private readonly ctx: Context) {
    const settings = this.ctx.get('settings') as SettingsServiceLike | undefined
    if (!settings || typeof settings.register !== 'function') {
      this.ctx.logger?.warn?.('[jet-hub] settings 服务不可用，账号列表仅存在于内存中')
      return
    }
    try {
      this.scope = settings.register(JET_HUB_NS, jetHubSchema)
    } catch (error) {
      // 重复注册（如插件热重载）时降级为内存态。
      this.ctx.logger?.warn?.(`[jet-hub] settings namespace 注册失败，降级运行: ${String(error)}`)
    }
  }

  /** 首次访问时从 settings scope 载入账号列表。 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.scope) return
    const value = this.scope.get() as JetHubSettingsValue | undefined
    const accounts = value?.accounts
    if (Array.isArray(accounts)) {
      this.cache = accounts as ProviderAccountEntry[]
    } else {
      this.ctx.logger?.warn?.(
        `[jet-hub] 账号列表首次载入为空（scope 返回 ${JSON.stringify(value)}）`,
      )
    }
    // 黑名单是后来才加入的字段：老配置文件里没有它，缺失时保持空表
    // （等价于"全部模型默认打开"），而不是报错或让整次载入失败。
    this.modelCache = sanitizeDisabledModels(value?.disabledModels)
  }

  /** 读取账号列表（进程内权威副本）。 */
  private readAccounts(): ProviderAccountEntry[] {
    this.ensureLoaded()
    return this.cache
  }

  /**
   * 持久化账号列表（同时更新进程内权威副本）。
   *
   * **必须连同黑名单一起写回**：settings 的 `replace()` 是整体替换，
   * 只写 `{ accounts }` 会把同一 namespace 下的 `disabledModels` 抹掉。
   */
  private async writeAccounts(accounts: ProviderAccountEntry[]): Promise<void> {
    this.cache = accounts
    this.loaded = true
    if (!this.scope) {
      this.ctx.logger?.warn?.('[jet-hub] 无 settings scope，账号变更未持久化')
      return
    }
    await this.scope.replace({ accounts, disabledModels: this.modelCache })
  }

  /**
   * 读取某 provider 的模型黑名单（被关闭的模型 id 集合）。
   *
   * 适配器只调用这一个方法，因此进程内副本就是它们的读源：设置页改开关
   * 后，下一次 `listModels` 立即生效，无需重启或重新注册适配器。
   */
  disabledModelsFor(provider: string): ReadonlySet<string> {
    this.ensureLoaded()
    const perProvider = this.modelCache[provider]
    if (perProvider === undefined) return EMPTY_MODEL_SET
    const disabled = Object.keys(perProvider).filter((id) => perProvider[id] === true)
    return disabled.length > 0 ? new Set(disabled) : EMPTY_MODEL_SET
  }

  /**
   * 列出某 provider 的模型黑名单，供设置页渲染开关。
   *
   * 返回**全部键**（含显式设为 false 的），以便 UI 区分"从未设置过"与
   * "曾被关闭又打开"——两者对用户都是"开"，但保留记录便于排查。
   */
  listDisabledModels(provider: string): Record<string, boolean> {
    this.ensureLoaded()
    return { ...(this.modelCache[provider] ?? {}) }
  }

  /**
   * 打开/关闭某个模型。
   *
   * 关闭时写入 `true`；打开时**删除该键**而不是写 `false` —— 保持黑名单
   * 里只留真正被关闭的模型，`disabledModelsFor` 的语义因此始终是
   * "键存在且为 true 即隐藏"，配置文件也不会随开关操作无限膨胀。
   */
  async setModelDisabled(provider: string, modelId: string, disabled: boolean): Promise<void> {
    const next: ModelDisableMap = { ...this.modelCache }
    const perProvider = { ...(next[provider] ?? {}) }
    if (disabled) perProvider[modelId] = true
    else delete perProvider[modelId]
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    await this.writeModels(next)
  }

  /** 持久化模型黑名单（同时更新进程内权威副本）。 */
  private async writeModels(disabledModels: ModelDisableMap): Promise<void> {
    this.modelCache = disabledModels
    this.loaded = true
    if (!this.scope) {
      this.ctx.logger?.warn?.('[jet-hub] 无 settings scope，模型黑名单变更未持久化')
      return
    }
    // 与 writeAccounts 对称：整体 replace 必须携带账号列表，否则会被清空。
    await this.scope.replace({ accounts: this.cache, disabledModels })
  }

  /** 列出某个 provider 的所有账号（含状态信息） */
  async listAccounts(provider: string): Promise<ProviderAccountStatus[]> {
    const filtered = this.readAccounts().filter(a => a.provider === provider)
    const results: ProviderAccountStatus[] = []
    for (const entry of filtered) {
      const status: ProviderAccountStatus = { ...entry }
      try {
        const info = await this.ctx.credentials.describe(credentialRef(entry.credentialRef))
        status.source = info.source
      } catch {
        // 凭据可能已被外部删除
      }
      results.push(status)
    }
    return results
  }

  /** 列出所有 provider 的账号 */
  async listAllAccounts(): Promise<ProviderAccountEntry[]> {
    return this.readAccounts()
  }

  /**
   * 清理「凭据域名与当前产品配置不符」的账号。
   *
   * 用途：WorkBuddy provider 从中国版（copilot.tencent.com）改造为国际版
   * （www.workbuddy.ai）后，旧账号存的仍是中国版凭据 —— 它们的
   * `token.domain` 指向旧端点，用新 endpoint 发请求必然失败（且会一直续期失败）。
   * 这类条目已无修复价值，直接删除，让用户在 Jet Hub 重新登录。
   *
   * 判据是**凭据里记录的 domain 与产品配置的 apiDomain 不一致**（而不是简单按
   * provider 名删），这样只清理真正失配的条目，不会误删已在新端点登录的账号。
   *
   * @returns 被删除的账号 id 列表（供调用方记日志）。
   */
  async pruneAccountsWithForeignDomain(product: BuddyProduct): Promise<string[]> {
    const removed: string[] = []
    for (const entry of this.readAccounts()) {
      if (entry.provider !== product.id) continue
      let domain = ''
      try {
        const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
        if (resolved === undefined) continue
        const parsed = JSON.parse(resolved.value) as { domain?: unknown }
        domain = typeof parsed.domain === 'string' ? parsed.domain : ''
      } catch {
        // 凭据缺失或损坏：留给「凭据未配置」的正常报错路径处理，这里不删
        continue
      }
      // domain 为空表示历史凭据未记录域名，无法判定，保守保留。
      if (domain.length === 0) continue
      if (domain !== product.apiDomain) {
        await this.removeAccount(entry.id)
        removed.push(entry.id)
      }
    }
    return removed
  }

  /** 添加新账号（登录成功后调用） */
  async addAccount(entry: ProviderAccountEntry): Promise<void> {
    const accounts = [...this.readAccounts(), entry]
    await this.writeAccounts(accounts)
  }

  /** 更新账号部分字段 */
  async updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'nickname' | 'enabled' | 'expiresAt' | 'refreshable'>>,
  ): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === id)
    if (idx === -1) throw new Error(`Account ${id} not found`)
    const next = [...accounts]
    next[idx] = { ...next[idx], ...patch }
    await this.writeAccounts(next)
  }

  /** 删除账号（同时清理凭据） */
  async removeAccount(id: string): Promise<void> {
    const accounts = this.readAccounts()
    const entry = accounts.find(a => a.id === id)
    if (!entry) return
    try {
      await this.ctx.credentials.unset(credentialRef(entry.credentialRef))
    } catch { /* 凭据可能已被删除 */ }
    await this.writeAccounts(accounts.filter(a => a.id !== id))
  }

  /**
   * 按凭据内容反查账号 id（供适配器记录"当前用的是哪个账号"）。
   *
   * 适配器不持有 ctx，也不该直接访问本类的私有凭据存储，
   * 因此这里集中做「遍历已启用账号 → 解析凭据 → 比对标识字段」。
   * @param provider - provider 名称（'buddy' | 'workbuddy' | 'codearts'）。
   * @param identity - 比对用的标识值：CodeBuddy 系传 access_token，CodeArts 传 access_key_id。
   * @returns 匹配到的账号 id；无匹配返回空串。
   */
  async findAccountIdByCredential(provider: string, identity: string): Promise<string> {
    if (identity.length === 0) return ''
    // 凭据中的唯一标识字段：CodeBuddy 系（buddy / workbuddy）用 access_token，
    // CodeArts 用 access_key_id。选错字段会导致匹配恒失败，限流记录无法归属账号。
    const identifierKey = provider === 'codearts' ? 'access_key_id' : 'access_token'
    for (const entry of this.readAccounts()) {
      if (entry.provider !== provider || !entry.enabled) continue
      const resolved = await this.resolveCredentialByRef(entry.credentialRef)
      if (resolved === undefined) continue
      if (resolved[identifierKey] === identity) return entry.id
    }
    return ''
  }

  /** 解析某个 credentialRef 下的凭据 JSON；不可用时返回 undefined。 */
  private async resolveCredentialByRef(refName: string): Promise<Record<string, unknown> | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(refName))
      if (!resolved) return undefined
      const parsed = JSON.parse(resolved.value) as unknown
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }

  /** 按 id 查找账号条目（含已停用账号）。 */
  findAccount(id: string): ProviderAccountEntry | undefined {
    return this.readAccounts().find(a => a.id === id)
  }

  /** 列出某 provider 的全部账号（含已停用），供「重测所有 / 重置所有」使用。 */
  listAccountsByProvider(provider: string): ProviderAccountEntry[] {
    return this.readAccounts().filter(a => a.provider === provider)
  }

  /**
   * 按账号 id 解析凭据（**不检查 enabled**）。
   *
   * 限流重测必须能对已停用账号发请求（用户明确要求"停用的账号也能发送"），
   * 因此这里刻意与 {@link getAvailableAccount} 的过滤条件区分开：自动选择
   * 只认启用账号，而按 id 的显式探测认全部账号。
   * @returns 凭据对象；账号不存在或凭据不可用时返回 undefined。
   */
  async resolveCredentialForAccount(
    id: string,
  ): Promise<CodeArtsCredential | BuddyCredential | undefined> {
    const entry = this.findAccount(id)
    if (entry === undefined) return undefined
    const parsed = await this.resolveCredentialByRef(entry.credentialRef)
    if (parsed === undefined) return undefined
    return parsed as unknown as CodeArtsCredential | BuddyCredential
  }

  /**
   * 清除限流标记。
   *
   * @param accountId - 目标账号。
   * @param modelIds - 要清除的模型；省略时清除该账号的**全部**标记。
   * @returns 实际清除的标记数。
   */
  async clearModelRateLimits(accountId: string, modelIds?: readonly string[]): Promise<number> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) return 0
    const entry = accounts[idx]
    const current = entry.modelRateLimits
    if (!current || Object.keys(current).length === 0) return 0

    const limits = { ...current }
    let removed = 0
    const targets = modelIds ?? Object.keys(limits)
    for (const modelId of targets) {
      if (Object.prototype.hasOwnProperty.call(limits, modelId)) {
        delete limits[modelId]
        removed++
      }
    }
    if (removed === 0) return 0

    const next = [...accounts]
    const updated = { ...entry }
    // 清空后删除字段本身，避免 settings 里留下空对象噪音。
    if (Object.keys(limits).length === 0) delete updated.modelRateLimits
    else updated.modelRateLimits = limits
    next[idx] = updated
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 已清除限流标记: 账号 ${accountId} 模型 ${targets.join(', ')}（共 ${removed} 条）`,
    )
    return removed
  }

  /**
   * 获取指定 provider + 模型的下一个可用账号。
   *
   * `modelId` 为空串时**不做限流过滤**——调用方（provider 的
   * resolveCredential 入口）此时还不知道要发哪个模型，只能退化为
   * "任取一个启用账号"。但 `enabled` 过滤在任何情况下都生效：
   * 停用账号绝不参与自动选择，空 modelId 也不例外。
   *
   * @param provider - provider id（`this.product.id`，不要写死字面量）
   * @param modelId - 目标模型；空串表示不按模型过滤
   * @param excludeAccountIds - 需要跳过的账号 id。
   *
   * **为什么需要 `excludeAccountIds`**：调用方在「请求级轮换」时会逐个换号
   * 重试，必须能拿到**下一个**账号而不是每次都拿回同一个。
   * 本池默认按「重置时间最早到期」排序，当失败类别**不写限流标记**时
   * （如 5xx / 请求错误 —— 它们不是限流，不该留徽章），
   * 刚失败的账号仍是排序第一，调用方若不排除它就会原地打转、
   * 换号形同虚设。Go 侧对应的是 `PickExcluding(tried)`（`pool.go:131`）。
   *
   * 在池这一层排除（而非让调用方自己跳过）是必要的：调用方只能拿到
   * 「池认为最优的一个」，无法枚举候选自己去重。
   */
  async getAvailableAccount(
    provider: string,
    modelId: string,
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<{ entry: ProviderAccountEntry; credential: CodeArtsCredential | BuddyCredential } | null> {
    const candidates = this.readAccounts()
      .filter(a => a.provider === provider && a.enabled)
      .filter(a => excludeAccountIds === undefined || !excludeAccountIds.has(a.id))
      .filter(a => {
        // 空 modelId（未知目标模型）：无可比对的键，保持候选不变。
        if (modelId.length === 0) return true
        if (!a.modelRateLimits) return true
        const resetAt = a.modelRateLimits[modelId]
        return resetAt === undefined || resetAt === 0 || Date.now() >= resetAt
      })
    if (candidates.length === 0) return null
    // 优先选择无限制或限制最早到期的
    candidates.sort((a, b) => {
      const ra = a.modelRateLimits?.[modelId] ?? 0
      const rb = b.modelRateLimits?.[modelId] ?? 0
      return ra - rb
    })
    // 逐个尝试解析凭据，跳过占位/损坏条目（并记录原因，避免静默失败）
    const failures: string[] = []
    for (const entry of candidates) {
      let resolved
      try {
        resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      } catch (error) {
        failures.push(`${entry.id}: 读取凭据失败 (${String(error)})`)
        continue
      }
      if (!resolved) {
        failures.push(`${entry.id}: 凭据未配置`)
        continue
      }
      try {
        const credential = JSON.parse(resolved.value) as CodeArtsCredential | BuddyCredential
        if (failures.length > 0) {
          this.ctx.logger?.warn?.(
            `[jet-hub] ${failures.length} 个 ${provider} 账号不可用，已跳过：${failures.join('; ')}`,
          )
        }
        return { entry, credential }
      } catch (error) {
        failures.push(`${entry.id}: 凭据 JSON 损坏 (${String(error)})`)
        continue
      }
    }
    if (failures.length > 0) {
      this.ctx.logger?.warn?.(
        `[jet-hub] 没有可用的 ${provider} 账号：${failures.join('; ')}`,
      )
    }
    return null
  }

  /**
   * 更新某账号某模型的重置时间。
   *
   * 关键：基于**读取到的最新账号列表**做局部合并，再把整个列表写回。
   * settings scope 的 get() 返回的是服务内部快照，可能滞后于磁盘；
   * 但 replace() 是整体替换，因此这里每次都在最新快照上合并，
   * 避免"写 A 的限流 → 读旧快照 → 写 B 的限流"把 A 的记录抹掉。
   */
  async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number): Promise<void> {
    const accounts = this.readAccounts()
    const idx = accounts.findIndex(a => a.id === accountId)
    if (idx === -1) {
      this.ctx.logger?.warn?.(
        `[jet-hub] updateModelRateLimit: 账号 ${accountId} 不在账号列表中（已知: ${accounts.map(a => a.id).join(', ') || '空'}）`,
      )
      return
    }
    const next = [...accounts]
    const entry = { ...next[idx] }
    entry.modelRateLimits = { ...entry.modelRateLimits, [modelId]: resetAtMs }
    next[idx] = entry
    await this.writeAccounts(next)
    this.ctx.logger?.info?.(
      `[jet-hub] 已记录限流: 账号 ${accountId} 模型 ${modelId} 重置于 ${new Date(resetAtMs).toISOString()}`,
    )
  }

  /** 清理已过期的重置时间记录 */
  async sweepExpiredRateLimits(): Promise<void> {
    const accounts = this.readAccounts()
    let changed = false
    const next = accounts.map((entry) => {
      if (!entry.modelRateLimits) return entry
      const limits = { ...entry.modelRateLimits }
      for (const [modelId, resetAtMs] of Object.entries(limits)) {
        if (resetAtMs > 0 && Date.now() >= resetAtMs) {
          delete limits[modelId]
          changed = true
        }
      }
      return { ...entry, modelRateLimits: limits }
    })
    if (changed) await this.writeAccounts(next)
  }
}
