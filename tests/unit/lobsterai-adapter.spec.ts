import { describe, expect, it, vi } from 'vitest'
import {
  PROVIDER,
  LobsteraiAdapter,
  buildLobsteraiModelsQuery,
  buildLobsteraiModelsUrl,
  parseLobsteraiModels,
  registerLobsteraiLlm,
} from '../../src/lobsterai-adapter.js'
import { LOBSTERAI } from '../../src/lobsterai-product.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { LobsteraiCredential } from '../../src/lobsterai.js'

const CLIENT_VERSION = '2026.9.4'

function makeCredential(overrides: Partial<LobsteraiCredential> = {}): LobsteraiCredential {
  return {
    access_token: 'AT',
    refresh_token: 'RT',
    expires_at: String(Date.now() + 7_200_000),
    uid: 'uid-1',
    user_id: 'yid-1',
    nickname: '测试账号',
    uuid: 'uuid-1',
    first_keyfrom: '1700000000000',
    latest_keyfrom: '1700000000000',
    ...overrides,
  }
}

/** 构造一个 SSE 响应体。 */
function sseResponse(chunks: string[]): Response {
  const body = chunks.map((chunk) => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 一次普通的文本回复。 */
function textSse(text: string): Response {
  return sseResponse([
    JSON.stringify({ id: 'c1', model: 'glm-5.2', choices: [{ delta: { content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])
}

/** 构造适配器 + 捕获请求的 fetch stub。 */
function makeAdapter(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: Partial<ConstructorParameters<typeof LobsteraiAdapter>[0]> = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as unknown as typeof fetch
  const adapter = new LobsteraiAdapter({
    credentialRef: credentialRef('LOBSTERAI_ACCOUNT_TEST'),
    resolveCredential: async () => makeCredential(),
    refresh: async () => {},
    fetchImpl: fetcher,
    resolveClientVersion: async () => CLIENT_VERSION,
    product: LOBSTERAI,
    ...options,
  })
  return { adapter, calls, fetcher }
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'lobsterai',
    model: 'glm-5.2',
    messages: [createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

/** 收集 stream() 的全部 chunk。 */
async function collect(options: GenerateOptions, adapter: LobsteraiAdapter) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

describe('LobsterAI 模型列表解析', () => {
  it('解析 data.data 数组（外层信封 + 内层 data 数组）', () => {
    // 注意双层：外层是统一信封 {code,msg,data}，内层 data 才是模型数组。
    expect(parseLobsteraiModels({
      code: 0, msg: 'OK',
      data: { data: [{ modelId: 'glm-5.2', modelName: 'GLM-5.2', provider: 'p', apiFormat: 'openai' }] },
    })).toEqual([{ id: 'glm-5.2', name: 'GLM-5.2' }])
  })

  it('缺 modelName 时以 id 兜底', () => {
    expect(parseLobsteraiModels({ code: 0, data: { data: [{ modelId: 'm1' }] } }))
      .toEqual([{ id: 'm1', name: 'm1' }])
  })

  it('跳过缺 modelId 的条目', () => {
    expect(parseLobsteraiModels({
      code: 0, data: { data: [{ modelName: 'x' }, { modelId: 'm1' }] },
    })).toEqual([{ id: 'm1', name: 'm1' }])
  })

  it('信封失败、结构不符、非数组时返回空数组（调用方回退兜底目录）', () => {
    for (const bad of [
      { code: 500, msg: 'boom' },
      { code: 0, data: null },
      { code: 0, data: {} },
      { code: 0, data: { data: 'nope' } },
      null, 'x', 42,
    ]) {
      expect(parseLobsteraiModels(bad)).toEqual([])
    }
  })
})

describe('LobsterAI 模型列表 query', () => {
  it('带 keyfrom 身份字段但**不含** refreshToken', () => {
    // client.go:229-241 只用 KeyfromBody 的字段；refreshToken 进 query
    // 既是信息泄露（会落在服务端访问日志），也不是该端点的预期输入。
    const query = buildLobsteraiModelsQuery(makeCredential(), CLIENT_VERSION)
    expect(query).toContain('firstKeyfrom=1700000000000')
    expect(query).toContain('version=2026.9.4')
    expect(query).toContain('uuid=uuid-1')
    expect(query).toContain('userId=yid-1')
    expect(query).not.toContain('refreshToken')
    expect(query).not.toContain('RT')
  })

  it('构造完整 URL', () => {
    expect(buildLobsteraiModelsUrl(LOBSTERAI, makeCredential(), CLIENT_VERSION))
      .toContain('https://lobsterai-server.youdao.com/api/models/available?')
  })
})

describe('LobsteraiAdapter providerInfo', () => {
  it('返回产品 id 与展示名', () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    expect(adapter.providerInfo('lobsterai')).toEqual({
      id: 'lobsterai', name: 'LobsterAI (有道)',
    })
  })

  it('provider 入参非法时回退到产品 id（避免 toUpperCase 崩溃）', () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    expect(adapter.providerInfo(undefined as unknown as string).id).toBe('lobsterai')
    expect(adapter.providerInfo('').id).toBe('lobsterai')
  })

  it('PROVIDER 常量为 lobsterai', () => {
    expect(PROVIDER).toBe('lobsterai')
  })
})

describe('LobsteraiAdapter 模型目录', () => {
  it('无远端时用产品兜底目录（19 个）', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    const models = await adapter.listModels('lobsterai')
    expect(models).toHaveLength(19)
    expect(models[0]).toMatchObject({ provider: 'lobsterai', id: 'deepseek-v4-flash' })
  })

  it('inputModalities 恒为 text（图片未实测支持）', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    for (const model of await adapter.listModels('lobsterai')) {
      expect(model.inputModalities).toEqual(['text'])
    }
  })

  it('远端可用时以远端为准（不做「以兜底表为准」的裁剪）', async () => {
    // LobsterAI 的远端接口是权威的（兜底表本身就抄自它），
    // 与 buddy 的 reconcileWithFallback 语义相反。
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => [{ id: 'remote-only', name: 'Remote Only' }],
    })
    const models = await adapter.listModels('lobsterai')
    expect(models).toEqual([{ provider: 'lobsterai', id: 'remote-only', name: 'Remote Only', inputModalities: ['text'] }])
  })

  it('远端返回空数组时回退兜底目录', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), { fetchRemoteModels: async () => [] })
    expect(await adapter.listModels('lobsterai')).toHaveLength(19)
  })

  it('远端抛错时回退兜底目录', async () => {
    const { adapter } = makeAdapter(() => textSse('x'), {
      fetchRemoteModels: async () => { throw new Error('boom') },
    })
    expect(await adapter.listModels('lobsterai')).toHaveLength(19)
  })

  it('应用账号池的模型黑名单', async () => {
    const disabledModelsFor = vi.fn(() => new Set(['glm-5.2']))
    const { adapter } = makeAdapter(() => textSse('x'), {
      accountPool: { disabledModelsFor } as never,
    })
    const ids = (await adapter.listModels('lobsterai')).map((m) => m.id)
    expect(ids).not.toContain('glm-5.2')
    expect(disabledModelsFor).toHaveBeenCalledWith('lobsterai')
  })
})

