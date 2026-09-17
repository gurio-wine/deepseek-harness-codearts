import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { registerCodeArtsLlm } from './llm-adapter.js'
import { registerBuddyLlm } from './buddy-adapter.js'
import { registerLobsteraiLlm } from './lobsterai-adapter.js'
import { CODEARTS_CREDENTIAL_REF, CodeArtsAuth } from './service.js'
import { BUDDY_CREDENTIAL_REF, BuddyAuth } from './buddy-auth.js'
import { LobsteraiAuth } from './lobsterai-auth.js'
import { AccountPool } from './account-pool.js'
import { registerJetHubRpc } from './jet-hub-rpc.js'
import { CODEBUDDY, WORKBUDDY } from './product.js'
import { LOBSTERAI } from './lobsterai-product.js'
import type { CodeArtsCredential, BuddyCredential } from './types.js'
import type { LobsteraiCredential } from './lobsterai.js'

export const name = 'codearts-auth'
// `connection` 刻意不列入静态 inject：它只由 Web bundle（dsh-client-connection）
// 提供，headless/CLI profile 里并不存在。静态 inject 会让本插件在那些 profile
// 里永久 pending，进而让整个 profile 以
// "plugin tree failed to load: 1 entry did not activate" 启动失败
// —— chicheng-cron 的 skill/agent 任务正是通过 `dsh --profile headless` 运行的，
// 会因此全部 exit 1。Jet Hub 的 RPC 端点在 Web 下通过 apply 内的可选注入挂载，
// 其余 profile 只是不注册该端点。
export const inject = ['credentials', 'commands', 'llm']

/**
 * Provider 配置 namespace 的 schema。
 *
 * `registerConfigurableProviders` 声明的 `settingsNs` 必须真实存在于
 * settings 服务中，否则模型设置页读到 undefined 的 namespace，
 * 在 `refFor → deriveKeyRef(provider)` 处会以
 * `provider.toUpperCase is not a function` 崩溃。
 * 两者都只需承接一个可选的 `providers` 映射，故共用同一宽松 schema。
 *
 * 注意：`settings.register()` 要求 schemastery schema —— `describe()` 会对每个
 * 注册项无条件调用 `schema.toJSON()` 与 `redactSecrets(schema, value)`。
 * 传入裸函数（`(value) => ...`）会让 `describe()` 抛
 * `TypeError: registration.schema.toJSON is not a function`，进而使所有
 * 依赖 settings 的界面（模型设置页、主题、sidebar 的 settings.get/shell.get）
 * 全部失败。因此这里必须用 `Schema.object({...})` 构造。
 */
const providerSettingsSchema = Schema.object({
  providers: Schema.dict(Schema.any()).default({}),
})

