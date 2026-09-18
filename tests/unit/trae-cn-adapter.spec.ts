/**
 * Trae CN LLM 适配器测试。
 *
 * 三块内容各自独立：
 * 1. **错误码分类**（纯函数，整表穷举，正反例各一）；
 * 2. **SSE 解析**（正常流 / 错误流 / 中断流）；
 * 3. **适配器行为**（stream 传 model、换号、listModels 黑名单、resolveModel、注册）。
 *
 * 全部不发真实网络请求（`fetchImpl` 注入假实现）。
 */

import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  PROVIDER,
  TRAE_CN_FALLBACK_MODELS,
  TraeCnAdapter,
  parseTraeCnModels,
  registerTraeCnLlm,
} from '../../src/trae-cn-adapter.js'
import {
  classifyTraeCnError,
  normalizeTraeCnCode,
  recordsTraeCnCooldown,
  shouldSwitchTraeCnAccount,
  isTraeCnBackoff,
  TRAE_CN_ACCOUNT_INVALID_CODES,
  TRAE_CN_BACKOFF_CODES,
  TRAE_CN_FATAL_CODES,
  TRAE_CN_QUEUE_CODES,
  TRAE_CN_QUOTA_CODES,
  TRAE_CN_RATE_LIMIT_CODES,
  TRAE_CN_RISK_CONTROL_CODES,
} from '../../src/trae-cn-errors.js'
import {
  TRAE_CN_CHAT_PATH,
  TRAE_CN_CHAT_PATH_CANDIDATES,
  TRAE_CN_GATEWAY_USER_AGENT,
  TRAE_CN_IDE_API_BASE,
  TRAE_CN_IDE_APP_ID,
  TRAE_CN_IDE_GATEWAY_VERSION,
  TRAE_CN_IDE_VERSION_CODE,
  TRAE_CN_IDE_VERSION_TYPE,
  TRAE_CN_REQUEST_TRAFFIC_TYPE,
  TRAE_CN,
} from '../../src/trae-cn-product.js'
import {
  consumeTraeCnStream,
  extractTraeCnOutputText,
  parseTraeCnSseError,
  parseTraeCnToolCall,
  parseTraeCnUsage,
  serializeTraeCnMessages,
  traeCnErrorCodeForAction,
} from '../../src/trae-cn-sse.js'
import type { TraeCnCredential } from '../../src/trae-cn-oauth.js'

// ── 测试脚手架 ──

function makeCredential(overrides: Partial<TraeCnCredential> = {}): TraeCnCredential {
  return {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    user_id: 'uid-1',
    client_id: 'ono9krqynydwx5',
    device_id: '1234567890123456',
    machine_id: 'a'.repeat(32),
    device_id_source: 'exchange-bound-device-id',
    // 用**不透明**的过期值：`isTraeCnExpired` 只在能解析出过期时间时才判定过期，
    // 这里给一个远期时间戳，避免测试里被动触发续期分支。
    expires_at: String(Date.now() + 7_200_000),
    ...overrides,
  }
}