describe('LobsteraiAdapter resolveModel', () => {
  it('用兜底表给出上下文窗口', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    const resolved = await adapter.resolveModel('lobsterai', 'glm-5.2')
    expect(resolved.context).toEqual({ contextWindow: 131_072 })
  })

  it('**不声明** reasoning（是否支持思考等级未实测）', async () => {
    // 声明了却无效会让用户以为档位生效；不声明时 UI 显示
    //「当前模型未提供推理等级」，这是诚实的。
    const { adapter } = makeAdapter(() => textSse('x'))
    const resolved = await adapter.resolveModel('lobsterai', 'glm-5.2')
    expect(resolved.reasoning).toBeUndefined()
  })

  it('未知模型回退为 id 作展示名且不报错', async () => {
    const { adapter } = makeAdapter(() => textSse('x'))
    const resolved = await adapter.resolveModel('lobsterai', 'unknown-model')
    expect(resolved.name).toBe('unknown-model')
    expect(resolved.context).toBeUndefined()
  })
})

describe('LobsteraiAdapter 请求构造', () => {
  it('POST 到 {apiBase}/api/proxy/v1/chat/completions', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    expect(calls[0]!.url).toBe('https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions')
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('**stream 恒为 true**（上游只支持 SSE，false 会 500）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.stream).toBe(true)
  })

  it('请求头含 LobsterAI 专属头，且**不含**腾讯系归属头', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const headers = calls[0]!.init?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer AT')
    expect(headers.get('X-LobsterAI-Client-Capabilities')).toBe('kimi-k3-agentic-v1')
    expect(headers.get('X-LobsterAI-Client-Version')).toBe(CLIENT_VERSION)
    expect(headers.get('User-Agent')).toBe('LobsterAI/0.1.0')
    for (const banned of ['X-Domain', 'X-Product', 'X-Product-Code', 'X-IDE-Name']) {
      expect(headers.get(banned), banned).toBeNull()
    }
  })

  it('**不发** prompt_cache_key（那是腾讯后端的前缀缓存机制）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('prompt_cache_key')
  })

  it('**不发** thinking（未实测支持，照搬 buddy 会造成非法参数 400）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ model: 'deepseek-v4-flash' }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('调用方显式传 reasoningEffort 时透传', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ reasoningEffort: 'high' as never }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.reasoning_effort).toBe('high')
  })

  it('透传 temperature / maxTokens / stop', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ temperature: 0.3, maxTokens: 1024, stop: ['END'] }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(1024)
    expect(body.stop).toEqual(['END'])
  })

  it('system 提示折叠进 messages 首位', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({ system: '你是助手' }), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' })
  })

  it('工具 schema 映射为 OpenAI function 形态', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      tools: [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } }],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { tools: unknown[] }
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } },
    }])
  })

  it('无工具时不发 tools 字段', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions(), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('tools')
  })
})

