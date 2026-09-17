import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  CREDITS_CAPABILITIES,
  supportsCreditBalance,
  supportsDailyCheckin,
} from '../../plugin-src/client/credits-capabilities.js'

/**
 * 积分能力矩阵的回归测试。
 *
 * 真实缺陷（用户报障）：打开 Account Hub 的 **CodeArts** 面板时控制台必现
 * ```
 * [jet-hub] load credits failed: Error: unsupported provider: codearts
 * ```
 * 根因是客户端 `loadCredits()` 在面板挂载时**对所有 provider 无条件**调用
 * `credits.balances`，而该端点以 `productById()` 判能力，CodeArts 根本不是
 * BuddyProduct，必定返回 bad-request。
 *
 * 修法是「请求前按能力门控」。因此这里守两件事：
 * 1. 能力矩阵本身正确（尤其 CodeArts 两项全假、WorkBuddy 余额真/签到假）；
 * 2. 客户端源码里**不存在绕过门控的调用点** —— UI 组件无法在单测里渲染
 *    （react 不在本仓库依赖内），故用源码级断言锁死守卫存在。
 */
describe('积分能力矩阵', () => {
  it('CodeArts 两项能力全为 false（华为云账号体系无腾讯计费接口）', () => {
    expect(CREDITS_CAPABILITIES.codearts).toEqual({ balance: false, dailyCheckin: false })
    expect(supportsCreditBalance('codearts')).toBe(false)
    expect(supportsDailyCheckin('codearts')).toBe(false)
  })

  it('CodeBuddy 余额与签到都支持', () => {
    expect(supportsCreditBalance('buddy')).toBe(true)
    expect(supportsDailyCheckin('buddy')).toBe(true)
  })

  it('WorkBuddy 国际版支持余额但不支持签到（余额与签到是彼此独立的能力）', () => {
    // 这条断言专治「因为国际版没有签到，就推断也查不到余额」的错误推断。
    expect(supportsCreditBalance('workbuddy')).toBe(true)
    expect(supportsDailyCheckin('workbuddy')).toBe(false)
  })

  it('LobsterAI 余额与签到都支持（两套端点彼此独立）', () => {
    // 余额走 GET /api/user/profile-summary，签到走 client-activities 三步流程，
    // 与 CodeBuddy 系协议完全不同源，但两项能力都具备。
    expect(CREDITS_CAPABILITIES.lobsterai).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('lobsterai')).toBe(true)
    expect(supportsDailyCheckin('lobsterai')).toBe(true)
  })

  it('Trae CN 余额与签到都支持（键名带连字符，与后端 provider 实参一致）', () => {
    // 余额走 POST /trae/api/v2/pay/web_user_ent_usage（双池），签到走
    // checkin_credits 两步流程。两项都支持，故面板要渲染积分行与两个按钮。
    //
    // 这条断言同时锁死**键名形态**：`trae-cn` 带连字符，写成 `traeCn` / `trae_cn`
    // 都会让 supportsCreditBalance('trae-cn') 落到「默认关闭」分支 —— 面板静默
    // 不显示积分，而且不报任何错，是最难发现的一类回归。
    expect(CREDITS_CAPABILITIES['trae-cn']).toEqual({ balance: true, dailyCheckin: true })
    expect(supportsCreditBalance('trae-cn')).toBe(true)
    expect(supportsDailyCheckin('trae-cn')).toBe(true)
  })

  it('能力矩阵的键与 PROVIDERS 的 id 逐字对齐（含连字符 provider）', () => {
    // 集合相等那条断言用 PROVIDER_ENTRY_PATTERN 抓 id，而它的字符类必须是
    // `[a-z-]+`：只认小写字母的话，带连字符的 id 抓不到，于是**漏登记时那条
    // 断言依然是绿的**（集合两边都不含它）。这里直接锁死匹配器覆盖 `trae-cn`，
    // 免得将来有人「图省事」把连字符从字符类里去掉。
    const ids = [...readClientSource().matchAll(PROVIDER_ENTRY_PATTERN)].map((m) => m[1]!)
    expect(ids).toContain('trae-cn')
    expect(ids).toContain('lobsterai')
  })

  it('未登记的 provider 默认不支持任何积分能力（默认关闭）', () => {
    // 新增 provider 时若忘记登记，最坏结果是暂时看不到积分，
    // 而不是每次打开面板都发一个必然失败的请求。
    for (const unknown of ['', 'newprovider', 'CODEARTS', '__proto__']) {
      expect(supportsCreditBalance(unknown), unknown).toBe(false)
      expect(supportsDailyCheckin(unknown), unknown).toBe(false)
    }
  })

  it('能力矩阵覆盖 PROVIDERS 中的每一个 provider', () => {
    // 客户端 PROVIDERS 列表与能力表必须同步：漏登记的 provider 会静默失去
    // 积分能力（默认关闭），而多登记的条目则是死配置。
    const source = readClientSource()
    const providerIds = [...source.matchAll(PROVIDER_ENTRY_PATTERN)].map((m) => m[1]!)
    expect(providerIds.length).toBeGreaterThan(0)
    for (const id of providerIds) {
      expect(CREDITS_CAPABILITIES, `缺少 ${id} 的能力登记`).toHaveProperty(id)
    }
    expect(Object.keys(CREDITS_CAPABILITIES).sort()).toEqual([...providerIds].sort())
  })
})

