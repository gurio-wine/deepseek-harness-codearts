/**
 * `CreditBalanceRow` 双池（通用 / Work）渲染的回归测试。
 *
 * ## 为什么不沿用源码级断言
 *
 * 本仓库既有的前端测试都是「读源码、正则断言」（`credits-capabilities.spec.ts`、
 * `jet-hub-rpc-account-create.spec.ts`），理由是 react 不在依赖里、组件渲染不了。
 * 但**正则断言恰好无法验证本次要证明的东西**：本次的核心命题是「没有 `workTotal`
 * 的 provider 渲染逐字节不变，有的才多一项」，这是**条件分支的输出差异**，
 * 用 `toMatch(/workTotal/)` 只能证明提到过这个名字，证明不了分支正确。
 *
 * 因此这里换一条路：把插件源码里的 `react` 与 `./credits-capabilities.js` 换成
 * **占位模块**后加载，直接调用纯函数 `CreditBalanceRow`。该组件的产物是一棵
 * 普通对象树，不需要 DOM、不需要 react-dom、不需要 JSX —— 只要 `createElement`
 * 能返回对象即可。于是可以做**精确的整树深比较**，这正是本次要的证据。
 *
 * ## 占位 `createElement` 的边界
 *
 * 这不是 react 的模拟实现，只是把 `(type, props, ...children)` 原样收成对象：
 * 组件不使用 hook、不使用 context、不依赖 key 的调和语义，因此这棵树与 react
 * 真实渲染的**元素结构**一致（断言也只针对结构，不针对真实 DOM 属性）。
 *
 * 同理，`credits-capabilities.js` 被换成固定返回 `true` 的占位：
 * `CreditBalanceRow` 本身不消费能力矩阵（门控在 `ProviderPanel` 里），
 * 换成占位能避免这个测试与能力矩阵的正确性耦合 —— 后者由另一个文件守着。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/** 一个最小 react 占位模块：把参数收成可深比较的普通对象。 */
const REACT_STUB = `
'use strict';
exports.createElement = function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
};
`

/** 能力矩阵占位（组件本身不消费它，见文件头说明）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

/**
 * 插件源码是纯 ESM；这里把它的两条 import 与 export 改写成 CJS 形态后加载。
 *
 * 之所以不引 tsx/esbuild 之类工具：被加载的只是两个纯函数组件，源码里没有
 * 需要转换的 TS 语法，正则改写足够且没有额外依赖与启动开销。
 *
 * 改写**只覆盖本文件真正用到的两行 import**，并逐条断言命中 —— 若哪天
 * `jet-hub.js` 的 import 形态变了，这里会**立刻报错**，而不是静默加载出一个
 * 缺了模块的半成品（那种失败会伪装成「组件返回 undefined」）。
 */
const IMPORT_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^import \* as React from 'react';$/m, "const React = require('react');"],
  [
    /^import \{ supportsCreditBalance, supportsDailyCheckin \} from '\.\/credits-capabilities\.js';$/m,
    "const { supportsCreditBalance, supportsDailyCheckin } = require('./credits-capabilities.js');",
  ],
]

function toCjs(source: string): string {
  let out = source
  for (const [pattern, replacement] of IMPORT_REWRITES) {
    if (!pattern.test(out)) {
      throw new Error(`jet-hub.js 的 import 形态已变化，测试的改写规则失效：${String(pattern)}`)
    }
    out = out.replace(pattern, replacement)
  }
  // `export function` / `export const` → 普通声明（模块作用域内仍互相可见）。
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  // 暴露本次要测的组件。它是模块作用域里的函数声明，故此处必然可见。
  return out.concat('\nmodule.exports.__testExports = { CreditBalanceRow: CreditBalanceRow };\n')
}

function loadClientModule(): Record<string, unknown> {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8'))

  const dir = mkdtempSync(join(tmpdir(), 'jet-hub-row-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  writeFileSync(join(dir, 'jet-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'jet-hub.js')) as { __testExports: Record<string, unknown> }
  tempDir = dir
  return loaded.__testExports
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

const { CreditBalanceRow } = loadClientModule() as {
  CreditBalanceRow: (props: Record<string, unknown>) => RowNode
}

/** `createElement` 占位的产物形态。 */
interface RowNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** 把一个节点渲染成「结构快照」：只保留 type / 关键 props / 文本，便于深比较。 */
function snapshot(node: unknown): unknown {
  if (node === null || node === undefined) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const element = node as RowNode
  return {
    type: element.type,
    className: element.props.className,
    title: element.props.title,
    tone: element.props['data-tone'],
    children: element.children.filter((child) => child !== null && child !== undefined).map(snapshot),
  }
}

/** 一个节点的子树里全部可见文本（按渲染顺序展平）。 */
function textOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined) return []
  return (node as RowNode).children.flatMap(textOf)
}

/**
 * 积分行 `dd` 的直接子元素的文本（即界面上依次显示的那几段）。
 *
 * 先滤掉 `null` / `undefined` 子元素：组件用「条件 ? 元素 : null」表达可选片段，
 * 而 react 本身会丢弃 null 子节点、不产生任何 DOM。占位 `createElement` 原样保留
 * 了它们，故这里按 react 的语义过滤，否则「可选片段没渲染」会被误读成一个空段。
 */
function ddParts(balance: Record<string, unknown>): string[][] {
  const node = CreditBalanceRow({ balance }) as RowNode
  const dd = node.children[1] as RowNode
  return dd.children
    .filter((child) => child !== null && child !== undefined)
    .map(textOf)
}