describe('LobsteraiAdapter 凭据处理', () => {
  it('凭据缺失时抛 MISSING_CREDENTIAL', async () => {
    const { adapter } = makeAdapter(() => textSse('hi'), { resolveCredential: async () => undefined })
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/no usable credential/)
  })

  it('凭据过期时先续期再发请求', async () => {
    let refreshed = false
    const expired = makeCredential({ expires_at: String(Date.now() - 1000) })
    const { adapter, calls } = makeAdapter(() => textSse('hi'), {
      resolveCredential: async () => (refreshed ? makeCredential() : expired),
      refresh: async () => { refreshed = true },
    })
    await collect(generateOptions(), adapter)
    expect(refreshed).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('401 时续期一次并重试', async () => {
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      return attempt === 1
        ? new Response('{"code":401}', { status: 401 })
        : textSse('ok')
    }, { refresh: async () => {} })
    const chunks = await collect(generateOptions(), adapter)
    expect(calls).toHaveLength(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })
})

describe('LobsteraiAdapter 错误处理', () => {
  it('积分不足时抛 QUOTA_EXCEEDED 且带可读文案', async () => {
    const { adapter } = makeAdapter(() => new Response(
      JSON.stringify({ code: 402, msg: '积分不足' }), { status: 402 },
    ))
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/积分不足/)
  })

  it('HTTP 400 映射为 INVALID_REQUEST', async () => {
    const { adapter } = makeAdapter(() => new Response('bad request', { status: 400 }))
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string })
    expect(error.code).toBe('INVALID_REQUEST')
  })

  it('5xx 映射为 SERVER', async () => {
    const { adapter } = makeAdapter(() => new Response('boom', { status: 503 }))
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string })
    expect(error.code).toBe('SERVER')
  })

  it('传输层失败映射为可重试的 TRANSPORT', async () => {
    const { adapter } = makeAdapter(() => { throw new Error('socket hang up') })
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string })
    expect(error.code).toBe('TRANSPORT')
  })

  it('图片输入报 UNSUPPORTED_CONTENT（而不是静默丢弃）', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    const options = generateOptions({
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId: 'a1' } }],
        source: { kind: 'user' },
      })],
    } as never)
    await expect(collect(options, adapter)).rejects.toThrow(/不支持图片输入/)
    // 应在取凭据/发请求之前就拒绝。
    expect(calls).toHaveLength(0)
  })
})

