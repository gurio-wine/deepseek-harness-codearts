/**
 * 账号池凭据 → LLM 端到端调用探针。
 *
 * ⚠️ 本用例会向 CodeBuddy 后端发起**真实模型请求，消耗账号积分**。
 *
 * 目的：验证「Account Hub 启用账号后发送消息」这条链路上，适配器能否用账号池里的
 * 凭据正常通信。探针：
 *   1. 读取 Account Hub 账号列表（直接解析 ~/.dsh/settings.yaml）；
 *   2. 取一个已启用的 **Buddy CN**（`provider: buddy-cn`）账号凭据，直接构造 BuddyAdapter；
 *   3. 调用 listModels / resolveModel / prepareCall，并打印每一步返回值；
 *   4. 真正发一次最小流式请求，打印收到的 chunk 摘要。
 *
 * 双重闸门（缺一不可，防止误跑消耗积分）：
 *   DSH_BUDDY_CN_POOL_E2E=1             启用本探针
 *   DSH_BUDDY_CN_POOL_E2E_CONFIRM=yes   显式确认愿意消耗积分
 *
 * 用 `pnpm test:e2e:buddy-cn-pool` 运行（两个变量已内置）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BuddyAdapter } from '../../src/buddy-adapter.js'
import { BUDDY_CN } from '../../src/product.js'
import type { BuddyCredential } from '../../src/buddy.js'

/** 本探针只验证**中国版**（改名后 id 为 `buddy-cn`）。 */
const PROVIDER = 'buddy-cn'

const E2E = process.env.DSH_BUDDY_CN_POOL_E2E === '1'
  && process.env.DSH_BUDDY_CN_POOL_E2E_CONFIRM === 'yes'
const suite = E2E ? describe : describe.skip

/** settings.yaml 里解析出的一个启用账号（只取本探针需要的三列）。 */
interface PoolAccount {
  id: string
  provider: string
  credentialRef: string
}

/**
 * 从 settings.yaml 里解析 Account Hub **指定产品**的首个启用账号
 * （不引 yaml 依赖，按行扫描）。
 *
 * ⚠️ 必须按 provider 过滤，不能取「文件里的第一个账号」：改名后 `buddy-cn` 是
 * 中国版、`buddy` 是国际版，而本探针构造的是中国版适配器 —— 拿国际版账号的
 * token 去打 copilot.tencent.com 必然失败，且失败原因与被测链路无关。
 */
function firstEnabledAccount(productId: string): PoolAccount | undefined {
  const path = join(homedir(), '.dsh', 'settings.yaml')
  const text = readFileSync(path, 'utf8')
  const idx = text.indexOf('jet-hub:')
  if (idx < 0) return undefined
  const block = text.slice(idx)
  // 条目以 4 空格 + `- ` 起始；按此切块后逐条取字段，避免跨条目误配。
  for (const chunk of block.split(/^ {4}-\s+/m).slice(1)) {
    const id = /^\s*id:\s*(\S+)/m.exec(chunk)?.[1]
    const provider = /^\s*provider:\s*(\S+)/m.exec(chunk)?.[1]
    const credentialRef = /^\s*credentialRef:\s*(\S+)/m.exec(chunk)?.[1]
    if (id === undefined || credentialRef === undefined) continue
    if (provider !== productId) continue
    if (/^\s*enabled:\s*false/m.test(chunk)) continue
    return { id, provider, credentialRef }
  }
  return undefined
}