/** 构造一段 Trae CN 风格的 SSE 文本（具名事件）。 */
function traeSse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map(({ event, data }) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`)
    .join('')
}

/** 一次普通的文本回复流。 */
function textStream(text: string): string {
  return traeSse([
    { event: 'metadata', data: { conversation_id: 'c1', model_name: 'glm-5.2' } },
    { event: 'timing_cost', data: { first_token: 120 } },
    { event: 'output', data: { response: text } },
    { event: 'done', data: { finish_reason: 'stop' } },
  ])
}

/** 一个错误流（HTTP 200 + `event:error`，这是 Trae 的主要失败形态）。 */
function errorStream(code: number, message = '限流中'): string {
  return traeSse([
    { event: 'metadata', data: { conversation_id: 'c1' } },
    { event: 'error', data: { code, message } },
  ])
}

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收集 `stream()` 的全部 chunk；返回 chunk 与抛出的错误。 */
async function collect(
  adapter: TraeCnAdapter,
  options: GenerateOptions,
): Promise<{ chunks: unknown[]; error?: { code?: string; message?: string } }> {
  const chunks: unknown[] = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return { chunks }
  } catch (error) {
    return { chunks, error: error as { code?: string; message?: string } }
  }
}

/**
 * 构造适配器 + 捕获请求的 fetch stub。
 *
 * `responder` 收到 `(url, init, callIndex)`，可据 callIndex 让不同账号得到不同结果。
 */
function makeAdapter(
  responder: (url: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof TraeCnAdapter>[0]> = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init, calls.length - 1)
  }) as unknown as typeof fetch
  const adapter = new TraeCnAdapter({
    credentialRef: credentialRef('TRAE_CN_ACCOUNT_TEST'),
    resolveCredential: async () => makeCredential(),
    refresh: async () => {},
    fetchImpl: fetcher,
    product: TRAE_CN,
    ...options,
  })
  return { adapter, calls, fetcher }
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'trae-cn',
    model: 'glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

// ── 一、错误码分类（纯函数） ──

describe('Trae CN 错误码分类：换号类', () => {
  it('限流码（4008/4021/5003/977）全部判 switch-account', () => {
    for (const code of TRAE_CN_RATE_LIMIT_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('额度码（4200-4203）判 switch-account', () => {
    for (const code of TRAE_CN_QUOTA_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('账号失效码（1001/1002/4010/4014）判 switch-account（对齐官方 isSecurityError）', () => {
    for (const code of TRAE_CN_ACCOUNT_INVALID_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('风控码（4011/4013/4015）判 switch-account', () => {
    for (const code of TRAE_CN_RISK_CONTROL_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('switch-account')
    }
  })

  it('字符串形态的业务码与数字形态等价（上游两种都出现过）', () => {
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: '4008' })).toBe('switch-account')
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: 4008 })).toBe('switch-account')
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: ' 4008 ' })).toBe('switch-account')
  })
})

describe('Trae CN 错误码分类：退避类（不换号）', () => {
  it('软限流码（4007/3004/9074）判 backoff', () => {
    for (const code of TRAE_CN_BACKOFF_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('backoff')
    }
  })

  it('排队码（4000005、4050-4052）判 backoff —— 排队是全局状态，换号无益', () => {
    for (const code of TRAE_CN_QUEUE_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('backoff')
    }
  })

  it('退避类**不**触发换号（正反例：换成限流码就要换号）', () => {
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 4007 }))).toBe(false)
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 4000005 }))).toBe(false)
    expect(isTraeCnBackoff(classifyTraeCnError({ sseErrorCode: 4007 }))).toBe(true)
    // 反例
    expect(shouldSwitchTraeCnAccount(classifyTraeCnError({ sseErrorCode: 4008 }))).toBe(true)
    expect(isTraeCnBackoff(classifyTraeCnError({ sseErrorCode: 4008 }))).toBe(false)
  })
})

describe('Trae CN 错误码分类：直报类', () => {
  it('参数/超长/模型不存在（4001/4006/4023）判 fail', () => {
    for (const code of TRAE_CN_FATAL_CODES) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('fail')
    }
  })

  it('**未知码默认直报**（带原始码，便于真机校准）', () => {
    for (const code of [12345, 99999, 8888, 0, -1]) {
      expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: code })).toBe('fail')
    }
  })

  it('非法码形态（非整数字符串）等同于「无业务码」，退回 HTTP 判定', () => {
    // `"code=4008"` 这类诊断文本不能被 parseInt 静默截取成 4008。
    expect(normalizeTraeCnCode('code=4008')).toBeUndefined()
    expect(normalizeTraeCnCode('4008.5')).toBeUndefined()
    expect(classifyTraeCnError({ httpStatus: 500, sseErrorCode: 'code=4008' })).toBe('backoff')
  })
})

describe('Trae CN 错误码分类：HTTP 兜底（无业务码时）', () => {
  it('401/403 → switch-account（凭据被拒，换个账号试）', () => {
    expect(classifyTraeCnError({ httpStatus: 401 })).toBe('switch-account')
    expect(classifyTraeCnError({ httpStatus: 403 })).toBe('switch-account')
  })

  it('429/408/5xx → backoff（网关级限流与瞬时故障，与账号无关）', () => {
    expect(classifyTraeCnError({ httpStatus: 429 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 408 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 500 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 502 })).toBe('backoff')
    expect(classifyTraeCnError({ httpStatus: 503 })).toBe('backoff')
  })

  it('其余（200 / 400 / 404）→ fail', () => {
    expect(classifyTraeCnError({ httpStatus: 200 })).toBe('fail')
    expect(classifyTraeCnError({ httpStatus: 400 })).toBe('fail')
    expect(classifyTraeCnError({ httpStatus: 404 })).toBe('fail')
    expect(classifyTraeCnError({})).toBe('fail')
  })

  it('**业务码优先于 HTTP 状态码**：200 + 4008 仍要换号', () => {
    // 这是本 provider 的核心事实：失败几乎恒为 HTTP 200。
    expect(classifyTraeCnError({ httpStatus: 200, sseErrorCode: 4008 })).toBe('switch-account')
    // 反之，业务码说直报时即使状态码是 5xx 也以业务码为准。
    expect(classifyTraeCnError({ httpStatus: 503, sseErrorCode: 4001 })).toBe('fail')
  })
})

describe('Trae CN 冷却徽章判据', () => {
  it('限流 / 额度 / 风控码记徽章', () => {
    for (const code of [...TRAE_CN_RATE_LIMIT_CODES, ...TRAE_CN_QUOTA_CODES, ...TRAE_CN_RISK_CONTROL_CODES]) {
      expect(recordsTraeCnCooldown(code)).toBe(true)
    }
  })

  it('**账号失效码不记**（唯一解法是重新登录，记「等待重置」是虚假信息）', () => {
    for (const code of TRAE_CN_ACCOUNT_INVALID_CODES) {
      expect(recordsTraeCnCooldown(code)).toBe(false)
    }
  })

  it('退避类 / 直报类 / 未知码都不记', () => {
    for (const code of [...TRAE_CN_BACKOFF_CODES, ...TRAE_CN_QUEUE_CODES, ...TRAE_CN_FATAL_CODES, 99999]) {
      expect(recordsTraeCnCooldown(code)).toBe(false)
    }
    expect(recordsTraeCnCooldown(undefined)).toBe(false)
  })
})

describe('Trae CN 动作 → harness 错误码', () => {
  it('换号/退避都映射为可重试的 RATE_LIMIT（否则退避无从生效）', () => {
    expect(traeCnErrorCodeForAction('switch-account', 4008)).toBe('RATE_LIMIT')
    expect(traeCnErrorCodeForAction('backoff', 4007)).toBe('RATE_LIMIT')
    expect(traeCnErrorCodeForAction('backoff', 4000005)).toBe('RATE_LIMIT')
  })

  it('4006（请求超长）映射为 CONTEXT_WINDOW_EXCEEDED（触发上下文压缩）', () => {
    expect(traeCnErrorCodeForAction('fail', 4006)).toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(traeCnErrorCodeForAction('fail', '4006')).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('其余直报映射为 INVALID_REQUEST', () => {
    expect(traeCnErrorCodeForAction('fail', 4001)).toBe('INVALID_REQUEST')
    expect(traeCnErrorCodeForAction('fail', undefined)).toBe('INVALID_REQUEST')
  })
})

// ── 二、SSE 解析 ──

describe('Trae CN SSE 帧解析（纯函数）', () => {
  it('output 帧取 response 字段；同义字段作为回退', () => {
    expect(extractTraeCnOutputText({ response: '你好' })).toBe('你好')
    expect(extractTraeCnOutputText({ content: 'x' })).toBe('x')
    expect(extractTraeCnOutputText('裸字符串')).toBe('裸字符串')
    // 结构化载荷**不**被 String() 成乱码。
    expect(extractTraeCnOutputText({ other: { a: 1 } })).toBe('')
    expect(extractTraeCnOutputText(null)).toBe('')
  })

  it('error 帧解析业务码与文案（含嵌套 error 形态）', () => {
    expect(parseTraeCnSseError({ code: 4008, message: '限流' }))
      .toMatchObject({ code: 4008, message: '限流', action: 'switch-account' })
    expect(parseTraeCnSseError({ error: { code: '4021', message: '并发超限' } }))
      .toMatchObject({ code: '4021', message: '并发超限', action: 'switch-account' })
    // 无 code 时按 HTTP 兜底。
    expect(parseTraeCnSseError({ message: 'oops' }, 503).action).toBe('backoff')
  })

  it('tool_call 帧容忍三种载荷形态；全落空时返回 undefined（不伪造空调用）', () => {
    expect(parseTraeCnToolCall({ id: 'c1', name: 'read', arguments: '{"a":1}' }))
      .toEqual({ id: 'c1', name: 'read', argumentsDelta: '{"a":1}' })
    expect(parseTraeCnToolCall({ tool_call: { id: 'c2', name: 'grep', arguments: '{}' } }))
      .toEqual({ id: 'c2', name: 'grep', argumentsDelta: '{}' })
    expect(parseTraeCnToolCall({ tool_call: { function: { name: 'ls', arguments: '{}' } } }))
      .toEqual({ name: 'ls', argumentsDelta: '{}' })
    // 结构化参数序列化回字符串。
    expect(parseTraeCnToolCall({ name: 'x', arguments: { a: 1 } })).toEqual({ name: 'x', argumentsDelta: '{"a":1}' })
    expect(parseTraeCnToolCall({ nothing: true })).toBeUndefined()
  })

  it('usage 帧只把未命中缓存部分计入 inputTokens', () => {
    expect(parseTraeCnUsage({ prompt_tokens: 100, completion_tokens: 20 }))
      .toEqual({ inputTokens: 100, outputTokens: 20 })
    expect(parseTraeCnUsage({ prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 30 }))
      .toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30 })
    // 无可用字段时不产出 usage（而不是产出一个全 0 的假用量）。
    expect(parseTraeCnUsage({ foo: 1 })).toBeUndefined()
    expect(parseTraeCnUsage('nope')).toBeUndefined()
  })

  it('消息序列化：剔除孤儿工具调用、空正文 + tool_calls 时 content 为 null', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'orphan', name: 'x', arguments: '{}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
    ]
    const wire = serializeTraeCnMessages(messages)
    const withCalls = wire.filter((m) => m.tool_calls !== undefined)
    // 孤儿调用（没有结果的 orphan）被剔除，配对的 c1 保留。
    expect(withCalls).toHaveLength(1)
    expect((withCalls[0]!.tool_calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['c1'])
    expect(withCalls[0]!.content).toBeNull()
    expect(wire.some((m) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true)
  })
})

describe('Trae CN SSE 流消费', () => {
  /** 直接消费一段 SSE 文本，返回 chunk 与 outcome。 */
  async function consume(body: string, status = 200) {
    const chunks: unknown[] = []
    const generator = consumeTraeCnStream(sseResponse(body, status), {
      label: 'trae-cn',
      httpStatus: status,
      timeouts: { firstFrameMs: 1000, chunkMs: 1000 },
    })
    let outcome
    for (;;) {
      const next = await generator.next()
      if (next.done === true) { outcome = next.value; break }
      chunks.push(next.value)
    }
    return { chunks, outcome }
  }

  it('正常流：metadata/timing_cost 被忽略，output 产出正文，done 结束', async () => {
    const { chunks, outcome } = await consume(textStream('你好世界'))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你好世界' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好世界' } },
    ])
    expect(outcome).toMatchObject({ done: true, produced: true, hasToolCalls: false, argumentsTruncated: false })
    expect(outcome.sseError).toBeUndefined()
  })

  it('多个 output 帧累积成同一个正文块', async () => {
    const { chunks } = await consume(traeSse([
      { event: 'output', data: { response: '你' } },
      { event: 'output', data: { response: '好' } },
      { event: 'done', data: {} },
    ]))
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta'))
      .toEqual([
        { type: 'text-delta', index: 0, text: '你' },
        { type: 'text-delta', index: 0, text: '好' },
      ])
    const end = chunks.at(-1) as { block: { text: string } }
    expect(end.block.text).toBe('你好')
  })

  it('事件名 `meta`（JS 侧命名）与 `metadata` 都被识别为元数据帧', async () => {
    const { outcome } = await consume(traeSse([
      { event: 'meta', data: { id: 'log-1' } },
      { event: 'output', data: { response: 'x' } },
      { event: 'done', data: {} },
    ]))
    expect(outcome).toMatchObject({ done: true, produced: true })
  })

  it('**错误流**：error 帧回填 outcome.sseError，且不抛异常（换号判定权交给调用方）', async () => {
    const { chunks, outcome } = await consume(errorStream(4008, '请求过于频繁'))
    expect(outcome.produced).toBe(false)
    expect(outcome.done).toBe(false)
    expect(outcome.sseError).toMatchObject({ code: 4008, message: '请求过于频繁', action: 'switch-account' })
    expect(chunks).toEqual([])
  })

  it('错误流里 `data:` 不是 JSON 时也不炸，原文作为文案', async () => {
    const { outcome } = await consume('event:error\ndata:gateway exploded\n\n')
    expect(outcome.sseError).toMatchObject({ message: 'gateway exploded' })
  })

  it('**中断流**：连接提前关闭时 done 为 false，但已产出的正文仍在', async () => {
    const { chunks, outcome } = await consume(traeSse([
      { event: 'output', data: { response: '半截' } },
      // 没有 done 帧
    ]))
    expect(outcome).toMatchObject({ done: false, produced: true })
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('工具调用分片合并；参数残缺时 argumentsTruncated 为真', async () => {
    const complete = await consume(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"file_path":"a' } },
      { event: 'tool_call', data: { arguments: '.ts"}' } },
      { event: 'done', data: {} },
    ]))
    expect(complete.outcome).toMatchObject({ hasToolCalls: true, argumentsTruncated: false })
    const block = complete.chunks.at(-1) as { block: { name: string; arguments: string } }
    expect(block.block).toMatchObject({ name: 'read', arguments: '{"file_path":"a.ts"}' })

    const truncated = await consume(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"file_path":"a' } },
      { event: 'done', data: {} },
    ]))
    expect(truncated.outcome.argumentsTruncated).toBe(true)
  })

  it('工具名只允许**非空**覆盖（后续空串不会清掉已解析出的名字）', async () => {
    const { chunks } = await consume(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{}' } },
      { event: 'tool_call', data: { name: '', arguments: '' } },
      { event: 'done', data: {} },
    ]))
    const block = chunks.at(-1) as { block: { name: string } }
    expect(block.block.name).toBe('read')
  })

  it('thought 帧产出 reasoning 块；usage 帧产出 usage', async () => {
    const { chunks } = await consume(traeSse([
      { event: 'thought', data: { content: '让我想想' } },
      { event: 'output', data: { response: '答案' } },
      { event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 2 } },
      { event: 'done', data: {} },
    ]))
    expect(chunks.some((c) => (c as { type: string }).type === 'reasoning-delta')).toBe(true)
    expect(chunks.some((c) => (c as { type: string }).type === 'usage')).toBe(true)
  })

  it('output 帧里的 content 是**正文**，不会被当成思考（同一段文字不重复出现）', async () => {
    // 锁死一个真实歧义：`output` 帧的 `content` 与「思考」字段同形，
    // 若把 content 也当思考，正文会在两个块里各出现一次。
    const { chunks } = await consume(traeSse([
      { event: 'output', data: { content: '正文内容' } },
      { event: 'done', data: {} },
    ]))
    expect(chunks.some((c) => (c as { type: string }).type === 'reasoning-delta')).toBe(false)
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta'))
      .toEqual([{ type: 'text-delta', index: 0, text: '正文内容' }])
  })

  it('排队帧被忽略，不产出内容也不报错', async () => {
    const { outcome } = await consume(traeSse([
      { event: 'queue_begin', data: { position: 3 } },
      { event: 'request_wait_in_queue', data: { wait: 5 } },
      { event: 'output', data: { response: 'ok' } },
      { event: 'done', data: {} },
    ]))
    expect(outcome).toMatchObject({ done: true, produced: true })
  })

  it('畸形 JSON 帧被跳过而不中断流；未知事件名的 data 不被当作正文', async () => {
    const body = 'event:output\ndata:{bad json\n\n'
      + 'event:timing_cost\ndata:{"a":1}\n\n'
      + 'event:output\ndata:{"response":"ok"}\n\n'
      + 'event:done\ndata:{}\n\n'
    const { chunks, outcome } = await consume(body)
    expect(outcome.produced).toBe(true)
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta'))
      .toEqual([{ type: 'text-delta', index: 0, text: 'ok' }])
  })

  it('兼容 `data:{...}`（无空格）与 CRLF 行尾', async () => {
    const body = 'event:output\r\ndata:{"response":"crlf"}\r\n\r\nevent:done\r\ndata:{}\r\n\r\n'
    const { outcome } = await consume(body)
    expect(outcome.produced).toBe(true)
  })
})

// ── 三、适配器行为 ──

describe('TraeCnAdapter providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(adapter.providerInfo('trae-cn')).toEqual({ id: 'trae-cn', name: 'Trae CN (字节跳动)' })
  })

  it('provider 入参非法时回退到产品 id（避免 toUpperCase 崩溃）', () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(adapter.providerInfo(undefined as never).id).toBe('trae-cn')
    expect(adapter.providerInfo('' as never).id).toBe('trae-cn')
  })

  it('PROVIDER 常量为 trae-cn', () => {
    expect(PROVIDER).toBe('trae-cn')
  })
})

describe('TraeCnAdapter 模型目录', () => {
  it('静态表为真机 16 项（不是 8 项），且 id 逐字符等于真机目录', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const models = await adapter.listModels('trae-cn')
    expect(models).toHaveLength(16)
    // 真机 id 形态极不规则（大小写/点号/连字符混用），逐项锁死防「顺手规整化」。
    expect(models.map((m) => m.id)).toEqual([
      'Doubao-Seed-Evolving',
      'Doubao-Seed-2.1-Pro',
      'Doubao-Seed-2.1-Turbo',
      'Doubao-Seed-Code',
      'glm-5.3-flash',
      'glm-5.3',
      'glm-5.2',
      'deepseek-v4.1-flash',
      'DeepSeek-V4-Flash-Official',
      'DeepSeek-V4-Pro-Official',
      'kimi-k3',
      'kimi-k2.8-preview',
      'minimax-m3',
      'qwen3.8-flash',
      'qwen3.8-max',
      'qwen-3.7-plus',
    ])
  })

  it('**4 个旧死 id 已不在表中**（换真机表的核心目的）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const ids = (await adapter.listModels('trae-cn')).map((m) => m.id)
    // qwen3.7-max 已下线；其余三个是拼写/大小写错误的近似形态 ——
    // 它们曾经让用户选中一个必然 404 的模型。
    for (const dead of ['qwen3.7-max', 'deepseek-v4-flash', 'doubao-seed-2-1-pro', 'MiniMax-M3']) {
      expect(ids, dead).not.toContain(dead)
    }
    // 反证：真机形态的「近似但不同」的 id 必须在表里，否则上面那条反断言
    // 可能因为整表为空而假通过。
    for (const live of ['deepseek-v4.1-flash', 'Doubao-Seed-2.1-Pro', 'minimax-m3']) {
      expect(ids, live).toContain(live)
    }
  })

  it('**排除 BYOK 自定义条目**（deepseek//deepseek-chat / -reasoner 不属云端目录）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const ids = (await adapter.listModels('trae-cn')).map((m) => m.id)
    for (const byok of ['deepseek//deepseek-chat', 'deepseek//deepseek-reasoner']) {
      expect(ids).not.toContain(byok)
    }
  })

  it('静态表逐项带 supportsImages 与 maxTokens（目录与真机逐列对齐）', () => {
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      expect(typeof model.supportsImages, model.id).toBe('boolean')
      expect([32_000, 64_000], model.id).toContain(model.maxTokens)
      expect(model.contextWindow, model.id).toBeGreaterThan(0)
    }
    // 真机 12/16 项多模态 —— 数一下，避免整表被改成全 true / 全 false 还绿。
    expect(TRAE_CN_FALLBACK_MODELS.filter((m) => m.supportsImages)).toHaveLength(12)
  })

  it('inputModalities 按模型给：多模态项 image，非多模态项只有 text', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    const byId = new Map((await adapter.listModels('trae-cn')).map((m) => [m.id, m]))
    for (const model of TRAE_CN_FALLBACK_MODELS) {
      expect(byId.get(model.id)!.inputModalities, model.id).toEqual(
        model.supportsImages ? ['text', 'image'] : ['text'],
      )
      expect(byId.get(model.id)!.provider).toBe('trae-cn')
    }
    // 两边的代表各点一次（防止上面的循环整体失效还绿）。
    expect(byId.get('kimi-k3')!.inputModalities).toEqual(['text', 'image'])
    expect(byId.get('glm-5.3')!.inputModalities).toEqual(['text'])
  })

  it('远端可用时以远端为准（不做「以兜底表为准」的裁剪）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [{ id: 'remote-only', name: 'Remote Only' }],
    })
    const models = await adapter.listModels('trae-cn')
    expect(models).toEqual([{ provider: 'trae-cn', id: 'remote-only', name: 'Remote Only', inputModalities: ['text'] }])
  })

  it('远端返回空数组 / 抛错时回退静态表', async () => {
    const empty = makeAdapter(() => sseResponse(''), { fetchRemoteModels: async () => [] })
    expect(await empty.adapter.listModels('trae-cn')).toHaveLength(TRAE_CN_FALLBACK_MODELS.length)
    const failing = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => { throw new Error('network down') },
    })
    expect(await failing.adapter.listModels('trae-cn')).toHaveLength(TRAE_CN_FALLBACK_MODELS.length)
  })

  it('**应用账号池的模型黑名单**（黑名单制：只滤显式关闭的）', async () => {
    const disabledModelsFor = vi.fn(() => new Set(['glm-5.2']))
    const { adapter } = makeAdapter(() => sseResponse(''), {
      accountPool: { disabledModelsFor } as never,
    })
    const ids = (await adapter.listModels('trae-cn')).map((m) => m.id)
    expect(disabledModelsFor).toHaveBeenCalledWith('trae-cn')
    expect(ids).not.toContain('glm-5.2')
    expect(ids).toContain('kimi-k3')
  })

  it('黑名单每次调用实时读取（改开关后无需重建适配器）', async () => {
    let disabled = new Set<string>()
    const { adapter } = makeAdapter(() => sseResponse(''), {
      accountPool: { disabledModelsFor: () => disabled } as never,
    })
    expect((await adapter.listModels('trae-cn')).map((m) => m.id)).toContain('glm-5.2')
    disabled = new Set(['glm-5.2'])
    expect((await adapter.listModels('trae-cn')).map((m) => m.id)).not.toContain('glm-5.2')
  })
})

describe('TraeCnAdapter resolveModel', () => {
  it('用静态表给出真机目录的上下文窗口（dev 档）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(await adapter.resolveModel('trae-cn', 'glm-5.2')).toMatchObject({
      provider: 'trae-cn', id: 'glm-5.2', name: 'GLM-5.2', context: { contextWindow: 119_040 },
    })
    // 另一档（262144 / 204800）各点一次，防止整表被改成同一个数还绿。
    expect((await adapter.resolveModel('trae-cn', 'Doubao-Seed-Evolving')).context)
      .toEqual({ contextWindow: 262_144 })
    expect((await adapter.resolveModel('trae-cn', 'qwen3.8-max')).context)
      .toEqual({ contextWindow: 204_800 })
  })

  it('resolveModel 的 inputModalities 与 listModels **同源同口径**', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    // 两处不一致会让选择器显示「支持图片」而请求路径按纯文本处理（或反之）。
    expect((await adapter.resolveModel('trae-cn', 'kimi-k3')).inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel('trae-cn', 'DeepSeek-V4-Pro-Official')).inputModalities).toEqual(['text'])
  })

  it('**不声明** reasoning（是否支持思考等级未实测）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect((await adapter.resolveModel('trae-cn', 'glm-5.2')).reasoning).toBeUndefined()
  })

  it('未知模型回退为 id 作展示名且不报错（模态保守判纯文本）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''))
    expect(await adapter.resolveModel('trae-cn', 'brand-new')).toMatchObject({
      id: 'brand-new', name: 'brand-new', inputModalities: ['text'],
    })
  })

  it('远端给了展示名时优先用远端', async () => {
    const { adapter } = makeAdapter(() => sseResponse(''), {
      fetchRemoteModels: async () => [{ id: 'glm-5.2', name: '远端 GLM' }],
    })
    expect((await adapter.resolveModel('trae-cn', 'glm-5.2')).name).toBe('远端 GLM')
  })
})

describe('TraeCnAdapter 请求构造', () => {
  it('POST 到 **IDE 网关**（不是 api.trae.cn）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${TRAE_CN_IDE_API_BASE}${TRAE_CN_CHAT_PATH}`)
    // T6 的真实病因是 host 而非路径：`/api/ide/*` 在 api.trae.cn 上 404。
    expect(new URL(calls[0]!.url).host).toBe('trae-api-cn.mchost.guru')
    expect(new URL(calls[0]!.url).origin).not.toBe(TRAE_CN.apiBase)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('端点常量与候选表一致（历史留痕：改动时必须同步候选表）', () => {
    expect(TRAE_CN_CHAT_PATH_CANDIDATES).toContain(TRAE_CN_CHAT_PATH)
    expect(TRAE_CN_CHAT_PATH_CANDIDATES[0]).toBe(TRAE_CN_CHAT_PATH)
  })

  it('请求头用 Cloud-IDE-JWT + 两个同值 token 头，且**不带**腾讯系归属头', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions())
    const headers = calls[0]!.init?.headers as Record<string, string>
    // 普通对象（非 Headers 实例）：与 credits 模块一致，避免 Headers 构造器
    // 丢弃/规范化部分请求头导致两处形态不一致。
    expect(headers['Authorization']).toBe('Cloud-IDE-JWT AT-1')
    expect(headers['X-Ide-Token']).toBe('AT-1')
    expect(headers['X-Cloudide-Token']).toBe('AT-1')
    expect(headers['Accept']).toBe('text/event-stream')
    // 归属头：Trae CN 一个都不发。
    for (const name of ['X-Domain', 'X-Product-Code', 'X-Product', 'X-LobsterAI-Client-Version']) {
      expect(headers[name]).toBeUndefined()
    }
  })

  it('**带齐 IDE 网关全套头**（缺了实测 500/401）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions())
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['x-app-id']).toBe(TRAE_CN_IDE_APP_ID)
    expect(headers['x-app-id']).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
    // 版本号**必须纯数字**：真机发 "3.3.100" 会 400。
    expect(headers['x-ide-version-code']).toBe('107')
    expect(headers['x-app-version-code']).toBe('107')
    expect(headers['x-ide-version-code']).toMatch(/^\d+$/)
    expect(headers['x-ide-version']).toBe('1.107.1')
    expect(headers['x-ide-version-type']).toBe('stable')
    expect(headers['request-traffic-type']).toBe('normal')
    expect(headers['User-Agent']).toBe('TraeClient/TTNet')
    // 设备头取自凭据的 device_id（与签到端点同一个字段，不是登录 URL 的随机号）。
    expect(headers['x-device-id']).toBe('1234567890123456')
    expect(headers['x-device-type']).toBe('windows')
    expect(headers['x-os-version']).toMatch(/^Windows 10\.0\.\d+$/)
  })

  it('body：model / messages / stream 恒为 true', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ model: 'kimi-k3' }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.model).toBe('kimi-k3')
    expect(body.stream).toBe(true)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('system 提示折叠进 messages 首位', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ system: '你是助手' }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' })
  })

  it('工具 schema 映射为 OpenAI function 形态；无工具时不发 tools', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
    }))
    const withTools = JSON.parse(String(calls[0]!.init?.body)) as { tools: unknown[] }
    expect(withTools.tools).toEqual([
      { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object' } } },
    ])

    const second = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(second.adapter, generateOptions())
    expect(JSON.parse(String(second.calls[0]!.init?.body))).not.toHaveProperty('tools')
  })

  it('透传 temperature / maxTokens / stop；reasoningEffort 仅在显式传入时带', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    await collect(adapter, generateOptions({ temperature: 0.3, maxTokens: 512, stop: ['END'] }))
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(512)
    expect(body.stop).toEqual(['END'])
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('图片输入报 UNSUPPORTED_CONTENT（而不是静默丢弃）', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(textStream('ok')))
    const options = generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'image', ref: { id: 'x' } } as never],
        source: { kind: 'user' },
      })],
    })
    const { error } = await collect(adapter, options)
    expect(error?.code).toBe('UNSUPPORTED_CONTENT')
    // 在取凭据/发请求之前就拒绝。
    expect(calls).toHaveLength(0)
  })
})