describe('LobsteraiAdapter SSE 消费', () => {
  it('文本增量产出 block-start / text-delta / block-end / finish', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '好' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks.filter((c) => c.type === 'text-delta')).toEqual([
      { type: 'text-delta', index: 0, text: '你' },
      { type: 'text-delta', index: 0, text: '好' },
    ])
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
    expect(end).toMatchObject({ block: { type: 'text', text: '你好' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('兼容 `data:` 后**无空格**（上游实测形态）', async () => {
    const body = 'data:{"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'
    const { adapter } = makeAdapter(() => new Response(body, { status: 200 }))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'x' })
  })

  it('reasoning_content 单独成块', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '想' } }] }),
      JSON.stringify({ choices: [{ delta: { content: '答' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: '想' })
    expect(chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning'))
      .toMatchObject({ block: { type: 'reasoning', text: '想' } })
  })

  it('兼容把完整消息放在 message 而非 delta（对齐 sse.go:97-102）', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ message: { content: '完整' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '完整' })
  })

  it('tool_calls 分片按 index 合并，name 只允许非空覆盖', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"a"' } }] } }] }),
      // 后续分片带空 name（直接覆盖会清空工具名 → unknown tool ""）
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: '', arguments: ':1}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toMatchObject({ block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"a":1}' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('无参数工具的空分片补成 {}', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'ls', arguments: '' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]))
    const chunks = await collect(generateOptions(), adapter)
    const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    expect(end).toMatchObject({ block: { arguments: '{}' } })
  })

  it('finish_reason=length 归为 max-tokens（不让 harness 执行残缺参数）', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: '截断' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    ]))
    expect((await collect(generateOptions(), adapter)).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('工具参数残缺但未收 finish_reason 时归为 max-tokens', async () => {
    // 连接被中途掐断 → 参数必然是半截 JSON。报 tool-calls 会让 harness
    // 执行缺参调用并报 schema 错误，模型陷入重试循环。
    const { adapter } = makeAdapter(() => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{"file_path"' } }] } }] })}\n\n`,
      { status: 200 },
    ))
    expect((await collect(generateOptions(), adapter)).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('usage 只把未命中缓存部分计入 inputTokens', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({
        choices: [{ delta: { content: 'x' } }],
        usage: {
          prompt_tokens: 1000, completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]))
    const usage = (await collect(generateOptions(), adapter)).find((c) => c.type === 'usage')
    expect(usage).toMatchObject({ usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 800 } })
  })

  it('上游把错误放进 SSE 帧时抛出 SERVER 错误', async () => {
    const { adapter } = makeAdapter(() => sseResponse([
      JSON.stringify({ error: { message: '模型不可用' } }),
    ]))
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/模型不可用/)
  })

  it('畸形 JSON 帧被跳过而不中断流', async () => {
    const { adapter } = makeAdapter(() => new Response(
      `data: {bad json}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    ))
    const chunks = await collect(generateOptions(), adapter)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'ok' })
  })
})

describe('LobsteraiAdapter 孤儿工具调用清理', () => {
  it('剔除没有结果的 tool_call 批次（避免后端 400 让会话报废）', async () => {
    // assistant 带 tool_calls 但历史里没有对应 tool 结果 —— 这条坏历史
    // 若原样重放，后端会对之后每条消息都 400。
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      messages: [
        createUserMessage({ content: [{ type: 'text', text: '起点' }], source: { kind: 'user' } }),
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'orphan', name: 'read', arguments: '{}' }],
        },
      ],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant).not.toHaveProperty('tool_calls')
  })

  it('配对的 tool_call 与 tool 结果都保留', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      messages: [
        createUserMessage({ content: [{ type: 'text', text: '起点' }], source: { kind: 'user' } }),
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'ok-1', name: 'read', arguments: '{"p":"a"}' }],
        },
        createUserMessage({
          content: [{ type: 'tool-result', toolCallId: 'ok-1', content: [{ type: 'text', text: 'file' }] }],
          source: { kind: 'user' },
        }),
      ],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant') as { tool_calls: unknown[] }
    expect(assistant.tool_calls).toHaveLength(1)
    expect(body.messages.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'ok-1' })
  })

  it('assistant 正文为空且有 tool_calls 时 content 为 null', async () => {
    const { adapter, calls } = makeAdapter(() => textSse('hi'))
    await collect(generateOptions({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
        },
        createUserMessage({
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }],
          source: { kind: 'user' },
        }),
      ],
    } as never), adapter)
    const body = JSON.parse(String(calls[0]!.init?.body)) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant') as { content: unknown }
    expect(assistant.content).toBeNull()
  })
})

describe('LobsteraiAdapter 限流切换', () => {
  it('限流时记录重置时间并切到下一个账号', async () => {
    const updateModelRateLimit = vi.fn(async () => {})
    const getAvailableAccount = vi.fn(async () => ({
      entry: { id: 'acc-2', provider: 'lobsterai' },
      credential: makeCredential({ access_token: 'AT-2' }),
    }))
    let attempt = 0
    const { adapter, calls } = makeAdapter(() => {
      attempt += 1
      if (attempt === 1) {
        return new Response('您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置', { status: 429 })
      }
      return textSse('ok')
    }, {
      accountPool: {
        findAccountIdByCredential: async () => 'acc-1',
        updateModelRateLimit,
        getAvailableAccount,
      } as never,
    })
    const chunks = await collect(generateOptions(), adapter)
    expect(updateModelRateLimit).toHaveBeenCalledWith('acc-1', 'glm-5.2', expect.any(Number))
    expect(getAvailableAccount).toHaveBeenCalledWith('lobsterai', 'glm-5.2')
    expect(calls).toHaveLength(2)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
  })

  it('全部账号耗尽时抛 QUOTA_EXCEEDED', async () => {
    const { adapter } = makeAdapter(
      () => new Response('您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置', { status: 429 }),
      {
        accountPool: {
          findAccountIdByCredential: async () => 'acc-1',
          updateModelRateLimit: async () => {},
          getAvailableAccount: async () => null,
        } as never,
      },
    )
    const error = await collect(generateOptions(), adapter).catch((e: unknown) => e as { code?: string })
    expect(error.code).toBe('QUOTA_EXCEEDED')
  })

  it('无账号池时积分不足直接报错（不尝试换号）', async () => {
    const { adapter, calls } = makeAdapter(() => new Response(
      JSON.stringify({ code: 402, msg: '积分不足' }), { status: 402 },
    ))
    await expect(collect(generateOptions(), adapter)).rejects.toThrow(/积分不足/)
    expect(calls).toHaveLength(1)
  })
})

describe('registerLobsteraiLlm', () => {
  it('注册 provider 目录与适配器，settingsNs 为 llm-lobsterai', () => {
    const configurable: Array<Record<string, unknown>> = []
    const adapters: string[] = []
    const ctx = {
      llm: {
        registerConfigurableProviders: (entries: Array<Record<string, unknown>>) => { configurable.push(...entries) },
        registerAdapter: (providers: string[]) => { adapters.push(...providers) },
      },
    }
    registerLobsteraiLlm(ctx as never, {
      credentialRef: credentialRef('LOBSTERAI_ACCESS_TOKEN'),
      resolveCredential: async () => undefined,
      refresh: async () => {},
    })
    expect(configurable).toEqual([{
      provider: 'lobsterai', displayName: 'LobsterAI (有道)', settingsNs: 'llm-lobsterai', settingsPath: [],
    }])
    expect(adapters).toEqual(['lobsterai'])
  })
})
