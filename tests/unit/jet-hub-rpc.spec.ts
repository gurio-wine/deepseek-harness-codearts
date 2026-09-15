import { describe, expect, it } from 'vitest'
import {
  collectClaimResults,
  collectCreditBalances,
  collectCreditsStatus,
  computeClaimSummary,
  registerJetHubRpc,
} from '../../src/jet-hub-rpc.js'
import type { CreditsEndpointDeps } from '../../src/jet-hub-rpc.js'
import { AccountPool } from '../../src/account-pool.js'
import type { ClaimOutcome, CheckinStatus, CreditBalance } from '../../src/credits.js'
import { WORKBUDDY } from '../../src/product.js'
import type { ProviderAccountEntry } from '../../src/types.js'

describe('积分领取结果汇总', () => {
  it('统计成功数量与累计积分', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false },
      { kind: 'claimed', credit: 50, streakDays: 2, isStreakDay: true },
      { kind: 'already-claimed', message: '今天已签到' },
      { kind: 'failed', code: 500, message: 'boom' },
    ]
    expect(computeClaimSummary(outcomes)).toEqual({
      claimed: 2, totalCredit: 150, alreadyClaimed: 1, inactive: 0, failed: 1,
    })
  })

  it('全部已领取时 claimed 为 0', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'already-claimed', message: 'a' },
      { kind: 'already-claimed', message: 'b' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ claimed: 0, totalCredit: 0, alreadyClaimed: 2 })
  })

  it('混合 inactive 与 failed 分别计数', () => {
    const outcomes: ClaimOutcome[] = [
      { kind: 'inactive', message: '活动未开启' },
      { kind: 'failed', code: 1, message: 'x' },
    ]
    expect(computeClaimSummary(outcomes)).toMatchObject({ inactive: 1, failed: 1, claimed: 0 })
  })

  it('空数组返回全 0', () => {
    expect(computeClaimSummary([])).toEqual({
      claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0,
    })
  })

  it('未知 kind 兜底计入 failed，而不是被静默漏计', () => {
    // 模拟 ClaimOutcome 未来新增 kind、但汇总分支未同步更新的情况。
    const unknown = { kind: 'brand-new-kind', message: 'x' } as unknown as ClaimOutcome
    expect(computeClaimSummary([unknown, { kind: 'inactive', message: 'i' }]))
      .toMatchObject({ failed: 1, inactive: 1, claimed: 0 })
  })
})

// ─────────────────────────────────────────────────────────────
// 逐账号异常隔离（Task 8 补充修复）
//
// 直接调用 RPC 端点需要构造 ctx.connection.fetch.register 替身，
// 因此端点已把「逐账号处理」抽成 collectCreditsStatus / collectClaimResults
// 两个可导出函数（方案 A）。这里对它们单测：既能精确断言单账号隔离，
// 又能验证顺序性，且完全不发起网络请求（fetchStatus / claim 均注入桩）。
// ─────────────────────────────────────────────────────────────

/** 构造账号条目；默认是启用的合法账号。 */
function makeEntry(overrides: Partial<ProviderAccountEntry> = {}): ProviderAccountEntry {
  return {
    id: 'workbuddy-1',
    provider: 'workbuddy',
    nickname: '测试号',
    enabled: true,
    credentialRef: 'WORKBUDDY_ACCOUNT_AAAA1111',
    createdAt: 1,
    refreshable: true,
    ...overrides,
  }
}

/** 最小合法凭据 JSON。 */
const VALID_CREDENTIAL_JSON = JSON.stringify({
  access_token: 'AT', refresh_token: 'RT', expires_at: '2099-01-01T00:00:00Z',
})

/** 构造签到状态。 */
function makeStatus(overrides: Partial<CheckinStatus> = {}): CheckinStatus {
  return {
    active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 100,
    todayCredit: 0, isStreakDay: false, totalCredits: 0, checkinDates: [],
    activityName: 'a', themeName: 't', endTime: '', ...overrides,
  }
}

/**
 * 构造依赖替身。
 * 默认：所有 ref 都能解析出合法凭据，状态接口返回「可领取」，领取返回成功。
 */
function makeDeps(overrides: Partial<CreditsEndpointDeps> = {}): CreditsEndpointDeps {
  return {
    resolve: async () => ({ value: VALID_CREDENTIAL_JSON }),
    fetchStatus: async () => makeStatus(),
    claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    ...overrides,
  }
}