/** 注册 provider 配置 namespace（已存在时忽略重复注册错误）。 */
function registerProviderSettings(ctx: Context, ...namespaces: string[]): void {
  const settings = ctx.get('settings') as
    | {
      register: (ns: string, schema: unknown) => unknown
      describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string }>
    }
    | undefined
  if (!settings || typeof settings.register !== 'function') {
    ctx.logger.warn('[codearts-auth] settings 服务不可用，provider namespace 未注册')
    return
  }
  for (const ns of namespaces) {
    try {
      settings.register(ns, providerSettingsSchema)
    } catch (error) {
      ctx.logger.warn(`[codearts-auth] settings namespace "${ns}" 注册失败: ${String(error)}`)
    }
  }
  // 回读确认：模型设置页要求 settingsNs 真实存在于 describe() 中。
  // 注意：describe() 会遍历所有已注册 namespace 并调用各自 schema 的
  // toJSON()/redactSecrets()，任一注册项的 schema 不合规都会让整条调用抛错。
  // 因此这里必须把异常打出来，而不是静默吞掉。
  try {
    const descriptors = settings.describe?.({ redactSecrets: true }) ?? []
    const registered = descriptors.map(v => v.ns)
    const missing = namespaces.filter(ns => !registered.includes(ns))
    if (missing.length > 0) {
      ctx.logger.warn(`[codearts-auth] provider namespace 未生效: ${missing.join(', ')}`)
    }
    ctx.logger.info(`[codearts-auth] settings.describe ok, namespaces: ${registered.join(', ')}`)
  } catch (error) {
    ctx.logger.error(
      `[codearts-auth] settings.describe 失败（将导致模型设置页/sidebar settings API 不可用）: `
      + `${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    )
  }
}

/**
 * 图片附件桥接：把持久化图片读成原始字节供适配器内联。
 *
 * 用 `ctx.get` 而非 `inject` —— 附件服务缺失时 provider 仍可正常加载，
 * 只是收到图片时报 UNSUPPORTED_CONTENT。两个 CodeBuddy 系产品（CodeBuddy /
 * WorkBuddy）共用同一后端与协议，图片能力相同，故共用本实现。
 */
function makeReadImage(ctx: Context) {
  return async (attachment: unknown): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as
      { readImage?: (ref: never) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> } | undefined
    if (attachments?.readImage === undefined) return undefined
    try {
      const stored = await attachments.readImage(attachment as never)
      return { data: stored.data, mediaType: stored.ref.mediaType }
    } catch {
      return undefined
    }
  }
}

/** 注册 codeartsAuth 服务、命令以及 codearts LLM 路由。 */
export function apply(ctx: Context): void {
  // provider 的 settingsNs 必须已注册，否则模型设置页会因未注册 namespace 崩溃。
  // 四个 namespace 分别对应：codearts 路由、CodeBuddy（buddy）路由、
  // WorkBuddy（workbuddy）路由、LobsterAI（lobsterai）路由 —— 后三者由
  // registerBuddyLlm / registerLobsteraiLlm 以 `llm-${product.id}` 派生，
  // 漏注册会让模型设置页在 `refFor → deriveKeyRef(provider)` 处以
  // `provider.toUpperCase is not a function` 崩溃。
  registerProviderSettings(ctx, 'llm-buddy', 'llm-workbuddy', 'llm-codearts', 'llm-lobsterai')
  const service = new CodeArtsAuth(ctx)
  const pool = new AccountPool(ctx)

  // WorkBuddy provider 已从中国版（copilot.tencent.com）改造为国际版
  // （www.workbuddy.ai）。旧账号存的是中国版凭据，其 token.domain 指向旧端点，
  // 用新 endpoint 发请求必然失败且会一直续期失败，故启动时清理掉。
  // 判据是「凭据 domain ≠ 产品 apiDomain」，只清真正失配的条目。
  void pool.pruneAccountsWithForeignDomain(WORKBUDDY).then((removed) => {
    if (removed.length > 0) {
      ctx.logger.info(
        `[jet-hub] 已清理 ${removed.length} 个 WorkBuddy 旧版（中国版）账号，请重新登录：${removed.join(', ')}`,
      )
    }
  }).catch((error: unknown) => {
    ctx.logger.warn(`[jet-hub] 清理 WorkBuddy 旧版账号失败：${String(error)}`)
  })

  ctx.commands.register({
    name: 'codearts-login',
    description: '通过浏览器 OAuth 登录华为云 CodeArts',
    handler: async (): Promise<CommandResult> => {
      try {
        const result = await service.login()
        return {
          kind: 'success',
          text: `CodeArts 登录完成。凭据已存储于 ${String(result.ref)}；过期时间 ${new Date(result.expires).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-status',
    description: '显示 CodeArts 登录状态及刷新能力',
    handler: async (): Promise<CommandResult> => {
      const status = await service.status()
      return {
        kind: 'success',
        text: [
          `已配置: ${status.configured}`,
          ...status.source === undefined ? [] : [`来源: ${status.source}`],
          ...status.expiresAt === undefined ? [] : [`过期时间: ${new Date(status.expiresAt).toISOString()}`],
          `可刷新: ${status.refreshable}`,
          ...status.refreshError === undefined ? [] : [`刷新错误: ${status.refreshError}`],
        ].join('\n'),
      }
    },
  })
  ctx.commands.register({
    name: 'codearts-refresh',
    description: '静默刷新 CodeArts 凭据',
    handler: async (): Promise<CommandResult> => {
      try {
        await service.refresh()
        const status = await service.status()
        return {
          kind: 'success',
          text: `CodeArts 凭据已刷新；过期时间 ${status.expiresAt === undefined ? '未知' : new Date(status.expiresAt).toISOString()}。`,
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
  registerCodeArtsLlm(ctx, {
    credentialRef: credentialRef(CODEARTS_CREDENTIAL_REF),
    resolveCredential: async () => {
      // 优先使用账号池获取可用账号，回退到单凭据解析
      if (pool) {
        const available = await pool.getAvailableAccount('codearts', '')
        if (available) return available.credential as CodeArtsCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(CODEARTS_CREDENTIAL_REF))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as CodeArtsCredential
      } catch {
        return undefined
      }
    },
    refresh: () => service.refresh(),
    fetchRemoteModels: () => service.refreshModels(),
    accountPool: pool,
  })

  // ===== Buddy (腾讯 CodeBuddy) 服务 =====
  // 不注册斜杠命令：登录/状态/续期都在 Jet Hub 设置页完成（多账号 + 账号池），
  // 命令式的单凭据入口已无必要。
  const buddy = new BuddyAuth(ctx)
  registerBuddyLlm(ctx, {
    credentialRef: credentialRef(BUDDY_CREDENTIAL_REF),
    resolveCredential: async () => {
      // 优先使用账号池获取可用账号，回退到单凭据解析
      if (pool) {
        const available = await pool.getAvailableAccount('buddy', '')
        if (available) return available.credential as BuddyCredential
      }
      const resolved = await ctx.credentials.resolve(credentialRef(BUDDY_CREDENTIAL_REF))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    refresh: () => buddy.refresh(),
    fetchRemoteModels: () => buddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: CODEBUDDY,
  })

  // ===== WorkBuddy (腾讯 WorkBuddy) 服务 =====
  // 与 CodeBuddy 同源（同后端、同协议），差异全部由 product 配置承载。
  // 服务名由 BuddyAuth 依 product.id 派生，故两个产品分别注册为
  // ctx.buddyAuth / ctx.workbuddyAuth，互不覆盖。
  // 同样不注册斜杠命令：入口在 Jet Hub 的 WorkBuddy 面板。
  const workbuddy = new BuddyAuth(ctx, { product: WORKBUDDY })
  registerBuddyLlm(ctx, {
    credentialRef: credentialRef(WORKBUDDY.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 workbuddy 的账号池取账号，回退到 WorkBuddy 自己的单凭据 ref，
      // 保证不会串用 CodeBuddy 的凭据。
      const available = await pool.getAvailableAccount('workbuddy', '')
      if (available) return available.credential as BuddyCredential
      const resolved = await ctx.credentials.resolve(credentialRef(WORKBUDDY.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as BuddyCredential
      } catch {
        return undefined
      }
    },
    refresh: () => workbuddy.refresh(),
    fetchRemoteModels: () => workbuddy.fetchModels(pool),
    readImage: makeReadImage(ctx),
    accountPool: pool,
    product: WORKBUDDY,
  })

  // ===== LobsterAI (有道龙虾) 服务 =====
  // 第三个产品线，但协议与腾讯系**完全不同**：不走 external-link 轮询登录，
  // 而是本地回调 + authCode 换 token（见 src/lobsterai-oauth.ts）。
  // 服务名由 LobsteraiAuth 依 product.id 派生，注册为 ctx.lobsteraiAuth。
  // 与其他 provider 一样不注册斜杠命令：入口在 Jet Hub 的 LobsterAI 面板。
  const lobsterai = new LobsteraiAuth(ctx)
  registerLobsteraiLlm(ctx, {
    credentialRef: credentialRef(LOBSTERAI.defaultCredentialRef),
    resolveCredential: async () => {
      // 只从 LobsterAI 自己的账号池取账号，回退到自己的单凭据 ref，
      // 保证不会串用 CodeBuddy / WorkBuddy / CodeArts 的凭据。
      // provider 实参用 LOBSTERAI.id 而非字面量 'lobsterai'：写死字面量在
      // 改名/多产品场景下会静默查不到账号（本插件在 workbuddy 上踩过同类坑）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) return available.credential as LobsteraiCredential
      const resolved = await ctx.credentials.resolve(credentialRef(LOBSTERAI.defaultCredentialRef))
      if (!resolved) return undefined
      try {
        return JSON.parse(resolved.value) as LobsteraiCredential
      } catch {
        return undefined
      }
    },
    refresh: async () => {
      // 必须刷新**解析凭据时所用的那一个**账号，而不是默认单凭据 ref。
      //
      // 为什么：resolveCredential（上面）优先从账号池取
      // `LOBSTERAI_ACCOUNT_XXX` 的凭据，而 `lobsterai.refresh()` 读写的是
      // `LOBSTERAI_ACCESS_TOKEN`。两者错配的后果是 —— 适配器检测到池凭据
      // 过期 → 调 refresh → 成功回写到**另一个** ref → 再 resolve 仍取到
      // 那份未更新的过期凭据 → 带着过期 token 发请求 → 401。
      // 用户看到的是「刚在 Jet Hub 登录好，却一直认证失败」，
      // 而日志里续期全是成功的，极难排查。
      //
      // 与 Go 一致：`handler.go:197-209` 也是先 Pick 出账号、再对该账号
      // `RefreshToken(acct)`（而非某个全局单例）。
      const available = await pool.getAvailableAccount(LOBSTERAI.id, '')
      if (available) await lobsterai.refreshAccountCredential(available.entry.credentialRef)
      else await lobsterai.refresh()
    },
    fetchRemoteModels: () => lobsterai.fetchModels(pool),
    resolveClientVersion: () => lobsterai.resolveClientVersion(),
    accountPool: pool,
    product: LOBSTERAI,
  })

  // ===== 多账号静默续期调度 =====
  // 替代原有的单账号 scheduleRefresh()，使用 refreshAll() 遍历所有账号续期
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000  // 每 30 分钟检查一次

  async function refreshAllCredentials(): Promise<void> {
    try {
      await service.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await buddy.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await workbuddy.refreshAll(pool)
    } catch { /* 静默 */ }
    try {
      await lobsterai.refreshAll(pool)
    } catch { /* 静默 */ }
  }

  // 启动时如果有任何可续期账号，安排定期续期
  pool.listAllAccounts().then(accounts => {
    const hasRefreshable = accounts.some(a => a.refreshable && a.enabled)
    if (hasRefreshable) {
      const refreshTimer = setInterval(() => void refreshAllCredentials(), REFRESH_INTERVAL_MS)
      refreshTimer.unref?.()
      ctx.effect(() => () => {
        clearInterval(refreshTimer)
        service.stop()
        buddy.stop()
        workbuddy.stop()
        lobsterai.stop()
      }, 'jet-hub: multi-account refresh scheduler')
    }
  })

  // 保留旧的 stop scheduler（兼容旧命令）
  ctx.effect(() => () => {
    service.stop()
    buddy.stop()
    workbuddy.stop()
    lobsterai.stop()
  }, 'codearts-auth.scheduler (legacy)')

  // ===== Jet Hub RPC 注册 =====
  registerJetHubRpc(ctx, pool, service, buddy, workbuddy, lobsterai)
  ctx.provide('accountPool', pool)
}
