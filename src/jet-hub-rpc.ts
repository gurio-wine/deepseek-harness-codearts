/**
 * Account Hub 多账号管理的 RPC 端点注册。
 *
 * 使用 DSH 的 connection.fetch.register() 模式注册 HTTP API 端点，
 * 与 dsh-im 的 registerManagementRpc 一致。
 * 通道名 jet-hub → 路径 /api/jet-hub
 * 端点方法：account.list / account.create / account.update / account.delete /
 *           account.refresh / account.retest / account.retestAll /
 *           account.reset / account.resetAll / login.poll /
 *           credits.status / credits.claimAll / credits.balances /
 *           model.list / model.setDisabled
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from './account-pool.js'
import type { CodeArtsAuth } from './service.js'
import type { BuddyAuth } from './buddy-auth.js'
import type { LobsteraiAuth } from './lobsterai-auth.js'
import type { LobsteraiPendingLogin } from './lobsterai-oauth.js'
import type { CodeartsPendingLogin } from './login.js'
import { LOBSTERAI } from './lobsterai-product.js'
import { decorateLoginUrl, fetchAuthState, runBuddyLoginFlow } from './buddy-oauth.js'
import { credentialExpiresAtMs } from './buddy.js'
import type { BuddyCredential } from './buddy.js'
import {
  claimDailyCheckin,
  fetchCheckinStatus,
  fetchCreditBalance,
  type CheckinStatus,
  type ClaimOutcome,
  type CreditBalance,
} from './credits.js'
import { CODEBUDDY, productById, type BuddyProduct } from './product.js'
import {
  claimLobsteraiDailyCheckin,
  fetchLobsteraiCreditBalance,
} from './lobsterai-credits.js'
import { TRAE_CN } from './trae-cn-product.js'
import type { TraeCnCredential } from './trae-cn-oauth.js'
import type { TraeCnProduct } from './trae-cn-product.js'
import {
  claimTraeCnDailyCheckin,
  fetchTraeCnCheckinStatus,
  fetchTraeCnCreditBalance,
} from './trae-cn-credits.js'
import {
  resetAccount,
  resetAllAccounts,
  retestAccount,
  retestAllAccounts,
} from './account-probe.js'
import type {
  ProviderAccountEntry,
  RpcListAccountsRequest,
  RpcListAccountsResponse,
  RpcCreateAccountRequest,
  RpcCreateAccountResponse,
  RpcPollLoginRequest,
  RpcPollLoginResponse,
  RpcUpdateAccountRequest,
  RpcDeleteAccountRequest,
  RpcRefreshAccountRequest,
  RpcRefreshAccountResponse,
  RpcRetestAccountRequest,
  RpcRetestAllRequest,
  RpcResetAccountRequest,
  RpcResetAllRequest,
  RpcCreditsStatusRequest,
  RpcCreditsStatusResponse,
  RpcCreditsClaimAllRequest,
  RpcCreditsClaimAllResponse,
  RpcCreditsClaimSummary,
  RpcCreditsBalancesRequest,
  RpcCreditsBalancesResponse,
  RpcModelListRequest,
  RpcModelListResponse,
  RpcModelSetDisabledRequest,
  RpcModelSetDisabledResponse,
} from './types.js'

/** Account Hub RPC API 路径 */
export const JET_HUB_API_PATH = '/api/jet-hub'
/** Gateway RPC 端点名（connection.rpc.call 的 endpoint 参数） */
const JET_HUB_ENDPOINT = 'jet-hub'

/** 生成 8 字符随机短 ID（小写 hex） */
function shortId(): string {
  const buf = new Uint8Array(4)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 解析 Buddy 凭据 JSON；解析失败返回 undefined。 */
function parseBuddyCredential(raw: string): BuddyCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as BuddyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 汇总一次批量领取的结果。
 * 纯函数，便于单测；inactive（无资格/活动结束）与 failed 分开计数，
 * 因为前者是正常的业务状态、后者才是需要用户关注的问题。
 */
export function computeClaimSummary(outcomes: readonly ClaimOutcome[]): RpcCreditsClaimSummary {
  const summary: RpcCreditsClaimSummary = {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'claimed':
        summary.claimed += 1
        summary.totalCredit += outcome.credit
        break
      case 'already-claimed':
        summary.alreadyClaimed += 1
        break
      case 'inactive':
        summary.inactive += 1
        break
      case 'failed':
        summary.failed += 1
        break
      default: {
        // 编译期穷尽性检查：ClaimOutcome 未来新增 kind 时此处会报错，
        // 迫使作者显式决定它该计入哪一栏，而不是被静默漏计。
        const exhaustive: never = outcome
        void exhaustive
        // 运行期兜底：类型声明与运行时不符（未知 kind）时按 failed 计入，
        // 宁可多报一个失败，也不让结果凭空消失。
        summary.failed += 1
        break
      }
    }
  }
  return summary
}

