import { LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { CHAT_API_BASE, CodeArtsAdapter } from '../../src/llm-adapter.js'
import { BuddyAdapter, DEFAULT_MODEL } from '../../src/buddy-adapter.js'
import { isQuotaExhausted } from '../../src/llm-adapter.js'
import type { BuddyCredential } from '../../src/buddy.js'
import type { CodeArtsCredential } from '../../src/types.js'

/**
 * 账号积分/额度耗尽（而非模型级限流）必须同样触发自动换号。
 *
 * 历史缺陷（用户报障）：适配器的换号分支只在 `isRateLimited`（6004 业务码 /
 * 频率限制文案）时进入。腾讯后端在**账号积分/额度耗尽**时返回的是另一种错误
 * ——业务码 `11114`，msg 形如「积分不足，请前往购买」/「资源已用尽」/
 * 「The credits are insufficient」。这类报文既不匹配 `RATE_LIMIT_PATTERN`，
 * 也不是 6004，于是换号分支被整体跳过：错误直接抛给用户（HTTP 400 还把它
 * 退化成 INVALID_REQUEST），用户只能手动停用那个没额度的账号。
 *
 * DSH 上游虽有 `isQuotaExceededError`，但它只覆盖英文措辞；腾讯后端实测返回
 * 中文文案，故不能只依赖它。
 */

/** 账号 A 的凭据（与 resolveCredential 的返回值一致）。 */
function makeBuddyCredential(overrides: Partial<BuddyCredential> = {}): BuddyCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    token_type: 'Bearer',
    scope: '',
    domain: 'copilot.tencent.com',
    ...overrides,
  }
}

/** 将 SSE 文本包装为流式 Response。 */
function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

const OK_SSE = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

/** 收集流中所有 chunk；流抛错时 reject。 */
async function collectBuddyChunks(adapter: BuddyAdapter, options: never): Promise<Array<Record<string, any>>> {
  const chunks: Array<Record<string, any>> = []
  for await (const chunk of adapter.stream(options as never)) {
    chunks.push(chunk as unknown as Record<string, any>)
  }
  return chunks
}

/** 积分耗尽的真实报文形态：业务码 11114 + 中文文案。 */
const QUOTA_BODY_CN = JSON.stringify({
  code: 11114,
  msg: '积分不足，请前往购买',
  requestId: '3f2a1c40-0000-4000-8000-000000000001',
})

/** 同一业务码的字符串编码变体（编码兼容）。 */
const QUOTA_BODY_STRING_CODE = JSON.stringify({
  code: '11114',
  msg: '资源已用尽',
})

/** 额度耗尽的另一种中文措辞（无 11114 码，只能靠文案兜底）。 */
const QUOTA_TEXT_CN = '{"code":10001,"msg":"当前账号额度已用尽，请更换账号"}'

/** 英文文案（国际版 WorkBuddy）——上游 `isQuotaExceededError` 覆盖的形态。 */
const QUOTA_TEXT_EN = '{"error":{"message":"The credits are insufficient, please purchase more."}}'

/**
 * 上下文超限报文（用户报障原文，绝对不能落入积分判定）。
 *
 * 它与积分耗尽是**完全不同的失败**：同样是 HTTP 400，但语义是「本次请求的
 * prompt 太长」，换账号毫无用处（同样的上下文会再次超限），必须走压缩。
 * 若被积分判定命中，适配器会白试一遍所有账号、把它误报成额度不足。
 */
const CONTEXT_OVERFLOW_BODY = JSON.stringify({
  code: 11115,
  msg: 'prompt is too long: 1061554 tokens > 1048576 maximum',
  requestId: '9dc0e856-3dae-431c-a8bd-87a2ab63e8d9',
  extError: {
    code: 'context_length_exceeded',
    message: 'prompt is too long: 1061554 tokens > 1048576 maximum',
    param: '',
    type: 'invalid_request_error',
    StatusCode: 400,
    Request: null,
    Response: null,
  },
  displayMsg: {
    en: 'The request exceeds the model context limit. Please shorten the conversation or remove attachments.',
    zh: '对话内容超出模型长度上限，请精简对话或减少附件后重试。',
  },
})

/** 6004 频率限制报文（模型级限流，与积分耗尽互斥）。 */
const RATE_LIMIT_BODY = JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置，您也可以切换其他模型继续使用。',
})

const RATE_LIMIT_BODY_EN = JSON.stringify({
  code: 6004,
  msg: "usage exceeds frequency limit, but don't worry, your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, you can switch to the other models to continue using it.",
})

