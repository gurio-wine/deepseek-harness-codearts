import { describe, expect, it, vi } from 'vitest'
import {
  TRAE_CN_APP_VERSION,
  TRAE_CN_BALANCE_ARRAY_KEYS,
  TRAE_CN_BALANCE_REMAIN_FIELDS,
  TRAE_CN_CHECKIN_CLAIM_PATH,
  TRAE_CN_CHECKIN_REQ_SOURCE,
  TRAE_CN_CHECKIN_STATUS_PATH,
  TRAE_CN_CODE_CREDENTIAL_INVALID,
  TRAE_CN_DEVICE_TYPE,
  TRAE_CN_OS_VERSION,
  TRAE_CN_POOL_UNIVERSAL,
  TRAE_CN_POOL_WORK,
  TRAE_CN_USER_ENT_USAGE_PATH,
  claimTraeCnDailyCheckin,
  fetchTraeCnCheckinStatus,
  fetchTraeCnCreditBalance,
  traeCnCreditsHeaders,
  traeCnPoolName,
} from '../../src/trae-cn-credits.js'
import { TRAE_CN } from '../../src/trae-cn-product.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'

/**
 * 设备号（签到 `x-device-id` 的来源）。
 *
 * ✅ **T9 已校准（2026-09-18）**：服务端**不校验设备号形态** —— 16 位十进制号、
 * `BoundDeviceID`（14 位字母数字）、空串返回逐字节相同，只有完全不带设备头时
 * 才 `did_checked_in:false`。故本用例只断言「凭据里的值被原样发出去」，
 * 不假设服务端接受哪种形态。
 */
const DEVICE_ID = '7212345678901234'

function makeCredential(overrides: Partial<TraeCnCredential> = {}): TraeCnCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: DEVICE_ID,
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    nickname: '测试',
    ...overrides,
  }
}

/** 记录请求并按 URL 分派的 stub fetch。 */
function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** 从一次请求里解出请求头（Headers 实例或普通对象都可）。 */
function headersOf(init?: RequestInit): Record<string, string> {
  const headers = new Headers(init?.headers)
  const result: Record<string, string> = {}
  headers.forEach((value, key) => { result[key] = value })
  return result
}

/** 未签到 + 领取成功的标准响应集。 */
function happyPath(overrides: {
  status?: Record<string, unknown>
  claim?: Record<string, unknown>
} = {}) {
  return (url: string) => {
    if (url.includes('/claim')) {
      return new Response(JSON.stringify({
        code: 0, msg: 'OK', data: { credit: 100, ...overrides.claim },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      code: 0, msg: 'OK', data: { checked_in: false, enable: true, ...overrides.status },
    }), { status: 200 })
  }
}

describe('Trae CN 签到端点常量', () => {
  it('路径与调研实测一致', () => {
    expect(TRAE_CN_CHECKIN_STATUS_PATH).toBe('/trae/api/v2/ug/checkin_credits/status')
    expect(TRAE_CN_CHECKIN_CLAIM_PATH).toBe('/trae/api/v2/ug/checkin_credits/claim')
    expect(TRAE_CN_USER_ENT_USAGE_PATH).toBe('/trae/api/v2/pay/web_user_ent_usage')
  })

  it('请求体固定带 req_source:1（唯一次实测成功的组合）', async () => {
    expect(TRAE_CN_CHECKIN_REQ_SOURCE).toBe(1)
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ req_source: 1 })
  })

  it('设备头常量为实测值（且非 xxxxx 占位）', () => {
    expect(TRAE_CN_DEVICE_TYPE).toBe('windows')
    expect(TRAE_CN_APP_VERSION).toBe('3.3.100')
    // x-os-version 必须是形态合法的 Windows 版本号：留 `Windows 10.0.xxxxx`
    // 这种脱敏字面量一定过不了服务端校验。
    expect(TRAE_CN_OS_VERSION).toMatch(/^Windows 10\.0\.\d+$/)
  })
})