/**
 * 进行中的 LobsterAI 登录登记表（accountId → 会话句柄）。
 *
 * 只做**生命周期管理**：`account.delete` 时按 accountId 找到会话并 cancel，
 * 立刻释放它占用的 127.0.0.1 回调端口；会话结算（成功/失败/超时）后自行删除。
 *
 * 真正的并发互斥在 `prepareLobsteraiLogin` 内（provider 级、模块级单例），
 * 这里不重复实现判重 —— 否则两处状态会在异常路径上失去同步。
 */
const pendingLobsteraiLogins = new Map<string, { accountId: string; session: LobsteraiPendingLogin }>()

/**
 * 进行中的 CodeArts 登录登记表（accountId → 会话句柄）。
 *
 * 与 {@link pendingLobsteraiLogins} 同构、同样**只做生命周期管理**：
 * `account.delete` 时按 accountId 找到会话并 cancel，立刻释放它占用的
 * 回调端口（CodeArts 的端口还必须 ≥10000）；会话结算（成功/失败/超时）后自行删除。
 *
 * 真正的并发互斥在 `prepareCodeartsLogin` 内（provider 级、模块级单例），
 * 这里不重复实现判重 —— 否则两处状态会在异常路径上失去同步。
 */
const pendingCodeartsLogins = new Map<string, { accountId: string; session: CodeartsPendingLogin }>()

/**
 * 积分端点的可注入依赖。
 *
 * 抽出这一层是为了让「逐账号处理」能脱离 `ctx.connection.fetch` 注册流程
 * 单独单测：端点内不做任何业务判断，只负责取账号列表并转交下面的纯函数。
 *
 * **对凭据/产品类型做泛型化**（而非写死 Buddy 系类型）：LobsterAI 的协议
 * 完全不同（无签名、三步签到、身份字段是 keyfrom），但「逐账号顺序执行、
 * 单个失败不中断、凭据解析在 try 之内」这套编排逻辑是**通用**的。
 * 泛型化让 `collect*` 三兄弟只写一遍，两套协议各自注入自己的下钻函数。
 * 默认类型参数保持 Buddy 系，故既有调用点与测试一行都不用改。
 */
export interface CreditsEndpointDeps<
  TCredential = BuddyCredential,
  TProduct = BuddyProduct,
> {
  /**
   * 解析凭据引用。
   * 按设计该接口**不可信**（凭据可能已被外部删除、provider 后端异常），
   * 实现允许抛错，调用方必须把异常算在单个账号头上。
   */
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  /** 查询签到状态；默认使用真实的 fetchCheckinStatus。 */
  fetchStatus?: (credential: TCredential, product: TProduct) => Promise<CheckinStatus | null>
  /** 执行签到领取；默认使用真实的 claimDailyCheckin。 */
  claim?: (credential: TCredential, product: TProduct) => Promise<ClaimOutcome>
  /** 查询积分余额；默认使用真实的 fetchCreditBalance。 */
  fetchBalance?: (credential: TCredential, product: TProduct) => Promise<CreditBalance | null>
  /** 单账号异常时的告警出口（不参与控制流）。 */
  warn?: (message: string) => void
  /**
   * 领取前是否先查一次签到状态（默认 `true`）。
   *
   * CodeBuddy 系拆成「查状态 + 领取」两个独立端点，先查可以省掉一次无效的
   * 领取请求（活动未开 / 今天已领时直接短路）。
   *
   * LobsterAI 的领取流程**自身就是多步的**（slot → context → check_in），
   * `claimedToday` / `actions` 判断已在内部完成并会返回对应的
   * `already-claimed` / `inactive`，外部再查一次纯属重复请求 ——
   * 故它传 `false` 跳过预检，直接交给 `claim`。
   */
  precheckStatus?: boolean
}

/**
 * 逐账号收集签到状态（顺序执行，避免并发触发风控）。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择与限流切换，不改变账号本身
 * 是否已签到。用户要看到的是「这个账号今天领了没」，因此这里不过滤 enabled。
 *
 * 关键约束：**凭据解析也在 try 之内**。`credentialRef()` 会对名称做正则校验
 * （非法名称抛 TypeError），`deps.resolve()` 也可能抛错。若把它们留在 try
 * 之外，任一账号的异常都会冒泡到 handleMethod 外层 catch，使整批请求以
 * `jet-hub/handler-failed` 失败——违背「单个账号失败不中断整体」的设计。
 */
export async function collectCreditsStatus<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsStatusResponse['accounts']> {
  const fetchStatus = deps.fetchStatus ?? (fetchCheckinStatus as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchStatus']>)
  const results: RpcCreditsStatusResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let status: CheckinStatus | null = null
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved !== undefined) {
        const credential = JSON.parse(resolved.value) as TCredential
        status = await fetchStatus(credential, product)
      }
    } catch (error) {
      // 单个账号的凭据缺失 / JSON 损坏 / 名称非法 / 网络失败都不影响其余账号
      deps.warn?.(`[jet-hub] credits.status 账号 ${entry.id} 失败: ${String(error)}`)
      status = null
    }
    results.push({ accountId: entry.id, nickname: entry.nickname, status })
  }
  return results
}