describe('TraeCnAdapter 凭据处理', () => {
  it('凭据缺失时抛 MISSING_CREDENTIAL', async () => {
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')), {
      resolveCredential: async () => undefined,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('MISSING_CREDENTIAL')
  })

  it('**stream 把 options.model 传给 resolveCredential 与 refresh**', async () => {
    // 这是硬约定：账号池的限流过滤是**逐模型**的，传空串会让每次请求都先白跑
    // 一遍已限额的账号；refresh 用不同口径选号还会导致「解析到 B、却刷新了 A」。
    const resolveCredential = vi.fn(async () => makeCredential())
    const refresh = vi.fn(async () => {})
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')), { resolveCredential, refresh })
    await collect(adapter, generateOptions({ model: 'kimi-k3' }))
    expect(resolveCredential).toHaveBeenCalledWith('kimi-k3')
  })

  it('凭据过期时先续期再发请求，且续期也用同一个 model', async () => {
    const refreshed: string[] = []
    const resolveCredential = vi.fn(async () => makeCredential({ expires_at: String(Date.now() - 1000) }))
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')), {
      resolveCredential,
      refresh: async (model?: string) => { refreshed.push(model ?? '(空)') },
    })
    await collect(adapter, generateOptions({ model: 'glm-5.2' }))
    expect(refreshed).toEqual(['glm-5.2'])
  })

  it('HTTP 401 时续期一次并重试', async () => {
    let attempt = 0
    const refresh = vi.fn(async () => {})
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      return attempt === 1
        ? new Response('unauthorized', { status: 401 })
        : sseResponse(textStream('ok'))
    }, { refresh })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(refresh).toHaveBeenCalled()
    expect(calls).toHaveLength(2)
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })
})