describe('isQuotaExhausted', () => {
  it('结构化业务码 11114（数字编码）判为积分耗尽', () => {
    expect(isQuotaExhausted(QUOTA_BODY_CN)).toBe(true)
  })

  it('结构化业务码 11114（字符串编码）判为积分耗尽', () => {
    expect(isQuotaExhausted(QUOTA_BODY_STRING_CODE)).toBe(true)
  })

  it('中文文案兜底：额度已用尽 / 资源已用尽', () => {
    for (const body of [
      QUOTA_TEXT_CN,
      '{"code":11114,"msg":"额度已用尽"}',
      '{"code":11114,"msg":"余额不足，请充值"}',
      '{"code":11114,"msg":"积分已用尽"}',
      '积分不足，请前往购买',
    ]) {
      expect(isQuotaExhausted(body), `应判为积分耗尽: ${body}`).toBe(true)
    }
  })

  it('英文文案兜底：insufficient credits / out of credits / quota exhausted', () => {
    for (const body of [
      QUOTA_TEXT_EN,
      'The credits are insufficient',
      'insufficient credit balance',
      'you are out of credits',
      'no credits left on this account',
      '{"error":{"message":"credit exhausted"}}',
      '{"error":{"message":"quota exhausted"}}',
    ]) {
      expect(isQuotaExhausted(body), `应判为积分耗尽: ${body}`).toBe(true)
    }
  })

  it('上下文超限报文绝不能被判为积分耗尽（防误判回归锁）', () => {
    // 11115 + context_length_exceeded + prompt is too long：
    // 换账号解决不了，必须留给 CONTEXT_WINDOW_EXCEEDED 走自动压缩。
    expect(isQuotaExhausted(CONTEXT_OVERFLOW_BODY)).toBe(false)
    // 拆开单看每个片段也不许命中
    expect(isQuotaExhausted('prompt is too long: 1061554 tokens > 1048576 maximum')).toBe(false)
    expect(isQuotaExhausted('{"extError":{"code":"context_length_exceeded"}}')).toBe(false)
    expect(isQuotaExhausted('{"error":{"message":"context length exceeded"}}')).toBe(false)
    expect(isQuotaExhausted('对话内容超出模型长度上限，请精简对话或减少附件后重试。')).toBe(false)
  })

  it('6004 限流报文对积分判定为 false（两个判定不重叠）', () => {
    expect(isQuotaExhausted(RATE_LIMIT_BODY)).toBe(false)
    expect(isQuotaExhausted(RATE_LIMIT_BODY_EN)).toBe(false)
  })

  it('其它普通错误不得被误判（防误伤，避免无谓换号）', () => {
    const negatives = [
      '{"error":{"message":"model not found"}}',
      '{"code":401,"msg":"invalid token"}',
      '{"code":11102,"msg":"service info not found"}',
      '{"error":{"type":"invalid_request_error","message":"unsupported parameter"}}',
      '{"error":{"message":"internal server error"}}',
      '<html>502 Bad Gateway</html>',
    ]
    for (const body of negatives) {
      expect(isQuotaExhausted(body), `不应判为积分耗尽: ${body}`).toBe(false)
    }
  })
})

describe('BuddyAdapter 账号积分耗尽切换', () => {
  /**
   * 记录 updateModelRateLimit / getAvailableAccount 调用的轻量 AccountPool 替身。
   * @param current - 会话开始时就已启用的当前账号（token 与 resolveCredential 一致）
   * @param candidates - 切换时按顺序返回的候选账号
   */
  function makePool(
    current: { id: string; token: string },
    candidates: Array<{ id: string; token: string }>,
  ) {
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    const known = [current, ...candidates]
    const queue = [...candidates]
    return {
      recorded,
      async findAccountIdByCredential(_provider: string, identity: string) {
        return known.find((a) => a.token === identity)?.id ?? ''
      },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount() {
        const next = queue.shift()
        if (next === undefined) return null
        return { entry: { id: next.id }, credential: makeBuddyCredential({ access_token: next.token }) }
      },
    }
  }

  const streamOptions = {
    model: DEFAULT_MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
  } as never

  it('账号 A 积分不足（11114）时自动换到账号 B 并成功出流', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeBuddyCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        if (token === 'AT2') return sseResponse(OK_SSE)
        return new Response(QUOTA_BODY_CN, { status: 400 })
      },
    })

    const chunks = await collectBuddyChunks(adapter, streamOptions)

    // 关键断言 1：确实换了账号（旧实现只会发 AT1 一次就把 11114 抛给用户）
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    // 关键断言 2：最终拿到内容
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
    // 关键断言 3：没额度的账号被挡住，且冷却时间远长于限流的「1 小时」
    // ——积分耗尽是账号级、要靠充值才能恢复，短冷却会让它反复被选中。
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1'])
    expect(pool.recorded[0]!.modelId).toBe(DEFAULT_MODEL)
    expect(pool.recorded[0]!.resetAtMs).toBeGreaterThan(Date.now() + 12 * 3600 * 1000)
  })

  it('切换后的新账号同样积分不足（11114）时继续往后换', async () => {
    const pool = makePool(
      { id: 'acct-1', token: 'AT1' },
      [{ id: 'acct-2', token: 'AT2' }, { id: 'acct-3', token: 'AT3' }],
    )
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeBuddyCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        const token = auth.replace('Bearer ', '')
        sentTokens.push(token)
        if (token === 'AT3') return sseResponse(OK_SSE)
        return new Response(QUOTA_BODY_CN, { status: 400 })
      },
    })

    await collectBuddyChunks(adapter, streamOptions)

    expect(sentTokens).toEqual(['AT1', 'AT2', 'AT3'])
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })

  it('全部账号积分不足时报 QUOTA_EXCEEDED（而非 INVALID_REQUEST）', async () => {
    const pool = makePool({ id: 'acct-1', token: 'AT1' }, [{ id: 'acct-2', token: 'AT2' }])
    const sentTokens: string[] = []
    const adapter = new BuddyAdapter({
      credentialRef: credentialRef('BUDDY_ACCESS_TOKEN'),
      resolveCredential: async () => makeBuddyCredential({ access_token: 'AT1' }),
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_url, init) => {
        const auth = (init?.headers as Headers | undefined)?.get('Authorization') ?? ''
        sentTokens.push(auth.replace('Bearer ', ''))
        return new Response(QUOTA_BODY_CN, { status: 400 })
      },
    })

    const error = await collectBuddyChunks(adapter, streamOptions).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    // 旧实现直接抛原始 400 → INVALID_REQUEST；必须归为不可重试的额度耗尽
    expect((error as LlmError).code).toBe('QUOTA_EXCEEDED')
    // 两个账号都被试过、都被记录
    expect(sentTokens).toEqual(['AT1', 'AT2'])
    expect(pool.recorded.map((r) => r.accountId)).toEqual(['acct-1', 'acct-2'])
  })
})