describe('traeCnCreditsHeaders（设备头构造）', () => {
  it('x-device-id 来自凭据里的 Aha 设备号', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers['x-device-id']).toBe(DEVICE_ID)
  })

  it('设备四件套齐全（claim 缺一个就回 9004）', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers['x-device-id']).toBeTruthy()
    expect(headers['x-device-type']).toBe('windows')
    expect(headers['x-os-version']).toBe(TRAE_CN_OS_VERSION)
    expect(headers['x-app-version']).toBe(TRAE_CN_APP_VERSION)
  })

  it('鉴权三头同值，且不是 Bearer', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers.Authorization).toBe('Cloud-IDE-JWT AT')
    expect(headers['X-Ide-Token']).toBe('AT')
    expect(headers['X-Cloudide-Token']).toBe('AT')
    expect(headers.Authorization).not.toContain('Bearer')
  })

  it('Origin / Referer 取产品 portalBase（编译期常量，不从凭据推断）', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers.Origin).toBe('https://www.trae.cn')
    expect(headers.Referer).toBe('https://www.trae.cn')
  })

  it('不发腾讯系 / LobsterAI 的归属头', () => {
    const headers = traeCnCreditsHeaders(makeCredential(), TRAE_CN)
    expect(headers['X-Domain']).toBeUndefined()
    expect(headers['X-Product-Code']).toBeUndefined()
    expect(Object.keys(headers).some((key) => key.startsWith('X-LobsterAI'))).toBe(false)
  })

  it('请求头带设备四件套且 host 为 api.trae.cn', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    const headers = headersOf(calls[0]!.init)
    expect(headers['x-device-id']).toBe(DEVICE_ID)
    expect(headers['x-device-type']).toBe('windows')
    expect(new URL(calls[0]!.url).origin).toBe('https://api.trae.cn')
    expect(calls[0]!.init!.method).toBe('POST')
  })
})