describe('TraeCnAdapter 流内错误与换号', () => {
  it('**流内限流（HTTP 200 + 4008）触发换号** —— 这是本 provider 的主要失败模式', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn', credentialRef: 'TRAE_CN_ACCOUNT_2' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const updateModelRateLimit = vi.fn(async () => {})
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      return attempt === 1 ? sseResponse(errorStream(4008, '请求过于频繁')) : sseResponse(textStream('ok'))
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const { chunks, error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(calls).toHaveLength(2)
    // 换号时必须把已试账号传给池（否则拿回同一个账号，换号形同虚设）。
    expect(getAvailableAccount).toHaveBeenCalledWith('trae-cn', 'glm-5.2', expect.any(Set))
    // 刚失败的账号记上限流徽章。
    expect(updateModelRateLimit).toHaveBeenCalledWith('acc-1', 'glm-5.2', expect.any(Number))
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('所有账号都限流时报可读错误（带真实业务码），且不超过换号上限', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4008, '请求过于频繁')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount: async () => ({
          entry: { id: `acc-${Math.random()}`, provider: 'trae-cn' },
          credential: makeCredential({ access_token: 'AT-x' }),
        }),
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.message).toMatch(/请求过于频繁/)
    expect(error?.message).toMatch(/code=4008/)
    // 首账号 + 最多 (MAX_ROTATE - 1) 次换号 = 3 次请求。
    expect(calls).toHaveLength(3)
  })

  it('**排队码（4000005）不换号**：只发一次请求，抛可重试错误', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const updateModelRateLimit = vi.fn(async () => {})
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4000005, '排队中')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(error?.code).toBe('RATE_LIMIT')
    // 退避类**不记**冷却徽章：记了下一次选号会跳过该账号 = 偷偷换号。
    expect(updateModelRateLimit).not.toHaveBeenCalled()
  })

  it('**直报码（4001）不换号**，且错误码为 INVALID_REQUEST', async () => {
    const getAvailableAccount = vi.fn(async () => null)
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4001, '参数错误')), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(error?.code).toBe('INVALID_REQUEST')
    expect(error?.message).toMatch(/code=4001/)
  })

  it('4006（请求超长）映射为 CONTEXT_WINDOW_EXCEEDED（触发上下文压缩）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(4006, 'prompt too long')))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('未知码直报，且把原始码带进错误文案（便于真机校准）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(errorStream(77777, '未知错误')))
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('INVALID_REQUEST')
    expect(error?.message).toMatch(/code=77777/)
  })

  it('**已产出正文后不再换号**（避免用户看到半截回答 + 完整回答两段内容）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const updateModelRateLimit = vi.fn(async () => {})
    const body = traeSse([
      { event: 'output', data: { response: '我已经说了一半' } },
      { event: 'error', data: { code: 4008, message: '中途限流' } },
    ])
    const { adapter, calls } = makeAdapter(() => sseResponse(body), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    expect(error?.message).toMatch(/中途限流/)
    // 但不换号**不等于**不记录：这次限流是真实发生的，要留下徽章，
    // 否则用户事后完全看不到原因。
    expect(updateModelRateLimit).toHaveBeenCalledWith('acc-1', 'glm-5.2', expect.any(Number))
  })

  it('**HTTP 5xx 退避但不换号**（网关故障与账号无关，换个账号只会同样失败）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    const { adapter, calls } = makeAdapter(() => new Response('bad gateway', { status: 502 }), {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
    // 可重试码交给 DSH 的重试层退避，而不是烧掉其它账号的额度。
    expect(error?.code).toBe('RATE_LIMIT')
  })

  it('**HTTP 401/403 换号**（凭据被拒是账号级问题）', async () => {
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'trae-cn' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    // 首个账号 401 → 适配器先续期一次并重试（仍是 401）→ 再换号。
    let call = 0
    const { adapter, calls } = makeAdapter(() => {
      call += 1
      return call <= 2 ? new Response('unauthorized', { status: 401 }) : sseResponse(textStream('ok'))
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit: async () => {},
        getAvailableAccount,
      } as never,
    })
    const { error } = await collect(adapter, generateOptions())
    expect(error).toBeUndefined()
    expect(getAvailableAccount).toHaveBeenCalled()
    expect(calls).toHaveLength(3)
  })

  it('无账号池时限流直接报错，且**只发一次**请求', async () => {
    const { adapter, calls } = makeAdapter(() => sseResponse(errorStream(4008, '限流')))
    const { error } = await collect(adapter, generateOptions())
    expect(calls).toHaveLength(1)
    expect(error?.code).toBe('RATE_LIMIT')
  })

  it('零产出（done 但没有内容块）抛 EMPTY_RESPONSE，且不换号', async () => {
    const getAvailableAccount = vi.fn(async () => null)
    const { adapter, calls } = makeAdapter(
      () => sseResponse(traeSse([{ event: 'done', data: {} }])),
      {
        accountPool: {
          findAccountIdByCredential: async () => 'acc-1',
          updateModelRateLimit: async () => {},
          getAvailableAccount,
        } as never,
      },
    )
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('EMPTY_RESPONSE')
    expect(calls).toHaveLength(1)
    expect(getAvailableAccount).not.toHaveBeenCalled()
  })

  it('传输层失败映射为可重试的 TRANSPORT', async () => {
    const { adapter } = makeAdapter(() => { throw new TypeError('fetch failed') })
    const { error } = await collect(adapter, generateOptions())
    expect(error?.code).toBe('TRANSPORT')
  })
})