/** 一个不带 Work 池的余额对象（Buddy 系 / LobsterAI 的形态）。 */
function legacyBalance(overrides: Record<string, unknown> = {}) {
  return {
    total: 247.87,
    packages: [],
    expiredTotal: 0,
    ...overrides,
  }
}

describe('CreditBalanceRow 的三种基础状态（回归护栏，非本次改动）', () => {
  it('loading 显示「读取中…」且不显示 0', () => {
    expect(snapshot(CreditBalanceRow({ loading: true }))).toEqual({
      type: 'div',
      className: 'dim-jh-metaRow',
      title: undefined,
      tone: undefined,
      children: [
        { type: 'dt', className: undefined, title: undefined, tone: undefined, children: ['积分'] },
        { type: 'dd', className: undefined, title: undefined, tone: 'muted', children: ['读取中…'] },
      ],
    })
  })

  it('error 显示原因而不是 0（「查不到」与「余额为 0」严格区分）', () => {
    const node = snapshot(CreditBalanceRow({ balance: null, error: '凭据未配置' }))
    expect(JSON.stringify(node)).toContain('凭据未配置')
    expect(JSON.stringify(node)).not.toContain('0')
  })
})

describe('CreditBalanceRow 的双池形态（Trae CN）', () => {
  it('**有** workTotal 时显示「通用 X / Work Y」，且两个数不合并', () => {
    const parts = ddParts(legacyBalance({ total: 154.22, workTotal: 2000 }))
    // dd 的子元素依次为：通用主数字、Work 项
    expect(parts[0]).toEqual(['通用 154.22'])
    expect(parts[1]).toEqual(['Work 2000'])
    // **绝不合并**：任何位置都不得出现两数之和（2154.22）。
    // 合并会让用户以为 Work 额度能用来对话，正是本次要防的口径陷阱。
    const all = parts.flat().join(' ')
    expect(all).not.toContain('2154')
    expect(all).not.toContain('2,154')
  })

  it('workTotal 为 0 也算「有 Work 池」：显示「通用 X / Work 0」，主数字明确标为通用', () => {
    // 0 是有效信息（该账号没有 Work 积分），不是缺失。此时把主数字标成「通用」
    // 反而更清楚，避免用户把那 0 误读成通用余额。
    const parts = ddParts(legacyBalance({ total: 10, workTotal: 0 }))
    expect(parts[0]).toEqual(['通用 10'])
    expect(parts[1]).toEqual(['Work 0'])
  })

  it('workTotal 为 null / undefined / NaN 时**不**切双池（判据是字段可解析）', () => {
    for (const absent of [undefined, null, Number.NaN]) {
      const parts = ddParts(legacyBalance({ total: 88, workTotal: absent }))
      // 只有主数字，既没有 Work 项，主数字也不加「通用」前缀 —— 与登记前一致。
      expect(parts, String(absent)).toEqual([['88']])
    }
  })

  it('Work 项用独立 class，不套用通用主数字的高亮样式', () => {
    // Work 专属积分只在 TraeWork 能花（IDE 对话只消耗通用池）；
    // Work 若也渲染成高亮蓝，用户会以为它同样可用于对话。
    const node = CreditBalanceRow({
      balance: legacyBalance({ total: 1, workTotal: 2 }),
    }) as RowNode
    const dd = node.children[1] as RowNode
    const work = dd.children[1] as RowNode
    expect(work.type).toBe('span')
    expect(work.props.className).toBe('dim-jh-creditWork')
    // 主数字仍是通用的高亮样式，两者在样式上就是分开的。
    expect((dd.children[0] as RowNode).props.className).toBe('dim-jh-creditTotal')
  })
})

describe('CreditBalanceRow 对其他 provider 是纯增量', () => {
  it('余额对象**没有** workTotal 时，渲染结果与登记前逐元素一致', () => {
    // 这是「别动其他 provider 的渲染」这条约束的可执行形式：期望值写死成
    // 改动前的树，任何意外新增的节点都会让这条断言失败。
    expect(snapshot(CreditBalanceRow({
      balance: {
        total: 247.87,
        packages: [
          { name: '免费额度', remaining: 100, total: 200, active: true, cycleEndTime: '2026-10-01' },
          { name: '活动包', remaining: 147.87, total: 300, active: false, expiredTime: '2026-09-01' },
        ],
        expiredTotal: 12.5,
      },
    }))).toEqual({
      type: 'div',
      className: 'dim-jh-metaRow',
      title: undefined,
      tone: undefined,
      children: [
        { type: 'dt', className: undefined, title: undefined, tone: undefined, children: ['积分'] },
        {
          type: 'dd',
          className: 'dim-jh-creditValue',
          // 明细按 packages 顺序逐行拼接（失效包带自己的失效时间，有效包显示周期）。
          title: '免费额度: 100 / 200 · 本周期至 2026-10-01\n[已失效] 活动包: 147.87 / 300 · 失效于 2026-09-01',
          tone: undefined,
          children: [
            { type: 'strong', className: 'dim-jh-creditTotal', title: undefined, tone: undefined, children: ['247.87'] },
            { type: 'span', className: 'dim-jh-creditPackages', title: undefined, tone: undefined, children: ['1/2 个资源包有效'] },
            { type: 'span', className: 'dim-jh-creditExpired', title: undefined, tone: undefined, children: ['另有 12.50 已失效'] },
          ],
        },
      ],
    })
  })

  it('整数余额不补小数位（与 IDE 的精确值展示对齐）', () => {
    const parts = ddParts(legacyBalance({ total: 100 }))
    expect(parts[0]).toEqual(['100'])
  })
})