/** 从 .credentials.yaml 里取某个 ref 的凭据 JSON。 */
function credentialFor(ref: string): BuddyCredential {
  const path = join(homedir(), '.dsh', '.credentials.yaml')
  const text = readFileSync(path, 'utf8')
  const idx = text.indexOf(`${ref}:`)
  expect(idx, `凭据 ${ref} 未找到`).toBeGreaterThan(-1)
  const rest = text.slice(idx)
  const first = rest.indexOf('{')
  let depth = 0, inStr = false, esc = false, end = -1
  for (let i = first; i < rest.length; i++) {
    const ch = rest[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  const raw = rest.slice(first, end + 1).replace(/''/g, "'")
  return JSON.parse(raw) as BuddyCredential
}

suite('账号池凭据 → Buddy CN LLM 调用探针', () => {
  it('用启用账号的凭据完成一次最小流式调用', async () => {
    const account = firstEnabledAccount(PROVIDER)
    console.log('\n===== Account Hub 首个 Buddy CN 账号 =====')
    console.log(account ?? '(未找到)')
    expect(
      account,
      '未找到已启用的 Buddy CN（provider: buddy-cn）账号。注意改名后 `buddy` 是国际版，'
        + '本探针只测中国版，因此必须取 `buddy-cn` 的账号。',
    ).toBeDefined()

    const refName = process.env.DSH_BUDDY_CN_ACCOUNT_REF ?? account!.credentialRef
    const credential = credentialFor(refName)
    console.log('\n===== 凭据摘要 =====')
    console.log(`  ref          = ${refName}`)
    console.log(`  nickname     = ${JSON.stringify(credential.nickname)}`)
    console.log(`  expires_at   = ${JSON.stringify(credential.expires_at)}`)
    console.log(`  domain       = ${JSON.stringify(credential.domain)}`)
    console.log(`  has access   = ${credential.access_token.length > 0}`)
    console.log(`  has refresh  = ${credential.refresh_token.length > 0}`)

    const adapter = new BuddyAdapter({
      credentialRef: refName as never,
      resolveCredential: async () => credential,
      refresh: async () => { console.log('  [refresh] 被调用') },
      sessionId: 'probe-session',
      // 显式指定产品（默认值即 Buddy CN）。写出来是为了让「本探针只测中国版」
      // 成为代码里的可见事实，而不是依赖构造器默认值。
      product: BUDDY_CN,
    })

    // ── 1. providerInfo ──
    const info = adapter.providerInfo(PROVIDER)
    console.log('\n===== providerInfo =====')
    console.log(`  id   = ${JSON.stringify(info.id)} (typeof ${typeof info.id})`)
    console.log(`  name = ${JSON.stringify(info.name)}`)
    // DSH 会强制校验 info.id === provider
    expect(info.id).toBe(PROVIDER)
    expect(typeof info.name).toBe('string')
    expect(info.name.length).toBeGreaterThan(0)

    // ── 2. listModels ──
    const models = await adapter.listModels(PROVIDER)
    console.log('\n===== listModels =====')
    console.log(`  共 ${models.length} 个模型`)
    for (const m of models.slice(0, 5)) {
      console.log(`  ${m.provider} / ${m.id} / ${JSON.stringify(m.name)} (typeof name=${typeof m.name})`)
    }
    expect(models.length).toBeGreaterThan(0)
    // 模型设置的 deriveKeyRef(provider) 要求 provider 是非空字符串
    for (const m of models) {
      expect(typeof m.provider).toBe('string')
      expect(m.provider).toBe(PROVIDER)
      expect(typeof m.id).toBe('string')
      expect(typeof m.name).toBe('string')
      expect(m.name.length).toBeGreaterThan(0)
    }

    // ── 3. resolveModel（DSH 的 normalizeModelInfo 会严格校验）──
    const targetModel = 'deepseek-v4.1-flash'
    const resolved = await adapter.resolveModel(PROVIDER, targetModel)
    console.log('\n===== resolveModel =====')
    console.log(`  provider = ${JSON.stringify(resolved.provider)}`)
    console.log(`  id       = ${JSON.stringify(resolved.id)}`)
    console.log(`  name     = ${JSON.stringify(resolved.name)}`)
    console.log(`  context  = ${JSON.stringify(resolved.context)}`)
    expect(resolved.provider).toBe(PROVIDER)
    expect(resolved.id).toBe(targetModel)
    expect(typeof resolved.name).toBe('string')

    // ── 4. prepareCall 契约 ──
    const prepared = await adapter.prepareCall(PROVIDER, targetModel)
    console.log('\n===== prepareCall =====')
    console.log(`  model.provider = ${JSON.stringify(prepared.model.provider)}`)
    console.log(`  model.id       = ${JSON.stringify(prepared.model.id)}`)
    console.log(`  model.name     = ${JSON.stringify(prepared.model.name)}`)
    console.log(`  stream 是函数?  ${typeof prepared.stream === 'function'}`)
    expect(typeof prepared.stream).toBe('function')
    expect(prepared.model.provider).toBe(PROVIDER)
    expect(prepared.model.id).toBe(targetModel)

    // ── 5. 真实流式调用 ──
    console.log('\n===== 真实流式调用 =====')
    let text = ''
    let chunks = 0
    try {
      for await (const chunk of prepared.stream({
        model: targetModel,
        messages: [{ role: 'user', content: '只回答两个字：收到' }],
        system: 'You are a helpful assistant.',
      })) {
        chunks++
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunks <= 3) console.log(`  chunk#${chunks}: ${JSON.stringify(chunk).slice(0, 160)}`)
      }
      console.log(`\n  共收到 ${chunks} 个 chunk`)
      console.log(`  文本 = ${JSON.stringify(text.slice(0, 120))}`)
    } catch (error) {
      console.log('\n  !! 调用抛出异常 !!')
      console.log(`  message = ${error instanceof Error ? error.message : String(error)}`)
      console.log(`  stack:\n${error instanceof Error ? error.stack : '(no stack)'}`)
      throw error
    }
    expect(chunks).toBeGreaterThan(0)
  }, 180_000)
})