describe('TraeCnAdapter 收尾判定', () => {
  it('正常结束 → finish: stop', async () => {
    const { adapter } = makeAdapter(() => sseResponse(textStream('ok')))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('有工具调用 → finish: tool-calls', async () => {
    const { adapter } = makeAdapter(() => sseResponse(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"a":1}' } },
      { event: 'done', data: {} },
    ])))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('**中断流（无 done）→ finish: max-tokens**（不让 harness 执行残缺参数）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(traeSse([
      { event: 'output', data: { response: '半截' } },
    ])))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('工具参数残缺 → finish: max-tokens（而不是 tool-calls）', async () => {
    const { adapter } = makeAdapter(() => sseResponse(traeSse([
      { event: 'tool_call', data: { id: 'c1', name: 'read', arguments: '{"a"' } },
      { event: 'done', data: {} },
    ])))
    const { chunks } = await collect(adapter, generateOptions())
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })
})

describe('Trae CN 模型目录解析（parseTraeCnModels）', () => {
  it('解析扁平数组与嵌套信封', () => {
    const entry = {
      model_name: 'glm-5.2',
      display_name: 'GLM-5.2',
      display_contact_config: { consumption_rate: { data: { rate: 1.5 } } },
    }
    expect(parseTraeCnModels([entry])).toEqual([{ id: 'glm-5.2', name: 'GLM-5.2', consumptionRate: 1.5 }])
    expect(parseTraeCnModels({ data: [entry] })).toHaveLength(1)
    expect(parseTraeCnModels({ data: { models: [entry] } })).toHaveLength(1)
  })

  it('缺展示名时以 id 兜底；缺 id 的条目被跳过', () => {
    expect(parseTraeCnModels([{ model_name: 'm1' }])).toEqual([{ id: 'm1', name: 'm1' }])
    expect(parseTraeCnModels([{ display_name: 'x' }, { model_name: 'm1' }])).toEqual([{ id: 'm1', name: 'm1' }])
  })

  it('**不编造默认倍率**：读不到时字段缺席（而不是填 1.0）', () => {
    expect(parseTraeCnModels([{ model_name: 'm1' }])[0]).not.toHaveProperty('consumptionRate')
    expect(parseTraeCnModels([{ model_name: 'm1', display_contact_config: {} }])[0]).not.toHaveProperty('consumptionRate')
  })

  it('结构不符时返回空数组（调用方回退兜底表）', () => {
    for (const bad of [null, 'x', 42, {}, { data: null }, { data: 'nope' }]) {
      expect(parseTraeCnModels(bad)).toEqual([])
    }
  })
})

describe('registerTraeCnLlm', () => {
  it('注册 provider 目录与适配器，settingsNs 为 llm-trae-cn', () => {
    const configurable: Array<Record<string, unknown>> = []
    const adapters: string[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: (entries: Array<Record<string, unknown>>) => { configurable.push(...entries) },
        registerAdapter: (providers: string[]) => { adapters.push(...providers) },
      },
    }
    registerTraeCnLlm(ctx as never, {
      credentialRef: credentialRef('TRAE_CN_ACCESS_TOKEN'),
      resolveCredential: async () => undefined,
      refresh: async () => {},
    })
    expect(configurable).toEqual([{
      provider: 'trae-cn',
      displayName: 'Trae CN (字节跳动)',
      // 连字符在这里是**正确的**：namespace 是字符串键，与 cordis 服务名
      // （traeCnAuth）走两套命名规则。漏注册会让模型设置页在
      // refFor → deriveKeyRef(provider) 处崩溃。
      settingsNs: 'llm-trae-cn',
      settingsPath: [],
    }])
    expect(adapters).toEqual(['trae-cn'])
  })
})