/**
 * 逐账号执行一键领取（顺序执行，单个账号失败不中断整体）。
 *
 * **包含已停用账号**：签到领取与「是否参与账号池自动选择」无关 —— 停用的
 * 账号同样有当日积分可领，用户点「一键领取」时期望所有账号都尝试一遍。
 * 停用只影响限流切换时的候选集合，不影响这里。
 *
 * 与 collectCreditsStatus 同理：凭据解析位于每个账号自己的 try 之内，
 * 异常只让该账号记为 failed。
 */
export async function collectClaimResults<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsClaimAllResponse> {
  const fetchStatus = deps.fetchStatus ?? (fetchCheckinStatus as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchStatus']>)
  const claim = deps.claim ?? (claimDailyCheckin as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['claim']>)
  // 默认保留预检（CodeBuddy 系需要）；LobsterAI 显式传 false 跳过。
  const precheck = deps.precheckStatus !== false
  const results: RpcCreditsClaimAllResponse['results'] = []
  const outcomes: ClaimOutcome[] = []
  for (const entry of accounts) {
    let outcome: ClaimOutcome
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        outcome = { kind: 'failed', code: -1, message: '凭据未配置' }
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        if (!precheck) {
          // 领取流程自带状态判断（LobsterAI 的 slot/context 检查在 claim 内部）。
          outcome = await claim(credential, product)
        } else {
          // 先查状态：活动未开启或今日已领则跳过领取请求，减少无效调用
          const status = await fetchStatus(credential, product)
          if (status !== null && !status.active) {
            outcome = { kind: 'inactive', message: '签到活动未开启' }
          } else if (status !== null && status.todayCheckedIn) {
            outcome = { kind: 'already-claimed', message: '今天已签到' }
          } else {
            // 状态查询失败（status 为 null）时仍然尝试领取：
            // 无法确认不代表不能领，交给领取接口以响应体 code 定夺。
            outcome = await claim(credential, product)
          }
        }
      }
    } catch (error) {
      deps.warn?.(`[jet-hub] credits.claimAll 账号 ${entry.id} 失败: ${String(error)}`)
      outcome = {
        kind: 'failed', code: -1,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    outcomes.push(outcome)
    results.push({ accountId: entry.id, nickname: entry.nickname, outcome })
  }
  return { results, summary: computeClaimSummary(outcomes) }
}

/**
 * 逐账号收集积分余额（顺序执行，避免并发触发风控）。
 *
 * 与 {@link collectCreditsStatus} 的关键差异：**这里保留失败原因**。
 * 余额查不到时用户最需要知道"为什么"（凭据过期？网络不通？），把它降级成
 * 一个 null 会让账号卡片显示成空白或 0 分，反而误导。因此失败时带上 error 文案。
 *
 * **包含已停用账号**：停用只影响账号池的自动选择，与"这个账号还剩多少积分"
 * 无关——用户就是想在同一个列表里看全部账号的余额。
 *
 * 凭据解析同样位于每个账号自己的 try 之内：单个账号的凭据缺失/损坏/名称非法
 * 都不会冒泡中断整批。
 */
export async function collectCreditBalances<TCredential = BuddyCredential, TProduct = BuddyProduct>(
  accounts: readonly ProviderAccountEntry[],
  product: TProduct,
  deps: CreditsEndpointDeps<TCredential, TProduct>,
): Promise<RpcCreditsBalancesResponse['accounts']> {
  const fetchBalance = deps.fetchBalance ?? (fetchCreditBalance as unknown as NonNullable<CreditsEndpointDeps<TCredential, TProduct>['fetchBalance']>)
  const results: RpcCreditsBalancesResponse['accounts'] = []
  // 顺序查询，避免并发触发风控
  for (const entry of accounts) {
    let balance: CreditBalance | null = null
    let error: string | undefined
    try {
      const resolved = await deps.resolve(credentialRef(entry.credentialRef))
      if (resolved === undefined) {
        error = '凭据未配置'
      } else {
        const credential = JSON.parse(resolved.value) as TCredential
        balance = await fetchBalance(credential, product)
        // 查询函数以 null 表示"查不到"（网络/业务码异常），与"余额为 0"不同
        if (balance === null) error = '余额查询失败'
      }
    } catch (caught) {
      deps.warn?.(`[jet-hub] credits.balances 账号 ${entry.id} 失败: ${String(caught)}`)
      error = caught instanceof Error ? caught.message : String(caught)
      balance = null
    }
    results.push({
      accountId: entry.id,
      nickname: entry.nickname,
      balance,
      ...error === undefined ? {} : { error },
    })
  }
  return results
}

/**
 * 读取 `ctx.llm` 用于枚举 provider 的模型目录。
 *
 * 用 `ctx.get` 而不是 `inject`：Account Hub 的账号管理是主要职责，模型开关只是
 * 附加能力；llm 服务缺失时账号面板仍应可用，只是「显示列表」按钮报错。
 */
function llmServiceOf(ctx: Context): { listModels(provider: string): Promise<Array<{ id: string; name: string }>> } | undefined {
  return ctx.get('llm') as
    | { listModels(provider: string): Promise<Array<{ id: string; name: string }>> }
    | undefined
}

/**
 * 注册 Account Hub 管理 API 端点。
 *
 * `connection` 服务只存在于 Web bundle；这里用**惰性注入**而非插件级静态
 * `inject`，因此在 headless / CLI profile 下本模块正常加载、只是不注册端点，
 * 而不是把整个插件树卡在 pending（那会让 profile 启动直接失败）。
 */
export function registerJetHubRpc(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddy: BuddyAuth,
  workbuddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
): void {
  ctx.inject(['connection'], (connectionCtx) => {
    registerJetHubEndpoints(connectionCtx as Context, pool, codearts, buddy, workbuddy, lobsterai)
  })
}

/** 注册 Account Hub 管理 API 端点。使用 ctx.connection.fetch.register() 注册 HTTP POST 端点。 */
function registerJetHubEndpoints(
  ctx: Context,
  pool: AccountPool,
  codearts: CodeArtsAuth,
  buddy: BuddyAuth,
  workbuddy: BuddyAuth,
  lobsterai: LobsteraiAuth,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = (ctx as any).connection ?? ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[jet-hub] connection.fetch not available, RPC endpoints not registered')
    return
  }

  connection.fetch.register({
    path: JET_HUB_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered' as const,
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let message: Record<string, unknown>
      try {
        message = await request.json() as Record<string, unknown>
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload as Record<string, unknown> | undefined
      if (
        message.type !== 'client-request' || typeof message.rpcId !== 'string'
        || message.method !== JET_HUB_ENDPOINT
        || !call || typeof call.method !== 'string'
        || !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'Invalid Account Hub management request.' } })
      }

      try {
        const result = await handleMethod(call.method as string, call.payload, request.signal)
        return reply(rpcId, result)
      } catch (error) {
        // 必须返回规范的 RPC 错误响应（而不是裸 500 文本），
        // 否则客户端 unwrapRpcResult 无法识别错误，表现为"点击无反应"。
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[jet-hub] ${String(call.method)} failed: ${message}`)
        return reply(rpcId, {
          ok: false,
          error: { code: 'jet-hub/handler-failed', message },
        })
      }
    },
  })

  /** 分发端点方法到对应的处理器 */
  async function handleMethod(method: string, payload: unknown, _signal: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'account.list': {
        const req = payload as RpcListAccountsRequest
        const accounts = await pool.listAccounts(req.provider)
        return { ok: true, value: { accounts } }
      }

      case 'account.create': {
        const req = payload as RpcCreateAccountRequest
        const { provider } = req
        const id = `${provider}-${shortId()}`
        const suffix = shortId().toUpperCase()
        const refName = `${provider.toUpperCase()}_ACCOUNT_${suffix}`

        // CodeBuddy 系（buddy / workbuddy）共用两步登录流程：
        // 只获取 loginUrl 和 state 立即返回，后台用同一个 state 异步执行
        // 完整登录流程。两者的差异只在产品配置（platform、登录 URL 附加
        // 参数、X-Product-Code、User-Agent），全部由 product 承载。
        const product = productById(provider)
        if (product !== undefined) {
          let state: string
          let authUrl: string
          try {
            const authState = await fetchAuthState(undefined, undefined, product)
            state = authState.state
            // WorkBuddy 的登录 URL 需要追加 version 与 loginSessionId
            authUrl = decorateLoginUrl(authState.authUrl, product)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法获取 ${product.displayName} 登录地址（Host 网络请求失败）：${reason}`)
          }
          const ref = credentialRef(refName)
          // 先在 pool 中添加启用的占位条目（无凭据），方便客户端 login.poll 检测到
          await pool.addAccount({
            id,
            provider: product.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            refreshable: false,
            createdAt: Date.now(),
          })
          // 后台异步执行完整登录流程，使用同一个 state
          runBuddyLoginFlow({ openBrowser: () => {}, state, product }).then(async (flow) => {
            await ctx.credentials.set(ref, flow.access)
            // 续期定时器归属该产品自己的服务实例
            ;(product.id === CODEBUDDY.id ? buddy : workbuddy).scheduleRefresh()
            const credential = parseBuddyCredential(flow.access)
            await pool.updateAccount(id, {
              nickname: credential?.nickname ?? id,
              // Buddy 的 expires_at 是字符串形式的毫秒时间戳，
              // 必须用 credentialExpiresAtMs 解析（Date.parse 对纯数字串会得到 NaN）。
              expiresAt: credential ? credentialExpiresAtMs(credential) : undefined,
              refreshable: Boolean(credential?.refresh_token),
            })
          }).catch((err) => {
            ctx.logger.warn(`[jet-hub] background ${product.id} login failed for ${id}: ${err}`)
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            void pool.removeAccount(id).catch(() => {})
          })
          return { ok: true, value: { accountId: id, loginUrl: authUrl } }
        } else if (provider === 'codearts') {
          // CodeArts 与 LobsterAI 同款：**回调式**登录，走两段式。
          //   1. 先 prepare（起 127.0.0.1 回调服务器，端口 ≥10000）→ 立即返回 loginUrl；
          //   2. 客户端在同一用户手势内 open 该 URL —— 这正是本次改造的目的：
          //      宿主不再持有一个可能长达 180 秒的阻塞 RPC。阻塞期间用户手势
          //      早已过期，客户端兜底会自行开窗，把 DSH 页面顶掉；
          //   3. 后台 awaitCredential 完成后写凭据并补全占位账号。
          //
          // 宿主 opener 为空的表达方式与 lobsterai 分支一致：prepareLogin 本身
          // 不接收 openBrowser，这里通过「根本不打开」来表达同一约束（打开动作
          // 归客户端，宿主再开一次会变成两个标签页）。
          let prepared
          try {
            prepared = await codearts.prepareLogin()
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 CodeArts 登录：${reason}`)
          }
          if (!prepared.ok) {
            // provider 级互斥：已有未结算的登录会话。原样返回可判别错误码，
            // 而不是抛异常 —— 抛异常会被包装成 jet-hub/handler-failed，
            // 客户端就无法据以提示「已有登录进行中」。
            return { ok: false, error: { code: prepared.error, message: prepared.message } }
          }
          const loginSession = prepared.session
          // 先在 pool 中添加启用的占位条目（无凭据、pending 形态），
          // 满足 login.poll 的检测路径：它按「该 credentialRef 能否解析到凭据」判完成。
          await pool.addAccount({
            id,
            provider: 'codearts',
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // 占位期间不可续期、无过期时间：两者都要等换取结果才知道。
            refreshable: false,
            createdAt: Date.now(),
          })
          // 登记表只做生命周期管理：失败/超时释放端口，account.delete 时取消。
          pendingCodeartsLogins.set(id, { accountId: id, session: loginSession })
          void loginSession.awaitCredential().then(async (flow) => {
            // 凭据落盘 + 占位账号补全（两段式的第二段），时序由该方法内部保证。
            await codearts.persistLoginResult(flow, { refName, accountId: id, pool })
          }).catch(async (error: unknown) => {
            ctx.logger.warn(
              `[jet-hub] background codearts login failed for ${id}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            await pool.removeAccount(id).catch(() => {})
          }).finally(() => {
            pendingCodeartsLogins.delete(id)
          })
          return { ok: true, value: { accountId: id, loginUrl: loginSession.loginUrl } }
        } else if (provider === LOBSTERAI.id) {
          // LobsterAI 与 CodeBuddy 系一样走**两段式**，但第一段不是「轮询式取 state」，
          // 而是「起本地回调服务器拿 loginUrl」：
          //   1. 先 prepare（起 127.0.0.1 回调服务器）→ 立即返回 loginUrl；
          //   2. 客户端在同一用户手势内 open 该 URL —— 这正是本次改造的目的：
          //      宿主不再持有一个可能长达 10 分钟的阻塞 RPC。阻塞期间用户手势
          //      早已过期，客户端兜底会自行开窗，把 DSH 页面顶掉；
          //   3. 后台 awaitCredential 完成后写凭据并补全占位账号。
          //
          // 宿主 opener 为空函数（对齐上面 CodeBuddy 分支的 `openBrowser: () => {}`）：
          // 打开动作归客户端，宿主再开一次会变成两个标签页。prepareLogin 本身
          // 不接收 openBrowser，这里通过「根本不打开」来表达同一约束。
          let prepared
          try {
            prepared = await lobsterai.prepareLogin()
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            throw new Error(`无法启动 LobsterAI 登录：${reason}`)
          }
          if (!prepared.ok) {
            // provider 级互斥：已有未结算的登录会话。原样返回可判别错误码，
            // 而不是抛异常 —— 抛异常会被包装成 jet-hub/handler-failed，
            // 客户端就无法据以提示「已有登录进行中」。
            return { ok: false, error: { code: prepared.error, message: prepared.message } }
          }
          const loginSession = prepared.session
          // 先在 pool 中添加启用的占位条目（无凭据、pending 形态），
          // 满足 login.poll 的检测路径：它按「该 credentialRef 能否解析到凭据」判完成。
          await pool.addAccount({
            id,
            provider: LOBSTERAI.id,
            nickname: id,
            enabled: true,
            credentialRef: refName,
            // 占位期间不可续期、无过期时间：两者都要等 exchange 结果才知道。
            refreshable: false,
            createdAt: Date.now(),
          })
          // 登记表只做生命周期管理：失败/超时释放端口，account.delete 时取消。
          pendingLobsteraiLogins.set(id, { accountId: id, session: loginSession })
          void loginSession.awaitCredential().then(async (flow) => {
            // 凭据落盘 + 占位账号补全（两段式的第二段），时序由该方法内部保证。
            await lobsterai.persistLoginResult(flow, { refName, accountId: id, pool })
          }).catch(async (error: unknown) => {
            ctx.logger.warn(
              `[jet-hub] background ${LOBSTERAI.id} login failed for ${id}: `
              + `${error instanceof Error ? error.message : String(error)}`,
            )
            // 登录失败：移除占位条目，避免留下无凭据的幽灵账号
            await pool.removeAccount(id).catch(() => {})
          }).finally(() => {
            pendingLobsteraiLogins.delete(id)
          })
          return { ok: true, value: { accountId: id, loginUrl: loginSession.loginUrl } }
        } else {
          return { ok: false, error: { code: 'bad-request', message: `unknown provider: ${provider}` } }
        }
      }

      case 'account.update': {
        const req = payload as RpcUpdateAccountRequest
        await pool.updateAccount(req.accountId, req.patch)
        return { ok: true, value: undefined }
      }

      case 'account.delete': {
        const req = payload as RpcDeleteAccountRequest
        // 若该账号正处于「等待浏览器登录」状态，先取消会话：否则它会一直占着
        // 127.0.0.1 的回调端口到 10 分钟超时；更糟的是 prepare 的互斥锁是
        // provider 级的 —— 旧会话不释放，用户删掉占位账号后想重新登录
        // 会一直拿到 `login-in-progress`，直到旧会话超时。
        pendingLobsteraiLogins.get(req.accountId)?.session.cancel('账号已删除，登录已取消')
        pendingLobsteraiLogins.delete(req.accountId)
        // CodeArts 同理（互斥同样是 provider 级的，且它占用的端口还要求 ≥10000）。
        pendingCodeartsLogins.get(req.accountId)?.session.cancel('账号已删除，登录已取消')
        pendingCodeartsLogins.delete(req.accountId)
        await pool.removeAccount(req.accountId)
        return { ok: true, value: undefined }
      }

      case 'account.refresh': {
        const req = payload as RpcRefreshAccountRequest
        try {
          const accounts = await pool.listAllAccounts()
          const entry = accounts.find((a) => a.id === req.accountId)
          if (!entry) throw new Error(`Account ${req.accountId} not found`)

          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 两处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
          //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          // 按 **entry.provider** 分派到对应服务，并调用**按凭据 ref 的**
          // 续期入口 —— 两处都是修复既有缺陷的关键：
          //
          // 1. 原实现只处理 codearts / buddy，`workbuddy` 会落到 else 抛
          //    `Unknown provider`，即 WorkBuddy 账号卡片的「刷新」按钮一直是坏的；
          // 2. 原实现调的是 `service.refresh()`，它读写的是该 provider 的
          //    **默认单凭据 ref**（如 BUDDY_ACCESS_TOKEN），而账号卡片对应的是
          //    BUDDY_ACCOUNT_XXX —— 于是「刷新这个账号」实际刷的是另一个凭据，
          //    结果要么报错要么静默改了错的对象。
          switch (entry.provider) {
            case 'codearts':
              await codearts.refreshAccountCredential(entry.credentialRef)
              break
            case 'buddy':
              await buddy.refreshAccountCredential(entry.credentialRef)
              break
            case 'workbuddy':
              await workbuddy.refreshAccountCredential(entry.credentialRef)
              break
            case LOBSTERAI.id:
              await lobsterai.refreshAccountCredential(entry.credentialRef)
              break
            default:
              throw new Error(`Unknown provider: ${entry.provider}`)
          }
          return { ok: true, value: { success: true } }
        } catch (error) {
          return {
            ok: true,
            value: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }

      case 'login.poll': {
        const req = payload as RpcPollLoginRequest
        const accounts = await pool.listAllAccounts()
        const entry = accounts.find((a) => a.id === req.accountId)
        if (!entry) return { ok: true, value: { done: false } }
        // 检查凭据是否已实际写入（占位条目没有凭据）
        const ref = credentialRef(entry.credentialRef)
        const resolved = await ctx.credentials.resolve(ref)
        if (!resolved) return { ok: true, value: { done: false } }
        return { ok: true, value: { done: true, success: true } }
      }

      // ── 限流标记：重测（发真实请求验证）──
      // 标记只反映"上一次 429 时的快照"，服务端常在重置时间前提前放行。
      // 重测发一次最小对话请求：正常返回才清除标记，仍受限则保留并回报原因。
      case 'account.retest': {
        const req = payload as RpcRetestAccountRequest
        const account = await retestAccount(pool, req.accountId)
        return {
          ok: true,
          value: { accounts: [account], clearedCount: account.cleared.length },
        }
      }

      // 重测该 provider 下的全部账号。**包含已停用账号**——用户明确要求
      // 停用账号也能重测（停用只影响自动选择，不影响手动排查）。
      case 'account.retestAll': {
        const req = payload as RpcRetestAllRequest
        const value = await retestAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 限流标记：重置（不发请求，直接清除）──
      case 'account.reset': {
        const req = payload as RpcResetAccountRequest
        const value = await resetAccount(pool, req.accountId)
        return { ok: true, value }
      }

      case 'account.resetAll': {
        const req = payload as RpcResetAllRequest
        const value = await resetAllAccounts(pool, req.provider)
        return { ok: true, value }
      }

      // ── 每日签到（积分领取）──
      // 查询某 provider 下全部启用账号的签到状态。
      //
      // ⚠️ 三个积分端点（status / claimAll / balances）都以 `productById()`
      // 判能力，而 **CodeArts 不是 BuddyProduct**（华为云账号体系没有腾讯计费
      // 接口），因此 `codearts` 必定落到下面的 bad-request。这是正确且必要的
      // 拒绝，但客户端**不应**把这条错误当作运行时故障去展示：它应当在发请求
      // 之前就按 `plugin-src/client/credits-capabilities.js` 的能力矩阵判掉
      // （历史缺陷：CodeArts 面板挂载时无条件调用 credits.balances，导致每次
      // 打开设置页都在控制台报 unsupported provider 并把账号卡片标成查询失败）。
      // 此处的拒绝是兜底与契约声明，不是常规路径。
      case 'credits.status': {
        const req = payload as RpcCreditsStatusRequest
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 没有独立的「签到状态」端点：活动状态要经
          // slot → context 两步才能得到，且语义与 CodeBuddy 的
          // CheckinStatus 不同构（无 streak/dailyCredit 等概念）。
          // 故这里如实返回 null，而不是臆造一份状态对象。
          const accounts = await pool.listAccounts(req.provider)
          return {
            ok: true,
            value: {
              accounts: accounts.map((entry) => ({ accountId: entry.id, nickname: entry.nickname, status: null })),
            } satisfies RpcCreditsStatusResponse,
          }
        }
        if (req.provider === TRAE_CN.id) {
          // Trae CN **有**独立的状态端点（`checkin_credits/status`），但它只给出
          // 「今天领了没」与 `enable` 两项，其余字段（连续天数 / 每日积分 /
          // 活动名…）协议里没有已确认的对应字段，故由 fetchTraeCnCheckinStatus
          // 如实补零。与 LobsterAI 的「压根没有状态端点」不是同一种情况。
          const accounts = await pool.listAccounts(req.provider)
          const results = await collectCreditsStatus<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchStatus: (credential, product) =>
              fetchTraeCnCheckinStatus(credential, product, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const accounts = await pool.listAccounts(req.provider)
        const results = await collectCreditsStatus(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: results } satisfies RpcCreditsStatusResponse }
      }

      // 一键领取：逐账号顺序执行（并发易触发风控），单个账号失败不中断整体。
      case 'credits.claimAll': {
        const req = payload as RpcCreditsClaimAllRequest
        const accounts = await pool.listAccounts(req.provider)
        if (req.provider === LOBSTERAI.id) {
          // LobsterAI 的 clientVersion 是签到必填参数，需动态解析
          //（带缓存，通常无额外网络开销）。
          const clientVersion = await lobsterai.resolveClientVersion()
          const value = await collectClaimResults(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product) =>
              claimLobsteraiDailyCheckin(credential, product, clientVersion),
            // 领取流程内部已做 slot/context 预检，不需要外部再查一次状态。
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        if (req.provider === TRAE_CN.id) {
          // Trae CN 的领取流程**自身**就是两步（status → 未领则 claim），
          // 内部已按 `checked_in` 幂等预检 —— 外部再查一次纯属重复请求，
          // 故与其他多步流程（LobsterAI）一样传 precheckStatus: false。
          const value = await collectClaimResults<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            claim: (credential, product) =>
              claimTraeCnDailyCheckin(credential, product, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            precheckStatus: false,
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const value = await collectClaimResults(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: value satisfies RpcCreditsClaimAllResponse }
      }

      // 积分余额（Credits Balance）：逐账号顺序查询。
      //
      // 独立于 account.list 的原因：余额要为每个账号发一次网络请求，而
      // account.list 是打开面板就会调的轻量操作。混在一起会让账号列表被
      // 网络耗时拖慢，且一次查询失败会让整份列表都取不到。
      case 'credits.balances': {
        const req = payload as RpcCreditsBalancesRequest
        const accounts = await pool.listAccounts(req.provider)
        if (req.provider === LOBSTERAI.id) {
          const values = await collectCreditBalances(accounts, LOBSTERAI, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            fetchBalance: (credential, product) => fetchLobsteraiCreditBalance(credential, product),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        if (req.provider === TRAE_CN.id) {
          const values = await collectCreditBalances<TraeCnCredential, TraeCnProduct>(accounts, TRAE_CN, {
            resolve: (ref) => ctx.credentials.resolve(ref),
            // 双池拆分（通用 / Work）由 fetchTraeCnCreditBalance 完成：它的
            // 返回值是 `CreditBalance` 的超集，故能直接喂给共用的收集器与卡片。
            fetchBalance: (credential, product) =>
              fetchTraeCnCreditBalance(credential, product, { onDebug: (msg) => ctx.logger?.info?.(msg) }),
            warn: (msg) => ctx.logger?.warn?.(msg),
          })
          return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
        }
        const product = productById(req.provider)
        if (product === undefined) {
          return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${req.provider}` } }
        }
        const values = await collectCreditBalances(accounts, product, {
          resolve: (ref) => ctx.credentials.resolve(ref),
          warn: (msg) => ctx.logger?.warn?.(msg),
        })
        return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
      }

      // ── 模型列表可见性（黑名单开关）──
      //
      // 列表来自 `ctx.llm.listModels()`——**适配器播报的权威目录**，正是
      // 对话框模型选择器读的同一份数据（会话控制器的 buildModelCatalog）。
      // 这样设置页展示的模型集合与实际可选集合永远一致，不会出现
      // 「设置在某个模型上，选择器里却找不到它」。
      case 'model.list': {
        const req = payload as RpcModelListRequest
        const llm = llmServiceOf(ctx)
        if (llm === undefined) {
          return { ok: false, error: { code: 'bad-request', message: 'llm 服务不可用' } }
        }
        let models: Array<{ id: string; name: string }>
        try {
          models = await llm.listModels(req.provider)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          return { ok: false, error: { code: 'bad-request', message: `读取模型列表失败：${reason}` } }
        }
        // 黑名单直接读账号池的进程内副本：开关写入后无需重建适配器，
        // 下一次 listModels 就会应用新的过滤结果。
        const disabledMap = pool.listDisabledModels(req.provider)
        // ⚠️ `llm.listModels()` 返回的目录**已被适配器过滤掉黑名单**：两个适配器
        // （llm-adapter.ts / buddy-adapter.ts）的 listModels 内部都会实时
        // `filter(m => !disabledModelsFor(provider).has(m.id))`。若直接对这个
        // 结果回填 disabled，就形成闭环矛盾——`disabledMap` 里的键恰好是
        // `models` 中已被移除的那些元素，`.map()` 永远匹配不到它们，被关闭的
        // 模型连同它的开关一起从设置页消失，用户**再也无法重新打开**（只能手工
        // 编辑 settings.yaml）。这正是「关掉后彻底找不到该模型」的根因。
        //
        // 因此这里以黑名单为准做并集：凡是「黑名单里为 true、却已不在
        // listModels 结果中」的模型，补回列表并标记为已关闭。设置页据此始终能
        // 渲染出全部开关；而对话框模型选择器读的仍是过滤后的 listModels，
        // 可见性行为完全不变。
        const listedIds = new Set(models.map((model) => model.id))
        const filteredOut = Object.keys(disabledMap)
          .filter((id) => disabledMap[id] === true && !listedIds.has(id))
        const value: RpcModelListResponse = {
          models: [
            ...models.map((model) => ({
              id: model.id,
              name: model.name,
              disabled: disabledMap[model.id] === true,
            })),
            // 这些模型已被适配器过滤掉，拿不到原始 name，回退为 id。
            ...filteredOut.map((id) => ({ id, name: id, disabled: true })),
          ],
        }
        return { ok: true, value }
      }

      // 打开/关闭某个模型。写入后**不重建适配器**：适配器的 listModels 每次
      // 都直接读账号池的黑名单，因此下一轮模型目录刷新即生效。
      case 'model.setDisabled': {
        const req = payload as RpcModelSetDisabledRequest
        if (typeof req.provider !== 'string' || typeof req.modelId !== 'string' || req.modelId.length === 0) {
          return { ok: false, error: { code: 'bad-request', message: 'provider 与 modelId 必填' } }
        }
        await pool.setModelDisabled(req.provider, req.modelId, req.disabled === true)
        ctx.logger.info(
          `[jet-hub] ${req.disabled === true ? '关闭' : '打开'}模型 ${req.provider}/${req.modelId}`,
        )
        const value: RpcModelSetDisabledResponse = {
          provider: req.provider,
          disabledModels: pool.listDisabledModels(req.provider),
        }
        return { ok: true, value }
      }

      default:
        return { ok: false, error: { code: 'bad-request', message: `unknown method: ${method}` } }
    }
  }
}

/** 构造带 rpcId 的响应 JSON */
function reply(rpcId: string, result: unknown): Response {
  const value = typeof result === 'object' && result !== null && (result as Record<string, unknown>).ok === false
    ? { ...result as Record<string, unknown>, error: { ...(result as Record<string, unknown>).error as Record<string, unknown>, details: {} } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}