/**
 * `PROVIDERS` 条目的匹配器。
 *
 * `[a-z-]+` 而不是 `[a-z]+`：provider id 允许带连字符（`trae-cn` 就是），
 * 而只认小写字母的正则会让**带连字符的条目在 `PROVIDERS` 里隐形** ——
 * 匹配不进 `providerIds`，于是「集合相等」这条断言在漏登记时反而是绿的。
 */
const PROVIDER_ENTRY_PATTERN = /\{\s*id:\s*'([a-z-]+)',\s*label:/g

/** 读取客户端 bundle 的源码（未打包的 plugin-src 版本）。 */
function readClientSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
}

describe('客户端积分请求门控（源码级回归）', () => {
  const source = readClientSource()

  it('引用了能力矩阵，而不是在本文件里另写一份 provider 字面量判断', () => {
    expect(source).toContain("from './credits-capabilities.js'")
    expect(source).toContain('supportsCreditBalance')
    expect(source).toContain('supportsDailyCheckin')
    // 历史实现里的 CREDITS_PROVIDERS 白名单已删除，不得复辟。
    // 只查「非注释行」：文件里保留了叙述该缺陷的注释，注释提及名字是合理的。
    const codeLines = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(codeLines).not.toContain('CREDITS_PROVIDERS')
  })

  it('loadCredits 在发起 credits.balances 之前先判能力', () => {
    const start = source.indexOf('const loadCredits = React.useCallback')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 1200)
    const guardIndex = body.indexOf('if (!canLoadCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.balances'")
    expect(guardIndex, 'loadCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    // 守卫必须出现在请求之前，否则等于没守
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('挂载副作用只在支持余额时才拉积分（CodeArts 连 loading 状态都不翻）', () => {
    const start = source.indexOf("void loadAccounts();")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    const guardIndex = body.indexOf('if (canLoadCredits) void loadCredits();')
    expect(guardIndex, '挂载副作用缺少能力门控').toBeGreaterThan(-1)
    // 不能存在无条件的 void loadCredits() 调用
    expect(body).not.toMatch(/^\s*void loadCredits\(\);/m)
  })

  it('claimCredits 在发起 credits.claimAll 之前先判能力', () => {
    const start = source.indexOf('const claimCredits')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, start + 600)
    const guardIndex = body.indexOf('if (!supportsCredits) return;')
    const callIndex = body.indexOf("rpcCall('credits.claimAll'")
    expect(guardIndex, 'claimCredits 缺少能力守卫').toBeGreaterThan(-1)
    expect(callIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(callIndex)
  })

  it('「刷新积分」按钮与账号卡片的「积分」行都按能力渲染', () => {
    // 归一化 CRLF：本仓库源码在 Windows 上是 CRLF，直接比对多行字面量会假失败。
    const normalized = source.replace(/\r\n/g, '\n')
    expect(normalized).toMatch(/canLoadCredits\s*\n\s*\? React\.createElement\('button'/)
    expect(normalized).toContain('showCredits: canLoadCredits')
    // AccountCard 必须真的消费 showCredits，否则传了也没用
    const cardStart = normalized.indexOf('function AccountCard(')
    const cardBody = normalized.slice(cardStart, cardStart + 4000)
    expect(cardBody).toContain('showCredits')
    expect(cardBody).toMatch(/showCredits\s*\n?\s*\?[\s\S]*CreditBalanceRow/)
  })
})