describe('credits.status 单账号异常隔离', () => {
  it('非法 credentialRef 只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const asked: string[] = []
    const deps = makeDeps({
      resolve: async (ref) => {
        asked.push(String(ref))
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    // 三个账号都要出现在结果里（不是整批抛异常）
    expect(results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(results[0]?.status).toBeNull()
    // 关键：坏账号之后的两个账号确实被继续处理
    expect(results[1]?.status).not.toBeNull()
    expect(results[2]?.status).not.toBeNull()
    // 坏账号根本没走到 resolve（名称校验先抛）
    expect(asked).toEqual(['WORKBUDDY_ACCOUNT_AAAA1111', 'WORKBUDDY_ACCOUNT_AAAA1111'])
  })

  it('resolve 抛错只让该账号状态为 null，其余账号仍被查询', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => {
        resolveCalls++
        // 第一个账号的 resolve 抛错（如凭据已被外部删除）；后续账号正常。
        if (resolveCalls === 1) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['boom', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toEqual(makeStatus())
    expect(resolveCalls).toBe(2)
  })

  it('JSON 损坏与网络失败都只影响该账号', async () => {
    const accounts = [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'network-down' }), makeEntry({ id: 'ok' })]
    let resolveCalls = 0
    const deps = makeDeps({
      resolve: async () => ({ value: resolveCalls++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      // 第二个账号（network-down）的状态请求抛网络错误
      fetchStatus: async () => {
        if (resolveCalls === 2) throw new Error('socket hang up')
        return makeStatus()
      },
    })

    const results = await collectCreditsStatus(accounts, WORKBUDDY, deps)

    expect(results.map(r => r.accountId)).toEqual(['corrupt', 'network-down', 'ok'])
    expect(results[0]?.status).toBeNull()
    expect(results[1]?.status).toBeNull()
    expect(results[2]?.status).toEqual(makeStatus())
  })

  it('停用账号同样处理（停用与签到无关），异常出口收到告警', async () => {
    const warnings: string[] = []
    const accounts = [
      makeEntry({ id: 'off', enabled: false }),
      makeEntry({ id: 'bad-ref', credentialRef: '非法名称' }),
    ]
    const results = await collectCreditsStatus(accounts, WORKBUDDY, makeDeps({
      warn: (msg) => warnings.push(msg),
    }))

    // 停用只影响账号池的自动选择与限流切换，不改变「该账号今天领了没」，
    // 故两个账号都要出现在结果里。
    expect(results.map(r => r.accountId)).toEqual(['off', 'bad-ref'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bad-ref')
  })

  it('凭据解析为 undefined 时状态为 null，且不调用状态接口', async () => {
    let statusCalls = 0
    const results = await collectCreditsStatus([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { statusCalls++; return makeStatus() },
    }))

    expect(results[0]?.status).toBeNull()
    expect(statusCalls).toBe(0)
  })
})

describe('credits.claimAll 单账号异常隔离与顺序性', () => {
  it('停用账号也被领取（一键领取覆盖全部账号）', async () => {
    const accounts = [
      makeEntry({ id: 'enabled-1', enabled: true }),
      makeEntry({ id: 'disabled-1', enabled: false }),
      makeEntry({ id: 'disabled-2', enabled: false }),
    ]
    const deps = makeDeps({
      claim: async () => ({ kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }),
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 停用只影响账号池的自动选择与限流切换；积分照领。
    expect(response.results.map(r => r.accountId)).toEqual(['enabled-1', 'disabled-1', 'disabled-2'])
    expect(response.results.every(r => r.outcome.kind === 'claimed')).toBe(true)
    expect(response.summary).toEqual({
      claimed: 3, totalCredit: 300, alreadyClaimed: 0, inactive: 0, failed: 0,
    })
  })

  it('非法 credentialRef 的账号记为 failed，其余账号仍被领取', async () => {
    const accounts = [
      makeEntry({ id: 'bad-ref', credentialRef: 'not a valid ref!' }),
      makeEntry({ id: 'good-1' }),
      makeEntry({ id: 'good-2' }),
    ]
    const claimed: string[] = []
    const deps = makeDeps({
      claim: async () => {
        claimed.push(`claim-${claimed.length}`)
        return { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    // 整批成功返回，三个账号都有结果
    expect(response.results.map(r => r.accountId)).toEqual(['bad-ref', 'good-1', 'good-2'])
    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', code: -1 })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.results[2]?.outcome).toMatchObject({ kind: 'claimed' })
    // 坏账号没有阻止后两个账号真正发起领取
    expect(claimed).toHaveLength(2)
    expect(response.summary).toEqual({
      claimed: 2, totalCredit: 200, alreadyClaimed: 0, inactive: 0, failed: 1,
    })
  })

  it('resolve 抛错被收敛为该账号的 failed，不冒泡中断整批', async () => {
    const accounts = [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })]
    let first = true
    const deps = makeDeps({
      resolve: async () => {
        if (first) { first = false; throw new Error('凭据已被外部删除') }
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results[0]?.outcome).toMatchObject({ kind: 'failed', message: '凭据已被外部删除' })
    expect(response.results[1]?.outcome).toMatchObject({ kind: 'claimed' })
    expect(response.summary.failed).toBe(1)
    expect(response.summary.claimed).toBe(1)
  })

  it('凭据未配置记为 failed 且不发起任何请求', async () => {
    let touched = 0
    const response = await collectClaimResults([makeEntry({ id: 'noconf' })], WORKBUDDY, makeDeps({
      resolve: async () => undefined,
      fetchStatus: async () => { touched++; return makeStatus() },
      claim: async () => { touched++; return { kind: 'failed', code: -1, message: 'x' } },
    }))

    expect(response.results[0]?.outcome).toEqual({ kind: 'failed', code: -1, message: '凭据未配置' })
    expect(touched).toBe(0)
  })

  it('保持「先查状态再领取」：活动未开启/今日已签到时跳过领取请求', async () => {
    const accounts = [makeEntry({ id: 'inactive' }), makeEntry({ id: 'done' }), makeEntry({ id: 'ready' })]
    let call = 0
    const claimCalls: string[] = []
    const deps = makeDeps({
      fetchStatus: async () => {
        call++
        if (call === 1) return makeStatus({ active: false })
        if (call === 2) return makeStatus({ todayCheckedIn: true })
        return makeStatus()
      },
      claim: async () => {
        claimCalls.push('claim')
        return { kind: 'claimed', credit: 10, streakDays: 1, isStreakDay: false }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(response.results.map(r => r.outcome.kind))
      .toEqual(['inactive', 'already-claimed', 'claimed'])
    // 只有第三个账号真正调用了领取接口
    expect(claimCalls).toHaveLength(1)
  })

  it('顺序执行：任一时刻只有一个账号在处理（不并发）', async () => {
    const accounts = [
      makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' }),
    ]
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      resolve: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchStatus: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return makeStatus()
      },
      claim: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false }
      },
    })

    await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(maxInFlight).toBe(1)
  })

  it('按账号顺序串行，且结果顺序与账号顺序一致', async () => {
    const accounts = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })]
    const order: string[] = []
    let seq = 0
    const deps = makeDeps({
      // 让先启动的账号耗时更长，若并发则 c 会先完成
      resolve: async () => {
        const mine = seq++
        await new Promise(r => setTimeout(r, mine === 0 ? 10 : 1))
        order.push(`entry-${mine}`)
        return { value: VALID_CREDENTIAL_JSON }
      },
    })

    const response = await collectClaimResults(accounts, WORKBUDDY, deps)

    expect(order).toEqual(['entry-0', 'entry-1', 'entry-2'])
    expect(response.results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * collectCreditBalances：逐账号收集积分余额。
 *
 * 与状态/领取的关键差异是**保留失败原因**——账号卡片要显示"为什么没查到"，
 * 把它降级成 null 会让 UI 显示成空白，用户无从判断是余额为 0 还是查询失败。
 */
describe('credits.balances 逐账号余额收集', () => {
  const BALANCE: CreditBalance = {
    total: 347.87,
    packages: [
      { name: 'Bonus Pack', unit: 'credit', remaining: 247.87, total: 250, used: 2.13, cycleStartTime: '', cycleEndTime: '2026-09-28 10:05:56' },
      { name: 'Free Plan Subscription', unit: 'credits', remaining: 100, total: 100, used: 0, cycleStartTime: '', cycleEndTime: '2026-09-30 23:59:59' },
    ],
  }

  it('成功时回传余额与包明细', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances([makeEntry({ id: 'a' })], WORKBUDDY, deps)

    expect(results).toEqual([{ accountId: 'a', nickname: '测试号', balance: BALANCE }])
  })

  it('余额为 0 与查询失败严格区分', async () => {
    const empty: CreditBalance = { total: 0, packages: [] }
    let call = 0
    const deps = makeDeps({ fetchBalance: async () => (call++ === 0 ? empty : null) })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'zero' }), makeEntry({ id: 'failed' })], WORKBUDDY, deps,
    )

    // 第一个真余额 0：可展示为 0，不算错误
    expect(results[0]!.balance).toEqual(empty)
    expect(results[0]!.error).toBeUndefined()
    // 第二个查不到：balance 为 null 且带原因，UI 不能显示成 0
    expect(results[1]!.balance).toBeNull()
    expect(results[1]!.error).toBe('余额查询失败')
  })

  it('凭据未配置时给出原因，且不发起余额请求', async () => {
    let touched = 0
    const deps = makeDeps({
      resolve: async () => undefined,
      fetchBalance: async () => { touched++; return BALANCE },
    })
    const results = await collectCreditBalances([makeEntry({ id: 'noconf' })], WORKBUDDY, deps)

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBe('凭据未配置')
    expect(touched).toBe(0)
  })

  it('单个账号异常不中断整批，且记录该账号的原因', async () => {
    let call = 0
    const warnings: string[] = []
    const deps = makeDeps({
      resolve: async () => {
        if (call++ === 0) throw new Error('凭据已被外部删除')
        return { value: VALID_CREDENTIAL_JSON }
      },
      fetchBalance: async () => BALANCE,
      warn: (msg) => warnings.push(msg),
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'boom' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results).toHaveLength(2)
    expect(results[0]!.error).toBe('凭据已被外部删除')
    expect(results[0]!.balance).toBeNull()
    expect(results[1]!.balance).toEqual(BALANCE)
    expect(warnings).toHaveLength(1)
  })

  it('凭据 JSON 损坏只影响该账号', async () => {
    let call = 0
    const deps = makeDeps({
      resolve: async () => ({ value: call++ === 0 ? '{ not json' : VALID_CREDENTIAL_JSON }),
      fetchBalance: async () => BALANCE,
    })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'corrupt' }), makeEntry({ id: 'ok' })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toBeNull()
    expect(results[0]!.error).toBeDefined()
    expect(results[1]!.balance).toEqual(BALANCE)
  })

  it('停用账号同样查询（停用与余额无关）', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'off', enabled: false })], WORKBUDDY, deps,
    )

    expect(results[0]!.balance).toEqual(BALANCE)
  })

  it('顺序执行，不并发（避免风控）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const deps = makeDeps({
      fetchBalance: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 1))
        inFlight--
        return BALANCE
      },
    })
    await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(maxInFlight).toBe(1)
  })

  it('结果顺序与账号顺序一致', async () => {
    const deps = makeDeps({ fetchBalance: async () => BALANCE })
    const results = await collectCreditBalances(
      [makeEntry({ id: 'a' }), makeEntry({ id: 'b' }), makeEntry({ id: 'c' })], WORKBUDDY, deps,
    )

    expect(results.map(r => r.accountId)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * model.list / model.setDisabled 端点。
 *
 * 这两个端点是 Jet Hub「显示列表」按钮的唯一数据通道，同时串起三件必须
 * 一起正确的事：
 * 1. 列表来自 `ctx.llm.listModels()`（对话框模型选择器读的同一份目录）；
 * 2. 黑名单经 AccountPool 持久化；
 * 3. 关闭后的模型真的从下一次 listModels 的结果里消失。
 *
 * 因此这里用「注册端点 → 通过 HTTP 请求调用 → 断言响应」的方式做端到端
 * 验证，而不是分别测两个函数——两者的衔接正是最容易出错的地方。
 */
describe('model.list / model.setDisabled 端点', () => {
  /** 从 connection.fetch.register 捕获到的处理器。 */
  type Handler = (request: Request) => Promise<Response>

  /** 构造带 RPC 端点所需的 ctx 替身，返回注册进去的 fetch 处理器。 */
  function registerEndpoints(options: {
    models: Array<{ id: string; name: string }>
    disabledModels?: Record<string, Record<string, boolean>>
    /** listModels 抛错时用于验证错误路径。 */
    listModelsError?: string
    /** 省略 llm 服务（验证降级行为）。 */
    withoutLlm?: boolean
  }) {
    // settings 替身：内存里保存 namespace 的值，语义与真实服务一致的
    // 「整体 replace」。
    let stored: Record<string, unknown> = {
      accounts: [],
      ...options.disabledModels !== undefined ? { disabledModels: options.disabledModels } : {},
    }
    let handler: Handler | undefined

    const pool = new AccountPool({
      get: (key: string) => key === 'settings'
        ? {
            register: () => ({
              get: () => stored,
              replace: async (value: Record<string, unknown>) => { stored = value },
            }),
          }
        : undefined,
      logger: { warn: () => {}, info: () => {} },
      credentials: {
        describe: async () => ({ configured: false, writable: true }),
        resolve: async () => undefined,
        set: async () => {},
        unset: async () => {},
      },
    } as never)

    const ctx = {
      get: (key: string) => {
        if (key === 'connection') {
          return {
            fetch: {
              register: (config: { fetch: Handler }) => { handler = config.fetch },
            },
          }
        }
        if (key === 'llm' && options.withoutLlm !== true) {
          return {
            listModels: async (provider: string) => {
              if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
              return options.models.map(m => ({ ...m, provider }))
            },
          }
        }
        return undefined
      },
      logger: { warn: () => {}, info: () => {} },
    }

    registerJetHubRpc(ctx as never, pool, {} as never, {} as never, {} as never)
    if (handler === undefined) throw new Error('endpoint handler was not registered')

    /** 调用一个端点方法，返回解包后的 result。 */
    const call = async (method: string, payload: unknown) => {
      const response = await handler!(new Request('http://localhost/api/jet-hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'rpc-1',
          method: 'jet-hub',
          payload: { method, payload },
        }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: unknown; error?: { message: string } } }
      return body.result
    }

    return { call, pool, storedValue: () => stored }
  }

  const MODELS = [
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'hy3', name: 'Hy3' },
  ]

  it('model.list 回传 llm 的模型目录，并把黑名单回填为 disabled', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', disabled: false },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', disabled: false },
        { id: 'hy3', name: 'Hy3', disabled: true },
      ],
    })
  })

  it('未配置黑名单时全部模型默认打开（黑名单制）', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.list', { provider: 'workbuddy' })
    const models = (result.value as { models: Array<{ disabled: boolean }> }).models

    expect(models.every(m => m.disabled === false)).toBe(true)
  })

  it('黑名单按 provider 隔离', async () => {
    const { call } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const buddy = await call('model.list', { provider: 'buddy' })
    const workbuddy = await call('model.list', { provider: 'workbuddy' })

    const flagOf = (result: unknown, id: string) =>
      (result as { models: Array<{ id: string; disabled: boolean }> }).models.find(m => m.id === id)!.disabled

    expect(flagOf(buddy.value, 'hy3')).toBe(true)
    // 另一个 provider 的同名模型不受影响
    expect(flagOf(workbuddy.value, 'hy3')).toBe(false)
  })

  it('model.setDisabled 持久化到 settings，并在后续 model.list 中生效', async () => {
    const { call, storedValue } = registerEndpoints({ models: MODELS })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: true })
    expect(set.ok).toBe(true)
    expect(set.value).toEqual({ provider: 'buddy', disabledModels: { hy3: true } })
    // 落盘内容可核对：
    expect(storedValue().disabledModels).toEqual({ buddy: { hy3: true } })

    const list = await call('model.list', { provider: 'buddy' })
    const hy3 = (list.value as { models: Array<{ id: string; disabled: boolean }> })
      .models.find(m => m.id === 'hy3')!
    expect(hy3.disabled).toBe(true)
  })

  it('重新打开时从黑名单移除（写 false 不残留）', async () => {
    const { call, storedValue } = registerEndpoints({
      models: MODELS,
      disabledModels: { buddy: { hy3: true } },
    })

    const set = await call('model.setDisabled', { provider: 'buddy', modelId: 'hy3', disabled: false })

    expect(set.value).toEqual({ provider: 'buddy', disabledModels: {} })
    expect(storedValue().disabledModels).toEqual({})
  })

  it('model.setDisabled 缺少 modelId 时返回 bad-request 而不是静默成功', async () => {
    const { call } = registerEndpoints({ models: MODELS })
    const result = await call('model.setDisabled', { provider: 'buddy', modelId: '' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('modelId')
  })

  it('llm 服务不可用时 model.list 返回可读错误（账号面板不受影响）', async () => {
    const { call } = registerEndpoints({ models: MODELS, withoutLlm: true })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('llm 服务不可用')
  })

  it('适配器 listModels 抛错时返回可读错误而不是裸 500', async () => {
    const { call } = registerEndpoints({ models: MODELS, listModelsError: '令牌已过期' })
    const result = await call('model.list', { provider: 'buddy' })

    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('令牌已过期')
  })
})