describe('CodeArtsAdapter 账号积分耗尽切换', () => {
  const codeartsCredential = (suffix: string): CodeArtsCredential => ({
    access_key_id: `AK${suffix}`,
    secret_access_key: `SK${suffix}`,
    security_token: `ST${suffix}`,
    expires_at: '2099-01-01T00:00:00Z',
  })

  it('账号 A 积分不足（11114）时自动换到账号 B 并成功出流', async () => {
    let credential = codeartsCredential('1')
    const recorded: Array<{ accountId: string; modelId: string; resetAtMs: number }> = []
    let switched = false
    const pool = {
      async findAccountIdByCredential() { return 'acct-1' },
      async updateModelRateLimit(accountId: string, modelId: string, resetAtMs: number) {
        recorded.push({ accountId, modelId, resetAtMs })
      },
      async getAvailableAccount() {
        switched = true
        return { entry: { id: 'acct-2' }, credential: codeartsCredential('2') }
      },
    }
    const sentTokens: string[] = []
    const adapter = new CodeArtsAdapter({
      credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
      resolveCredential: async () => credential,
      refresh: async () => {},
      accountPool: pool as never,
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const token = new Headers(init?.headers).get('x-security-token') ?? ''
        sentTokens.push(token)
        if (token === 'ST2') {
          // 换号后 resolveCredential 也必须给出新账号的凭据（外层循环重新签名）
          credential = codeartsCredential('2')
          return sseResponse(OK_SSE)
        }
        return new Response(QUOTA_BODY_CN, { status: 400 })
      },
    })

    const texts: string[] = []
    for await (const chunk of adapter.stream({
      model: 'GLM-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    } as never)) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }

    expect(switched).toBe(true)
    expect(sentTokens).toEqual(['ST1', 'ST2'])
    expect(texts).toEqual(['ok'])
    expect(recorded.map((r) => r.accountId)).toEqual(['acct-1'])
    expect(recorded[0]!.modelId).toBe('GLM-5.2')
    expect(recorded[0]!.resetAtMs).toBeGreaterThan(Date.now() + 12 * 3600 * 1000)
  })

  it('上下文超限的 400 不会被当成积分耗尽（不触发换号）', async () => {
    let poolQueried = false
    const sentTokens: string[] = []
    const adapter = new CodeArtsAdapter({
      credentialRef: credentialRef('CODEARTS_ACCESS_TOKEN'),
      resolveCredential: async () => codeartsCredential('1'),
      refresh: async () => {},
      accountPool: {
        async findAccountIdByCredential() { return 'acct-1' },
        async updateModelRateLimit() {},
        async getAvailableAccount() { poolQueried = true; return null },
      } as never,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith(CHAT_API_BASE) === false) {
          return new Response(JSON.stringify({ status: 'working', queue_position: 0, message: '' }))
        }
        sentTokens.push(new Headers(init?.headers).get('x-security-token') ?? '')
        return new Response(CONTEXT_OVERFLOW_BODY, { status: 400 })
      },
    })

    const error = await (async () => {
      try {
        for await (const _ of adapter.stream({
          model: 'GLM-5.2',
          messages: [{ role: 'user', content: 'hi' }],
          signal: new AbortController().signal,
        } as never)) { /* drain */ }
        return undefined
      } catch (e) { return e }
    })()

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(poolQueried).toBe(false)
    expect(sentTokens).toEqual(['ST1'])
  })
})