describe('fetchTraeCnCheckinStatus', () => {
  it('解析 checked_in 与 enable', async () => {
    const { fetcher } = stubFetch(happyPath({ status: { checked_in: true } }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status).not.toBeNull()
    expect(status!.todayCheckedIn).toBe(true)
    expect(status!.active).toBe(true)
  })

  it('用 checked_in 而**不是** did_checked_in 作幂等判据', async () => {
    // 设备级语义的 did_checked_in 为 true、账号级 checked_in 为 false：
    // 若实现读错字段就会误判「今天已签到」。
    const { fetcher } = stubFetch(happyPath({ status: { checked_in: false, did_checked_in: true } }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.todayCheckedIn).toBe(false)
  })

  it('checked_in 在根对象上也认（信封层级容错）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, checked_in: true, data: { enable: true },
    }), { status: 200 }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.todayCheckedIn).toBe(true)
  })

  it('enable 显式 false 时 active 为 false', async () => {
    const { fetcher } = stubFetch(happyPath({ status: { enable: false } }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.active).toBe(false)
  })

  it('enable 缺失时 active 视为 true（不把省略当关闭）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: 0, data: { checked_in: false },
    }), { status: 200 }))
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status!.active).toBe(true)
  })

  it('无实测依据的字段一律取零值（不臆造状态）', async () => {
    const { fetcher } = stubFetch(happyPath())
    const status = await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })
    expect(status).toMatchObject({
      streakDays: 0, dailyCredit: 0, todayCredit: 0, isStreakDay: false,
      totalCredits: 0, checkinDates: [], activityName: '', themeName: '', endTime: '',
    })
  })

  it('code:1001（无 auth 的失效形态）返回 null —— 与「未签到」区分', async () => {
    // 实测：不带 auth 时是 HTTP 200 + code:1001 + enable:false，不是 401。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID, msg: 'unauthorized', data: { enable: false },
    }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('HTTP 200 但 code 非 0 返回 null（判定以 body code 为准）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ code: 9004 }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('响应缺 code 字段返回 null（不当作成功）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('网络失败返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('响应不是 JSON 对象返回 null', async () => {
    const { fetcher } = stubFetch(() => new Response('[1,2,3]', { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })
})

describe('claimTraeCnDailyCheckin', () => {
  it('未签到时走 status → claim 两步并返回 claimed', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 100, streakDays: 0, isStreakDay: false })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toContain('/status')
    expect(calls[1]!.url).toContain('/claim')
  })

  it('两个请求都是 POST 且带 req_source:1', async () => {
    const { fetcher, calls } = stubFetch(happyPath())
    await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    for (const call of calls) {
      expect(call.init!.method).toBe('POST')
      expect(JSON.parse(String(call.init!.body))).toEqual({ req_source: 1 })
    }
  })

  it('checked_in=true 时返回 already-claimed 且**不发**领取请求', async () => {
    const { fetcher, calls } = stubFetch(happyPath({ status: { checked_in: true } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toEqual({ kind: 'already-claimed', message: '今天已签到' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/status')
  })

  it('enable=false 时返回 inactive 且不发领取请求', async () => {
    const { fetcher, calls } = stubFetch(happyPath({ status: { enable: false } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('inactive')
    expect(calls).toHaveLength(1)
  })

  it('状态查询 code:1001 → failed 且文案说明凭据失效', async () => {
    const { fetcher, calls } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID, enable: false,
    }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(TRAE_CN_CODE_CREDENTIAL_INVALID)
    expect((outcome as { message: string }).message).toBe('凭据已失效，请重新登录')
    expect(calls).toHaveLength(1)
  })

  it('领取 code:1001 → failed 且文案说明凭据失效', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? new Response(JSON.stringify({ code: TRAE_CN_CODE_CREDENTIAL_INVALID }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { message: string }).message).toBe('凭据已失效，请重新登录')
  })

  it('领取 code:9004 → failed，且文案指向设备头待校准', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? new Response(JSON.stringify({ code: 9004, msg: 'device not allowed' }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(9004)
    const message = (outcome as { message: string }).message
    expect(message).toContain('9004')
    expect(message).toContain('x-os-version')
  })

  it('领取响应缺积分字段时按 0 计并留调试行（不发明字段名）', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(happyPath({ claim: { credit: undefined, mystery_field: 7 } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 0 })
    expect(debug.some((line) => line.includes('未命中积分字段候选表'))).toBe(true)
    // 脱敏：只报字段名，不报值。
    expect(debug.join('\n')).not.toContain('7')
  })

  it('领取响应带 msg 时作为 delayedMessage 透出', async () => {
    const { fetcher } = stubFetch(happyPath({ claim: { credit: 50, msg: '明天再来' } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 50, delayedMessage: '明天再来' })
  })

  it('字符串形态的积分也能解析', async () => {
    const { fetcher } = stubFetch(happyPath({ claim: { credit: '88.5' } }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome).toMatchObject({ kind: 'claimed', credit: 88.5 })
  })

  it('网络失败 → failed 且 code 为 -1', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { code: number }).code).toBe(-1)
    expect((outcome as { message: string }).message).toContain('签到状态查询失败')
  })
})

// ─────────────────────────────────────────────────────────────
// 积分余额（双池）
// ─────────────────────────────────────────────────────────────

/** 构造一个礼包条目。 */
function gift(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_endpoint: TRAE_CN_POOL_UNIVERSAL,
    name: '礼包',
    remain_amount: 100,
    total_amount: 200,
    ...overrides,
  }
}

/** 余额 stub：按给定礼包数组返回成功响应。 */
function balanceFetch(gifts: Record<string, unknown>[], wrap: (gifts: unknown[]) => unknown = (g) => ({
  code: 0, msg: 'OK', data: { packages: g },
})) {
  return stubFetch(() => new Response(JSON.stringify(wrap(gifts)), { status: 200 }))
}

describe('fetchTraeCnCreditBalance', () => {
  it('请求体是 {"require_usage":true}，端点为 web_user_ent_usage', async () => {
    const { fetcher, calls } = balanceFetch([gift()])
    await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(new URL(calls[0]!.url).pathname).toBe(TRAE_CN_USER_ENT_USAGE_PATH)
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ require_usage: true })
    expect(calls[0]!.init!.method).toBe('POST')
  })

  it('双池拆分：通用池之和为主数字，Work 池单独给 workTotal', async () => {
    const { fetcher } = balanceFetch([
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 54.22, name: '礼包A' }),
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, remain_amount: 100, name: '礼包B' }),
      gift({ available_endpoint: TRAE_CN_POOL_WORK, remain_amount: 2000, name: 'Work礼包' }),
    ])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance).not.toBeNull()
    // 主数字**只**是通用池：154.22，不是 2154.22。
    expect(balance!.total).toBe(154.22)
    expect(balance!.workTotal).toBe(2000)
    expect(balance!.pools).toHaveLength(2)
    expect(balance!.pools.find((pool) => pool.endpoint === TRAE_CN_POOL_UNIVERSAL)!.total).toBe(154.22)
    expect(balance!.pools.find((pool) => pool.endpoint === TRAE_CN_POOL_WORK)!.total).toBe(2000)
  })

  it('两池名字可读（供 UI 显示「通用 154.22 / Work 2000」）', () => {
    expect(traeCnPoolName(TRAE_CN_POOL_UNIVERSAL)).toBe('通用积分')
    expect(traeCnPoolName(TRAE_CN_POOL_WORK)).toBe('Work 积分')
    expect(traeCnPoolName(7)).toContain('7')
  })

  it('packages 是两池混排的扁平明细（CreditBalance 契约）', async () => {
    const { fetcher } = balanceFetch([
      gift({ available_endpoint: TRAE_CN_POOL_UNIVERSAL, name: '通用包' }),
      gift({ available_endpoint: TRAE_CN_POOL_WORK, name: 'Work包' }),
    ])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.packages).toHaveLength(2)
    // 非通用池的包名带池前缀：tooltip 是逐行渲染的，不带前缀会让 2000
    // 看起来像通用额度。
    expect(balance!.packages.map((pkg) => pkg.name)).toEqual(['通用包', '[Work 积分] Work包'])
  })

  it('缺 available_endpoint 的礼包归入通用池', async () => {
    const { fetcher } = balanceFetch([{ name: '无名池', remain_amount: 30 }])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.total).toBe(30)
    expect(balance!.pools).toHaveLength(1)
    expect(balance!.pools[0]!.endpoint).toBe(TRAE_CN_POOL_UNIVERSAL)
  })

  it('余额字段候选表：remain 类字段优先', async () => {
    for (const field of ['remain_amount', 'remaining_amount', 'remain', 'balance']) {
      const { fetcher } = balanceFetch([{ available_endpoint: 0, name: 'x', [field]: 12.5 }])
      const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
      expect(balance!.total, field).toBe(12.5)
    }
  })

  it('字段容错：余额 = total_amount - 已用', async () => {
    const { fetcher } = balanceFetch([{
      available_endpoint: 0, name: 'x', total_amount: 4500, used_amount: 300,
    }])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.packages[0]!.remaining).toBe(4200)
    expect(balance!.packages[0]!.total).toBe(4500)
  })

  it('字段容错：只有 total_amount 时按余额计，且 total 置 0（不伪装成 1:1）', async () => {
    const { fetcher } = balanceFetch([{ available_endpoint: 0, name: 'x', total_amount: 4650 }])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.packages[0]!.remaining).toBe(4650)
    expect(balance!.packages[0]!.total).toBe(0)
  })

  it('礼包数组按名字找不到时，按 available_endpoint 指纹扫描兜底', async () => {
    const { fetcher } = balanceFetch([], () => ({
      code: 0,
      data: { usage: { detail: { mystery_array: [{ available_endpoint: 0, remain_amount: 42 }] } } },
    }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.total).toBe(42)
  })

  it('同名用量数组不会被误当成礼包数组（指纹优先于键名）', async () => {
    // `require_usage:true` 下响应里可能同时有已用量的 `list` 与带分池指纹的
    // `gift_list`。只按候选键名取第一个会把用量当余额读出来。
    const debug: string[] = []
    const { fetcher } = balanceFetch([], () => ({
      code: 0,
      data: {
        list: [{ date: '2026-09-01', used: 1000 }],
        gift_list: [{ available_endpoint: 0, remain_amount: 42 }],
      },
    }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(balance!.total).toBe(42)
    expect(debug.some((line) => line.includes('data.gift_list') && line.includes('已按分池指纹确认'))).toBe(true)
  })

  it('候选键名命中但无指纹时回退使用，并在调试行标注「未确认」', async () => {
    const debug: string[] = []
    const { fetcher } = balanceFetch([], () => ({
      code: 0,
      data: { packages: [{ name: 'x', remain_amount: 7 }] },
    }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(balance!.total).toBe(7)
    expect(debug.some((line) => line.includes('未确认'))).toBe(true)
  })

  it('名字命中空数组时返回 0（服务端明确说没有礼包）而不是 null', async () => {
    const { fetcher } = balanceFetch([], () => ({ code: 0, data: { packages: [] } }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance).not.toBeNull()
    expect(balance!.total).toBe(0)
    expect(balance!.pools).toEqual([])
  })

  it('多包浮点相加规整为两位小数', async () => {
    const { fetcher } = balanceFetch([
      { available_endpoint: 0, remain_amount: 55.67000031 },
      { available_endpoint: 0, remain_amount: 99.99999999 },
    ])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.total).toBe(155.67)
  })

  it('负余额 clamp 到 0（不显示 -12.5 积分）', async () => {
    const { fetcher } = balanceFetch([{ available_endpoint: 0, remain_amount: -12.5 }])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.total).toBe(0)
    expect(balance!.packages[0]!.remaining).toBe(0)
  })

  it('已过失效时间的礼包标 active:false 并计入 expiredTotal（不并入 total）', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const { fetcher } = balanceFetch([
      { available_endpoint: 0, name: '有效', remain_amount: 10 },
      { available_endpoint: 0, name: '过期', remain_amount: 99, expire_time: past },
    ])
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.total).toBe(10)
    expect(balance!.expiredTotal).toBe(99)
    expect(balance!.packages.find((pkg) => pkg.name === '过期')!.active).toBe(false)
  })

  it('领取后 total_amount 由 4500 变 4650 的形态可被读成余额', async () => {
    // 调研给出的唯一可核对数字：签到后总额抬升 150。
    const before = balanceFetch([{ available_endpoint: 0, total_amount: 4500 }])
    const after = balanceFetch([{ available_endpoint: 0, total_amount: 4650 }])
    const b1 = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher: before.fetcher })
    const b2 = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher: after.fetcher })
    expect(b2!.total - b1!.total).toBe(150)
  })

  it('查不到（找不到礼包数组）返回 null + 调试行，**不是** 0 积分', async () => {
    const debug: string[] = []
    const { fetcher } = balanceFetch([], () => ({ code: 0, data: { unrelated: 1 } }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(balance).toBeNull()
    expect(debug.some((line) => line.includes('找不到礼包数组'))).toBe(true)
  })

  it('网络失败返回 null', async () => {
    const fetcher = vi.fn(async () => { throw new Error('timeout') }) as unknown as typeof fetch
    expect(await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('code:1001 返回 null（凭据失效 = 查不到，不显示成 0）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID,
    }), { status: 200 }))
    expect(await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('调试行只输出键名，不输出金额', async () => {
    const debug: string[] = []
    const { fetcher } = balanceFetch([{ available_endpoint: 0, remain_amount: 1234.56, secret: 'SK' }])
    await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    const joined = debug.join('\n')
    expect(joined).toContain('remain_amount')
    expect(joined).not.toContain('1234.56')
    expect(joined).not.toContain('SK')
  })

  it('候选表与实现同源（防止改常量不改实现）', () => {
    expect(TRAE_CN_BALANCE_ARRAY_KEYS).toContain('packages')
    expect(TRAE_CN_BALANCE_REMAIN_FIELDS).toContain('remain_amount')
  })
})

// ─────────────────────────────────────────────────────────────
// 真机校准（2026-09-18）：无 code 信封 + 嵌套 credits_limit / credits_amount
// ─────────────────────────────────────────────────────────────

/**
 * 真机 `web_user_ent_usage` 的响应样例（字段名与层级照抄实测，数值用实测值）。
 *
 * 两个**已实证**的形态差异正是本节要锁住的：
 *
 * 1. **顶层没有 `code` 字段**。原实现按 code 信封判定，直接 `return` 失败
 *    （「响应缺少 code 字段」）→ 余额**恒失败**，与「余额为 0」无关。
 * 2. 礼包数组的真名是根层的 `user_entitlement_pack_list`，且额度**嵌在**
 *    `entitlement_base_info.product_extra.package_extra.quota.credits_limit`，
 *    已用在 `usage.credits_amount`。只看顶层的读法会全部 miss → 每个包算 0。
 *
 * 真机响应里的包名字段**未在校准结论中列出**，故 fixture 只用已登记的
 * `name` 候选，不对名字做任何断言（断言按 `available_endpoint` 定位礼包）。
 */
function realDeviceBalanceResponse(): Record<string, unknown> {
  return {
    is_credits_billing: true,
    is_dollar_usage_billing: false,
    is_pay_freshman: false,
    trial_status: { is_in_trial: false },
    usage_summary: { consumed_amount: 2650, total_amount: 4650 },
    user_entitlement_pack_list: [
      {
        // endpoint=0 通用池：2000 用满 → 余额 0。
        entitlement_base_info: {
          available_endpoint: TRAE_CN_POOL_UNIVERSAL,
          entitlement_id: 'ent-universal',
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
          quota: { credits_limit: 9999 },
        },
        usage: { credits_amount: 2000 },
      },
      {
        // endpoint=1 Work 池：usage 为 `{}`（该包未产生用量）→ 按 0 计 → 余额 2000。
        entitlement_base_info: {
          available_endpoint: TRAE_CN_POOL_WORK,
          entitlement_id: 'ent-work',
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
          quota: { credits_limit: 2000 },
        },
        usage: {},
      },
    ],
  }
}

describe('fetchTraeCnCreditBalance —— 真机样例（2026-09-18 校准）', () => {
  it('无 code 信封也判成功（不再报「响应缺少 code 字段」）', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(balance).not.toBeNull()
    // 原缺陷的原文案绝不能出现 —— 那正是「余额恒失败」的直接原因。
    expect(debug.join('\n')).not.toContain('响应缺少 code 字段')
    expect(debug.join('\n')).not.toContain('余额查询失败')
  })

  it('真机样例：通用池 0 / Work 池 2000（双池不合并）', async () => {
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance).not.toBeNull()
    // endpoint=0 包 limit 2000 − consumed 2000 = 0；endpoint=1 包 limit 2000 − 0 = 2000。
    expect(balance!.total).toBe(0)
    expect(balance!.workTotal).toBe(2000)
    // 主数字**只**是通用池：合并会得到 2000，让用户以为 Work 额度能用于对话。
    expect(balance!.total).not.toBe(balance!.total + balance!.workTotal)
    expect(balance!.pools.map((pool) => pool.endpoint)).toEqual([TRAE_CN_POOL_UNIVERSAL, TRAE_CN_POOL_WORK])
  })

  it('嵌套口径生效：credits_limit 与 credits_amount 都被读到', async () => {
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    // 按 endpoint 定位（包名字段未在校准结论中，不做名字断言）。
    const universal = balance!.pools.find((pool) => pool.endpoint === TRAE_CN_POOL_UNIVERSAL)!
      .packages[0]!
    expect(universal.total).toBe(2000)
    expect(universal.used).toBe(2000)
    expect(universal.remaining).toBe(0)

    const work = balance!.pools.find((pool) => pool.endpoint === TRAE_CN_POOL_WORK)!
      .packages[0]!
    // usage:{} ⇒ 已用按 0（不是「查不到」）。
    expect(work.total).toBe(2000)
    expect(work.used).toBe(0)
    expect(work.remaining).toBe(2000)
  })

  it('礼包数组从根层 user_entitlement_pack_list 定位，且按分池指纹确认为可信', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(
      JSON.stringify(realDeviceBalanceResponse()), { status: 200 },
    ))
    await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    const joined = debug.join('\n')
    // 真机响应**没有** `data` 层，礼包数组就在根上 —— 路径必须如实报 root，
    // 而不是回退层被误标成 data（那会让真机校准时找不到数组的真实位置）。
    expect(joined).toContain('root.user_entitlement_pack_list')
    expect(joined).not.toContain('data.user_entitlement_pack_list')
    // 真机的 available_endpoint 嵌在 entitlement_base_info 里，指纹扫描必须
    // 认得出它 —— 否则会退化成「仅按候选键名命中」的不可信路径。
    expect(joined).toContain('已按分池指纹确认')
    expect(joined).not.toContain('未确认')
  })

  it('嵌套 credits_limit 优先于同层 quota.credits_limit', async () => {
    // 两个路径同时存在且取值不同（2000 vs 9999）：必须取 package_extra 那一个。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [{
        entitlement_base_info: {
          available_endpoint: 0,
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
          quota: { credits_limit: 9999 },
        },
        usage: { credits_amount: 500 },
      }],
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.packages[0]!.total).toBe(2000)
    expect(balance!.total).toBe(1500)
  })

  it('package_extra 缺失时回退 entitlement_base_info.quota.credits_limit', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [{
        entitlement_base_info: { available_endpoint: 0, quota: { credits_limit: 800 } },
        usage: { credits_amount: 300 },
      }],
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.total).toBe(500)
    expect(balance!.packages[0]!.total).toBe(800)
  })

  it('usage 缺失时已用按 0（未产生用量 ≠ 查不到）', async () => {
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [{
        entitlement_base_info: {
          available_endpoint: 0,
          product_extra: { package_extra: { quota: { credits_limit: 2000 } } },
        },
      }],
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, { fetcher })
    expect(balance!.total).toBe(2000)
    expect(balance!.packages[0]!.used).toBe(0)
  })

  it('只有 usage_summary（无礼包数组）时不再按 code 判失败，而是找不到数组返回 null', async () => {
    // `usage_summary` 也是 trae-pay 信封特征字段，故**不会**被报成
    // 「响应缺少 code 字段」——失败原因如实指向「找不到礼包数组」。
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      is_credits_billing: true,
      usage_summary: { consumed_amount: 2650, total_amount: 4650 },
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(balance).toBeNull()
    expect(debug.join('\n')).toContain('找不到礼包数组')
    expect(debug.join('\n')).not.toContain('响应缺少 code 字段')
  })

  it('业务失败仍按 code 报错（code:1001 凭据失效的翻译不丢）', async () => {
    // 「无 code 信封」不等于「忽略 code」：服务端真返回非 0 码时照样失败。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      code: TRAE_CN_CODE_CREDENTIAL_INVALID,
      user_entitlement_pack_list: [],
    }), { status: 200 }))
    const debug: string[] = []
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(balance).toBeNull()
    expect(debug.join('\n')).toContain('余额查询失败')
  })

  it('既无 code 也无信封特征字段时仍判失败（不把垃圾响应当成功）', async () => {
    const debug: string[] = []
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      mystery: 'payload',
    }), { status: 200 }))
    const balance = await fetchTraeCnCreditBalance(makeCredential(), TRAE_CN, {
      fetcher, onDebug: (message) => debug.push(message),
    })
    expect(balance).toBeNull()
    expect(debug.join('\n')).toContain('无余额信封特征字段')
  })
})

describe('签到端点不受余额信封改动影响（仍按 code 判定）', () => {
  it('status 响应缺 code 时仍返回 null（信封宽松只对余额端点生效）', async () => {
    // 若把「结构特征即成功」误推广到签到端点，一次失败的领取会被报成
    // 「已领取」—— 比报失败更糟。这条断言就是那道边界。
    const { fetcher } = stubFetch(() => new Response(JSON.stringify({
      user_entitlement_pack_list: [], usage_summary: {},
    }), { status: 200 }))
    expect(await fetchTraeCnCheckinStatus(makeCredential(), TRAE_CN, { fetcher })).toBeNull()
  })

  it('claim 响应缺 code 时不返回 claimed', async () => {
    const { fetcher } = stubFetch((url) => url.includes('/claim')
      ? new Response(JSON.stringify({ credit: 100 }), { status: 200 })
      : new Response(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }), { status: 200 }))
    const outcome = await claimTraeCnDailyCheckin(makeCredential(), TRAE_CN, { fetcher })
    expect(outcome.kind).toBe('failed')
  })
})
