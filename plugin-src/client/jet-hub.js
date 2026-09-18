import * as React from 'react';

import { supportsCreditBalance, supportsDailyCheckin } from './credits-capabilities.js';

export const JET_HUB_RPC_CHANNEL = '/jet-hub';

// 内联图标 base64
const CODEARTS_ICON = 'data:image/png;base64,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'
const CODEBUDDY_ICON = 'data:image/png;base64,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'
const WORKBUDDY_ICON = 'data:image/png;base64,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'

/**
 * LobsterAI 面板图标（内联 SVG data URL）。
 *
 * 用 SVG 而非 base64 PNG：现有三个图标是逆向客户端资源得到的 PNG，
 * 而 LobsterAI 没有可取的官方小图标 —— 内联 SVG 体积小、无色差，
 * 且在 `jet-hub-styles.js` 的 `.dim-jh-providerIcon` 白底容器里显示清晰。
 *
 * 内容是**预先算好的 base64 字面量**，不用 `btoa()` 运行时拼接：
 * 该 bundle 由 esbuild 打包，目标环境未必提供 `btoa`（Node 有、但
 * 客户端 bundle 的运行时按 web 平台配置），字面量最稳妥。
 */
const LOBSTERAI_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0Ij48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSIjZTg1MDNhIi8+PHBhdGggZD0iTTEyIDUuNWMtMi40IDAtNC4yIDEuNi00LjIgNHY1LjJjMCAyLjMgMS44IDMuOCA0LjIgMy44czQuMi0xLjUgNC4yLTMuOFY5LjVjMC0yLjQtMS44LTQtNC4yLTR6IiBmaWxsPSIjZmZmIi8+PGNpcmNsZSBjeD0iMTAuMyIgY3k9IjEwLjIiIHI9IjEiIGZpbGw9IiNlODUwM2EiLz48Y2lyY2xlIGN4PSIxMy43IiBjeT0iMTAuMiIgcj0iMSIgZmlsbD0iI2U4NTAzYSIvPjxwYXRoIGQ9Ik04LjQgNy4yIDYuMiA0LjltOS40IDIuMyAyLjItMi4zTTkuOSAxOC41bC0xLjQgMm02LjYtMiAxLjQgMiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBmaWxsPSJub25lIi8+PC9zdmc+'

/**
 * Trae CN 面板图标（内联 SVG data URL，与 LobsterAI 同款做法）。
 *
 * 来源：Trae CN 桌面客户端自带的品牌标识
 * `%LOCALAPPDATA%\Programs\Trae CN\resources\app\out\media\trae-logo.svg`
 * （397 字节，原样 base64 内联，未做任何改动）。用官方资源而不是自己画：
 * 同一目录下的 `ai-trae-sparkles*.svg` 用的是同一个品牌绿 `#32F08C`，
 * 可交叉印证这就是产品品牌色。
 *
 * 内容同样是**预先算好的 base64 字面量**（理由见上一条注释）。
 */
const TRAE_CN_ICON = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMy42OTIiIGZpbGw9IiMxQTFCMUQiLz48cGF0aCBkPSJNMTMuMjM1IDUuODI5VjQuMzMySDIuNzU4djUuOTg3aDEuNDk2djEuNDk2aDguOTgxVjUuODI4Wm0tMS40OTcgNC40OUg0LjI1NFY1LjgzaDcuNDg0djQuNDlaIiBmaWxsPSIjMzJGMDhDIi8+PHBhdGggZD0iTTYuOTM3IDYuOTkzIDUuODggOC4wNTEgNi45MzcgOS4xMSA3Ljk5NSA4LjA1IDYuOTM3IDYuOTkzWk05LjkzMSA2Ljk5MiA4Ljg3MyA4LjA1IDkuOTMxIDkuMTEgMTAuOTkgOC4wNSA5LjkzIDYuOTkyWiIgZmlsbD0iIzMyRjA4QyIvPjwvc3ZnPg=='

const PROVIDERS = Object.freeze([
  { id: 'codearts', label: 'CodeArts (华为云)', icon: CODEARTS_ICON, logoClass: 'codearts' },
  { id: 'buddy', label: 'CodeBuddy (腾讯)', icon: CODEBUDDY_ICON, logoClass: 'buddy' },
  { id: 'workbuddy', label: 'WorkBuddy (国际版)', icon: WORKBUDDY_ICON, logoClass: 'workbuddy' },
  { id: 'lobsterai', label: 'LobsterAI (有道)', icon: LOBSTERAI_ICON, logoClass: 'lobsterai' },
  // 顺序 = 后端注册顺序（src/index.ts 里 Trae CN 服务在 LobsterAI 之后建立），
  // 也是能力矩阵里的登记顺序。tag 展示名与 TraeCnProduct.displayName 保持一致。
  { id: 'trae-cn', label: 'Trae CN (字节跳动)', icon: TRAE_CN_ICON, logoClass: 'trae-cn' },
]);

/**
 * 积分能力判定见 `./credits-capabilities.js`。
 *
 * 之前这里有一份 `CREDITS_PROVIDERS = ['buddy']`，只用来决定「一键领取积分」
 * 按钮是否渲染，却**没有**约束余额查询 —— 后者在面板挂载时对所有 provider
 * 无条件发起，于是 CodeArts 面板每次打开都在控制台报
 * `unsupported provider: codearts`，账号卡片的「积分」也永远是「查询失败」。
 * 现在两项能力（balance / dailyCheckin）都在同一张表里显式登记，并在请求前判定。
 */

/**
 * 登录弹窗的固定窗口名。
 *
 * 固定名字（而非 `_blank`）有两个作用：
 * 1. **重复点击不开新窗** —— 同名窗口会被浏览器复用，用户连点「+ 新建账号」
 *    也不会攒出一堆登录标签页；
 * 2. 它与 `createAccount` 里 `window.open('')` 的空窗用的是同一个名字，因此
 *    「先开空窗占住用户手势、后填 URL」不会再多开一个窗口。
 *
 * **绝不能加 `noopener`**：`window.open(url, name, 'noopener')` 的返回值恒为
 * `null`，我们就再也拿不到窗口句柄，既无法 `location.replace` 填 URL，
 * 也无法在轮询结束后 `close()` 收尾。
 */
const LOGIN_WINDOW_NAME = 'dsh-account-hub-login';

/**
 * 登录窗口特性：固定尺寸、允许缩放与滚动条。
 *
 * 这些特性只在**该名字的窗口首次创建**时生效；后续同名 `window.open` 会复用
 * 已存在的窗口并忽略特性串 —— 正是我们要的「总是同一个登录窗」。
 */
const LOGIN_WINDOW_FEATURES = 'width=800,height=600,resizable=yes,scrollbars=yes';

function ProviderLogo({ provider }) {
  const p = PROVIDERS.find(p => p.id === provider);
  if (!p) return null;
  return React.createElement('span', { className: `dim-jh-providerIcon ${p.logoClass}` },
    React.createElement('img', { src: p.icon, alt: '', width: 20, height: 20 })
  );
}

function formatTime(ts) {
  if (!ts || ts <= 0) return null;
  const d = new Date(ts);
  const now = Date.now();
  if (ts < now) return '已过期';
  const diff = ts - now;
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟后`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时后`;
  return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// 四个限流标记操作的 hover 帮助文案。抽成常量以便按钮与说明共用同一份措辞。
const RETEST_HELP = '对本账号每个「限额重置」标记的模型真实发送一条最小消息：'
  + '正常返回则清除该标记，仍被限流则保留。会消耗少量模型额度。';
const RETEST_ALL_HELP = '对本页全部账号（含已停用）执行「重测」：'
  + '逐个模型真实发送一条最小消息，正常返回才清除标记。停用账号同样会发送。会消耗模型额度。';
const RESET_HELP = '直接清除本账号的全部「限额重置」标记，不发送任何请求。'
  + '适用于你已确认额度恢复、只想清掉显示的情况。';
const RESET_ALL_HELP = '直接清除本页全部账号（含已停用）的「限额重置」标记，不发送任何请求。';

/**
 * 「显示列表」按钮的说明。
 *
 * 措辞必须讲清两点，否则用户会以为关掉开关就等于删除模型：
 * - 关闭只是**从对话框的模型选择里隐藏**，模型本身仍然存在、可随时再打开；
 * - 采用黑名单制，没被关掉的模型（含服务端后续新增的）默认都是打开的。
 */
const MODEL_LIST_HELP = '列出该 Provider 的全部模型。每个模型后面的开关默认打开；'
  + '关闭后，该模型不再出现在对话框的模型选择列表里（黑名单制：只有被关闭的才隐藏，'
  + '其余含服务端新增的模型一律默认显示）。此设置持久化保存，可随时重新打开。';

/** 把一次重测/重置的响应汇总成一行可读文案。 */
function summarizeProbe(kind, res) {
  if (kind === 'reset' || kind === 'resetAll') {
    const n = res?.clearedCount ?? 0;
    return n > 0 ? `已清除 ${n} 条限流标记` : '没有可清除的限流标记';
  }
  const accounts = res?.accounts ?? [];
  const cleared = res?.clearedCount ?? 0;
  const still = accounts.reduce((sum, a) => sum + (a.stillLimited?.length ?? 0), 0);
  const parts = [];
  if (cleared > 0) parts.push(`已清除 ${cleared} 条`);
  if (still > 0) parts.push(`${still} 条仍受限`);
  if (parts.length === 0) parts.push('没有可重测的限流标记');
  return parts.join('，');
}

/**
 * 把积分余额格式化成一行文案。
 *
 * 保留两位小数：服务端下发的精确值就是两位（如 247.87），而整数版字段
 * 会截断成 247 —— IDE 顶部显示的 "Credits Balance 347.87" 用的是精确值，
 * 这里必须对齐，否则用户会以为插件算错了。
 */
function formatCredits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // 整数不显示多余的小数位（100 而不是 100.00），有小数才保留两位
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 把一个包的明细格式化成 tooltip 的一行。 */
function formatPackageLine(pkg) {
  const remaining = formatCredits(pkg.remaining) ?? '?';
  const total = formatCredits(pkg.total) ?? '?';
  const parts = [`${pkg.active ? '' : '[已失效] '}${pkg.name || '未命名'}: ${remaining} / ${total}`];
  // 失效包显示它自己的失效时间，有效包显示本周期结束时间
  if (!pkg.active && pkg.expiredTime) parts.push(`失效于 ${pkg.expiredTime}`);
  else if (pkg.cycleEndTime) parts.push(`本周期至 ${pkg.cycleEndTime}`);
  return parts.join(' · ');
}

/**
 * 账号卡片上的积分余额行。
 *
 * 三种状态严格区分，不能混为一谈：
 * - 查不到（balance 为 null）→ 显示原因，不要显示成 0 积分
 * - 查到了但余额为 0 → 显示 0
 * - 还没有结果 → 显示"读取中"
 *
 * **双池（通用 / Work）**：Trae CN 的余额对象是 `CreditBalance` 的超集，多带一个
 * `workTotal`（见 `src/trae-cn-credits.ts` 的 `TraeCnCreditBalance`）。带该字段时
 * 一行显示两池：`total` 是**通用池**，`workTotal` 是 Work 池。
 *
 * 两池**绝不合并成一个数**，因为可用范围不同：Work 专属积分只在 TraeWork
 * （work.trae.cn 网页版 / 桌面版）能花，**本插件走的 IDE 对话只消耗通用积分**
 * （TraeWork 内两类积分按到期时间先后扣，Work 专属仅在到期时间相同时优先；
 * 2026-09 起签到发的是通用积分）。合并会让用户以为那 2000 能用来对话，
 * 于是对「明明显示还有 2000 却说余额不足」感到莫名其妙。因此这里既不求和、
 * 也不把 Work 数字按通用数字的蓝色强调样式渲染（用弱化色，暗示它不可直接用于对话）。
 *
 * 其余 provider 的余额对象没有 `workTotal`，走的仍是原路径 —— 渲染结果与登记
 * 这个能力之前**逐元素一致**（`workTotal` 缺失时不产生任何额外节点）。
 */
function CreditBalanceRow({ balance, error, loading }) {
  if (loading) {
    return React.createElement('div', { className: 'dim-jh-metaRow' },
      React.createElement('dt', null, '积分'),
      React.createElement('dd', { 'data-tone': 'muted' }, '读取中…'));
  }
  if (error || !balance) {
    return React.createElement('div', { className: 'dim-jh-metaRow' },
      React.createElement('dt', null, '积分'),
      React.createElement('dd', { 'data-tone': 'warn', title: error || '查询失败' },
        error || '查询失败'));
  }
  const total = formatCredits(balance.total) ?? '0';
  // 只有**确实带了** workTotal 的 provider 才切双池形态。判据是「字段存在且可解析」，
  // 而不是「值是 0 就不显示」：Work 池为 0 也是有效信息（该账号没有 Work 积分），
  // 且此时把主数字标成「通用」反而更清楚 —— 用户不会误以为那 0 是通用余额。
  const hasWorkPool = typeof balance.workTotal === 'number' && Number.isFinite(balance.workTotal);
  // 明细放进 title，不占版面；账号卡片本身已经信息密集了
  const detail = (balance.packages || []).map(formatPackageLine).join('\n');
  const all = balance.packages || [];
  const activeCount = all.filter(p => p.active).length;
  return React.createElement('div', { className: 'dim-jh-metaRow' },
    React.createElement('dt', null, '积分'),
    React.createElement('dd', {
      className: 'dim-jh-creditValue',
      title: detail || undefined,
    },
    React.createElement('strong', { className: 'dim-jh-creditTotal' },
      hasWorkPool ? `通用 ${total}` : total),
    // Work 池单独一项，前缀 `Work` 而非并入主数字。
    hasWorkPool
      ? React.createElement('span', { className: 'dim-jh-creditWork' },
          `Work ${formatCredits(balance.workTotal) ?? '0'}`)
      : null,
    all.length > 1
      ? React.createElement('span', { className: 'dim-jh-creditPackages' },
          `${activeCount}/${all.length} 个资源包有效`)
      : null,
    // 失效额度单独提示：它们仍在服务端响应里，但不计入上面的数字
    balance.expiredTotal > 0
      ? React.createElement('span', { className: 'dim-jh-creditExpired' },
          `另有 ${formatCredits(balance.expiredTotal)} 已失效`)
      : null));
}

function AccountCard({ account, onToggle, onDelete, onRetest, onReset, busy, credits, creditsLoading, showCredits }) {
  const rateLimits = account.modelRateLimits
    ? Object.entries(account.modelRateLimits).filter(([, v]) => v > Date.now())
    : [];
  const expired = typeof account.expiresAt === 'number' && account.expiresAt > 0 && account.expiresAt <= Date.now();
  // 只要存在**任何**标记（即使已过期）就允许重测/重置——过期记录正是
  // 用户最想清理的对象，而 UI 的 rateLimits 只显示未到期的。
  const hasAnyLimit = Boolean(account.modelRateLimits && Object.keys(account.modelRateLimits).length > 0);

  return React.createElement('div', {
    className: 'dim-jh-accountCard',
    'data-enabled': account.enabled,
  },
    React.createElement('div', { className: 'dim-jh-accountTop' },
      React.createElement('span', {
        className: 'dim-jh-accountStatus',
        'data-on': account.enabled ? 'true' : 'false',
        title: account.enabled ? '已启用' : '已停用',
        'aria-hidden': 'true',
      }),
      React.createElement('span', { className: 'dim-jh-accountName' },
        account.nickname || account.id),
      React.createElement('span', {
        className: 'dim-jh-accountTag',
        'data-tone': account.enabled ? 'on' : 'off',
      }, account.enabled ? '已启用' : '已停用')),
    React.createElement('dl', { className: 'dim-jh-accountMeta' },
      React.createElement('div', { className: 'dim-jh-metaRow' },
        React.createElement('dt', null, '凭据'),
        React.createElement('dd', null, React.createElement('code', null, account.credentialRef))),
      React.createElement('div', { className: 'dim-jh-metaRow' },
        React.createElement('dt', null, '有效期'),
        React.createElement('dd', { 'data-tone': expired ? 'warn' : undefined },
          account.expiresAt
            ? `${formatTime(account.expiresAt) || '未知'}${account.refreshable ? ' · 自动续期' : ''}`
            : '未知')),
      // 不支持积分余额的 provider（CodeArts）不渲染该行：留着它只能显示
      // 「查询失败」，而失败原因是「这个 provider 根本没有此接口」——
      // 与其展示一条无法修复的错误，不如不展示。
      showCredits
        ? React.createElement(CreditBalanceRow, {
            balance: credits?.balance ?? null,
            error: credits?.error,
            loading: creditsLoading,
          })
        : null),
    rateLimits.length > 0
      ? React.createElement('div', { className: 'dim-jh-rateLimits' },
          React.createElement('span', { className: 'dim-jh-rateLimitsLabel' }, '限额重置'),
          rateLimits.map(([modelId, resetAt]) =>
            React.createElement('span', {
              key: modelId,
              className: 'dim-jh-ttlBadge',
              title: `模型 ${modelId}`,
            }, `${modelId} · ${formatTime(resetAt)}`)))
      : null,
    React.createElement('div', { className: 'dim-jh-accountActions' },
      React.createElement('button', {
        className: 'dim-jh-btn',
        title: RETEST_HELP,
        disabled: busy || !hasAnyLimit,
        onClick: () => onRetest(account.id),
      }, '重测'),
      React.createElement('button', {
        className: 'dim-jh-btn',
        title: RESET_HELP,
        disabled: busy || !hasAnyLimit,
        onClick: () => onReset(account.id),
      }, '重置'),
      React.createElement('button', {
        className: 'dim-jh-btn',
        onClick: () => onToggle(account.id, !account.enabled),
      }, account.enabled ? '停用' : '启用'),
      React.createElement('button', {
        className: 'dim-jh-btn',
        'data-kind': 'danger',
        onClick: () => onDelete(account.id),
      }, '删除')));
}

/**
 * 单个模型的开关。
 *
 * 刻意不做本地乐观更新：模型列表与黑名单都以 Host 为准（可能是远端拉取的
 * 结果），本地猜测状态容易与真实持久化结果分叉。这里等 RPC 返回后再翻状态，
 * 期间禁用开关，保证界面上看到的就是服务端已接受的。
 */
function ModelToggle({ model, busy, onToggle }) {
  return React.createElement('label', {
    className: 'dim-jh-modelRow',
    'data-disabled': model.disabled ? 'true' : 'false',
    title: model.id,
  },
    React.createElement('span', { className: 'dim-jh-modelInfo' },
      React.createElement('strong', { className: 'dim-jh-modelName' }, model.name || model.id),
      React.createElement('code', { className: 'dim-jh-modelId' }, model.id)),
    React.createElement('input', {
      type: 'checkbox',
      className: 'dim-jh-switch',
      role: 'switch',
      checked: !model.disabled,
      disabled: busy,
      'aria-label': `${model.name || model.id} 是否在模型选择中显示`,
      onChange: () => onToggle(model.id, !model.disabled),
    }));
}

/**
 * 模型列表弹窗：点击「显示列表」后以 modal 形式浮出。
 *
 * 数据全部来自 `model.list` RPC —— 也就是适配器 `listModels()` 播报的同一份
 * 目录（对话框模型选择器读的正是它）。因此这里列出的模型与可选模型一一对应，
 * 不会出现「设置页有、选择器里没有」的错位。
 *
 * 用 modal 而不是内联展开：开关列表可能有几十项，内联会挤占账号区的空间，
 * 也让「账号池」与「模型可见性」两件不相关的事在视觉上混在一起。
 */
function ModelListPanel({ provider, rpcCall, onClose }) {
  const [models, setModels] = React.useState(null);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  // 单次开关操作的失败提示。与 `error` 分开：列表本身的读取失败要用整页
  // 错误态替换，而单次切换失败只需顶部提示、列表必须保留。
  const [toggleError, setToggleError] = React.useState(null);
  // 正在提交的模型 id 集合：只禁用被点的那一行，避免整表锁死。
  const [busyIds, setBusyIds] = React.useState(() => new Set());
  const mounted = React.useRef(true);

  const load = React.useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const res = await rpcCall('model.list', { provider });
      if (!mounted.current) return;
      setModels(res.models || []);
      setPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || '无法读取模型列表');
      setPhase('error');
    }
  }, [provider, rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  // ESC 关闭。挂在 document 上而不是弹窗上：焦点可能落在任意一个开关上，
  // 只监听弹窗自身的 keydown 会漏掉这些按键。
  React.useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggleModel = async (modelId, disabled) => {
    setBusyIds(prev => new Set(prev).add(modelId));
    setToggleError(null);
    try {
      await rpcCall('model.setDisabled', { provider, modelId, disabled });
      if (!mounted.current) return;
      setModels(prev => (prev || []).map(m => (m.id === modelId ? { ...m, disabled } : m)));
    } catch (caught) {
      console.error('[jet-hub] toggle model failed:', caught);
      if (!mounted.current) return;
      // 开关切换失败不能把整张表替换成错误页——用户会以为模型列表没了。
      // 保留列表，只在顶部提示这次操作失败。
      setToggleError(caught?.message || '切换模型显示状态失败');
    } finally {
      if (mounted.current) {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      }
    }
  };

  const all = models || [];
  const hiddenCount = all.filter(m => m.disabled).length;
  const providerLabel = PROVIDERS.find(p => p.id === provider)?.label || provider;

  const dialog = React.createElement('div', {
    className: 'dim-jh-modalOverlay',
    // 点击遮罩关闭；点击弹窗内部不关闭（stopPropagation 由内层容器负责）。
    onClick: (event) => { if (event.target === event.currentTarget) onClose(); },
  },
    React.createElement('div', {
      className: 'dim-jh-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${providerLabel} 模型列表`,
    },
      React.createElement('div', { className: 'dim-jh-modalHead' },
        React.createElement('div', { className: 'dim-jh-modalTitle' },
          React.createElement('strong', null, '模型列表'),
          React.createElement('span', { className: 'dim-jh-modalSubtitle' }, providerLabel),
          phase === 'ready'
            ? React.createElement('span', { className: 'dim-jh-modelPanelCount' },
                `${all.length} 个模型${hiddenCount > 0 ? `，已隐藏 ${hiddenCount} 个` : ''}`)
            : null),
        React.createElement('div', { className: 'dim-jh-modelPanelActions' },
          React.createElement('button', {
            className: 'dim-jh-btn',
            disabled: phase === 'loading',
            onClick: () => void load(),
          }, phase === 'loading' ? '读取中…' : '刷新'),
          React.createElement('button', {
            className: 'dim-jh-btn',
            'data-kind': 'primary',
            onClick: onClose,
          }, '完成'))),
      React.createElement('p', { className: 'dim-jh-modalHint' },
        '关闭开关后该模型不再出现在对话框的模型选择里；其余模型（含服务端新增的）默认显示。'),
      toggleError
        ? React.createElement('div', {
            className: 'dim-jh-probeNotice',
            'data-tone': 'error',
            role: 'alert',
          }, React.createElement('div', null, toggleError))
        : null,
      phase === 'error'
        ? React.createElement('div', { className: 'dim-jh-modalBody' },
            React.createElement('div', { className: 'dim-jh-empty' },
              React.createElement('p', null, error),
              React.createElement('button', { className: 'dim-jh-btn', onClick: () => void load() }, '重新读取')))
        : phase === 'loading'
          ? React.createElement('div', { className: 'dim-jh-modalBody' },
              React.createElement('div', { className: 'dim-jh-empty' }, '正在读取模型列表…'))
          : all.length === 0
            ? React.createElement('div', { className: 'dim-jh-modalBody' },
                React.createElement('div', { className: 'dim-jh-empty' },
                  React.createElement('p', null, '该 Provider 当前没有可用的模型。')))
            : React.createElement('div', { className: 'dim-jh-modalBody' },
                React.createElement('div', { className: 'dim-jh-modelList' },
                  all.map(model => React.createElement(ModelToggle, {
                    key: model.id,
                    model,
                    busy: busyIds.has(model.id),
                    onToggle: (id, disabled) => void toggleModel(id, disabled),
                  }))))));

  // 与登录弹窗（.dim-jh-loginOverlay）同款做法：直接渲染在组件树内，靠
  // position: fixed 覆盖全屏。**刻意不用 createPortal** —— 客户端模块表由
  // 宿主注入（staticModules 种子表），本仓库无法离线确认 `react-dom` 是否在
  // 其中；一旦不在，require 会抛「missed the module table」，弹窗直接白屏。
  // 现有登录弹窗已证明 fixed 定位在这些面板里工作正常。
  return dialog;
}

function ProviderPanel({ provider, rpcCall }) {
  const [accounts, setAccounts] = React.useState([]);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  // 正在进行的限流操作：null | 'one' | 'all'。用于禁用按钮并显示进度。
  const [probeBusy, setProbeBusy] = React.useState(null);
  // 上一次重测/重置的结果文案（成功或失败）。
  const [probeNotice, setProbeNotice] = React.useState(null);
  // 积分余额：accountId → { balance, error }。与账号列表分开加载——余额要逐
  // 账号发网络请求，不能拖慢账号列表本身的渲染。
  const [credits, setCredits] = React.useState({});
  const [creditsLoading, setCreditsLoading] = React.useState(false);
  /**
   * 弹窗被拦截时的**手动登录链接**（`{ url }` | null）。
   *
   * 空窗开不出来时不顶掉 DSH 页面，而是在面板内渲染一个由用户亲自点击的
   * `<a href>` —— 用户手势由浏览器直接识别，不经过任何 await。
   */
  const [manualLogin, setManualLogin] = React.useState(null);
  const mounted = React.useRef(true);
  /**
   * 最新账号列表的 ref 镜像。
   *
   * loadCredits 的失败分支需要"当前有哪些账号"，但它与 loadAccounts 并发发起，
   * 闭包里的 accounts 还是初始空数组。ref 保证读到的是最新值。
   */
  const accountsRef = React.useRef([]);

  const loadAccounts = React.useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const res = await rpcCall('account.list', { provider });
      if (!mounted.current) return;
      const list = res.accounts || [];
      accountsRef.current = list;
      setAccounts(list);
      setPhase('ready');
    } catch (caught) {
      if (!mounted.current) return;
      setError(caught?.message || '无法读取账号列表');
      setPhase('error');
    }
  }, [provider, rpcCall]);

  /**
   * 本 provider 是否支持积分余额查询。
   *
   * CodeArts 是华为云账号体系，后端**没有**这两条腾讯计费接口
   * （`credits.balances` 会回 `unsupported provider: codearts`）。
   * 因此这里必须在**发起请求之前**判掉：既不调用 RPC，也不渲染「积分」行与
   * 「刷新积分」按钮——否则卡片会永远停在「查询失败」，控制台每次都留报错。
   *
   * 判定依据是 `./credits-capabilities.js` 的能力矩阵（唯一真相源），
   * 而不是散落在 UI 里的 provider 字面量比较。
   */
  const canLoadCredits = supportsCreditBalance(provider);
  // CodeBuddy / WorkBuddy 支持每日签到积分，其他 provider 不渲染领取按钮。
  const supportsCredits = supportsDailyCheckin(provider);

  /**
   * 拉取本页全部账号的积分余额。
   *
   * 单独一个请求、单独的 loading 状态：余额查询涉及逐账号的网络往返，可能
   * 慢或失败；它绝不能影响账号列表的可用性——查不到余额时卡片显示原因，
   * 而不是让整个面板变成错误页。
   *
   * **不支持的 provider 直接返回**：不支持的 provider（CodeArts）连请求都不发。
   * 这是刻意放在函数内部而不是只靠调用点判断——`claimCredits` / 「刷新积分」
   * 按钮等多个入口都调它，门控收在这里才不会被将来新增的调用点绕过。
   */
  const loadCredits = React.useCallback(async () => {
    if (!canLoadCredits) return;
    setCreditsLoading(true);
    try {
      const res = await rpcCall('credits.balances', { provider });
      if (!mounted.current) return;
      const next = {};
      for (const item of res.accounts || []) {
        next[item.accountId] = { balance: item.balance, error: item.error };
      }
      setCredits(next);
    } catch (caught) {
      console.error('[jet-hub] load credits failed:', caught);
      if (!mounted.current) return;
      // 整批失败（如 provider 不支持、RPC 未注册）：给当前每个账号都留下失败
      // 原因，避免卡片永远停在"读取中"。
      //
      // 用 accountsRef 而不是闭包里的 accounts：本函数与 loadAccounts 在挂载时
      // 并发发起，此刻闭包捕获的 accounts 仍是初始空数组，会导致一个账号都
      // 标记不上。ref 始终指向最新值。
      const snapshot = accountsRef.current;
      setCredits(prev => {
        const next = { ...prev };
        for (const account of snapshot) {
          next[account.id] = { balance: null, error: caught?.message || '积分查询失败' };
        }
        return next;
      });
    } finally {
      if (mounted.current) setCreditsLoading(false);
    }
  }, [provider, rpcCall, canLoadCredits]);

  React.useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    // 只有支持余额查询的 provider 才在挂载时拉积分；CodeArts 不会走到这里
    // （loadCredits 内部也有一道门控，这里提前判掉是为了连 loading 状态都不翻）。
    if (canLoadCredits) void loadCredits();
    return () => { mounted.current = false; };
    // loadCredits 依赖 accounts，但这里只想在挂载/provider 变化时各跑一次；
    // 账号刷新后由操作方显式再调 loadCredits（见 claimCredits）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // 积分领取状态：claiming 用于禁用按钮，claimNotice 展示上一次领取的结果摘要。
  const [claiming, setClaiming] = React.useState(false);
  const [claimNotice, setClaimNotice] = React.useState(null);
  // 「显示列表」：控制模型列表面板的展开状态。关闭时不挂载面板，避免
  // 每次进入面板都白白发一次 model.list 请求。
  const [showModels, setShowModels] = React.useState(false);

  /**
   * 一键领取当前 provider 下全部已启用账号的每日签到积分。
   *
   * 后端逐个账号顺序处理，单个账号失败不会中断整批，因此这里通常正常返回，
   * 由 summary 各计数决定提示文案与色调。
   *
   * **不支持的 provider 直接返回**：守卫与按钮渲染同源（`supportsCredits`），
   * 放在函数内是为了将来若从别处调用（如快捷键、批量入口）也不会打到
   * `unsupported provider` 上——按钮不渲染只是 UI 便利，不是安全边界。
   */
  const claimCredits = async () => {
    if (!supportsCredits) return;
    setClaiming(true);
    setClaimNotice(null);
    try {
      const res = await rpcCall('credits.claimAll', { provider });
      const { summary } = res;
      const parts = [];
      if (summary.claimed > 0) parts.push(`${summary.claimed} 个账号领取成功（+${summary.totalCredit} 积分）`);
      if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今日已领取`);
      if (summary.inactive > 0) parts.push(`${summary.inactive} 个活动未开启`);
      if (summary.failed > 0) parts.push(`${summary.failed} 个失败`);
      if (!mounted.current) return;
      setClaimNotice({
        tone: summary.failed > 0 ? 'warn' : 'ok',
        text: parts.length > 0 ? parts.join('，') : '没有可领取的账号',
      });
      await loadAccounts();
      // 领取会改变余额，顺带刷新一次，免得卡片还显示领取前的数字
      await loadCredits();
    } catch (caught) {
      console.error('[jet-hub] claim credits failed:', caught);
      if (!mounted.current) return;
      setClaimNotice({ tone: 'error', text: caught?.message || '领取积分失败' });
    } finally {
      if (mounted.current) setClaiming(false);
    }
  };

  const createAccount = async () => {
    setCreating(true);
    // 弹窗被拦截时展示的手动登录链接（{ url } | null）。渲染在面板内，
    // **绝不**用 location.href 顶掉 DSH 页面。
    setManualLogin(null);
    /**
     * 手势内先开的空窗。
     *
     * 必须在**任何 await 之前**打开：`window.open` 只有在用户手势的同步调用栈里
     * 才不会被拦截。宿主侧虽然已把 `account.create` 改成秒回，但客户端不该依赖
     * 「RPC 恰好够快」—— 只要有一次慢了，await 之后就再也开不出窗口。
     * 因此这里先开一个 `about:blank` 空窗占住手势，RPC 返回后再填 URL。
     */
    const loginWindow = window.open('', LOGIN_WINDOW_NAME, LOGIN_WINDOW_FEATURES);
    console.log('[jet-hub] account.create request, provider =', provider, '/ popup =', loginWindow);

    /** 关闭手势内开的空窗（幂等；已被拦截时为 no-op）。 */
    const closeLoginWindow = () => {
      try {
        if (loginWindow && !loginWindow.closed) loginWindow.close();
      } catch { /* 跨源或已被用户关闭：忽略 */ }
    };

    try {
      const res = await rpcCall('account.create', { provider });
      console.log('[jet-hub] account.create response =', res);
      const accountId = res?.accountId;
      const loginUrl = res?.loginUrl;
      if (!accountId) {
        // 响应残缺（既没 accountId 也就无从轮询）：同样按错误处理并收窗。
        closeLoginWindow();
        setError('后端返回的账号信息不完整（缺少 accountId）。');
        setPhase('error');
        return;
      }
      if (!loginUrl) {
        // 后端没给地址：空窗留着就是一张白页，必须关掉。
        closeLoginWindow();
        setError('后端未返回登录地址（loginUrl 为空）。');
        setPhase('error');
        return;
      }
      if (loginWindow && !loginWindow.closed) {
        // 手势内开的那个窗口还在：直接把它导航到登录页。
        // 用 location.replace 而不是 href —— 空窗的 about:blank 不留在历史里，
        // 用户点「后退」不会退到一张白页。
        loginWindow.location.replace(loginUrl);
        console.log('[jet-hub] login window navigated to', loginUrl);
      } else {
        // 空窗被激进拦截器挡下了。这里**不再**退化成 location.href：
        // 那会把 DSH 页面整个顶掉（用户丢失当前工作界面，且登录完成后
        // 无法回到设置页）—— 这正是本次要删除的兜底行为。
        // 改为在面板内渲染一个真实链接，由用户自己点击打开。
        setManualLogin({ url: loginUrl });
      }
      /**
       * 轮询的**收尾**动作（幂等）：停表 + 收窗 + 刷新账号列表。
       *
       * 三条终态路径共用它：登录成功、登录失败（宿主回 `done:true` + `error`）、
       * 5 分钟超时。早先只有成功路径收窗 —— 另两条都留下一张孤儿标签页，
       * 用户报障的「登录后多出残留标签页」正是它。
       *
       * `pollSettled` 让重复调用变成 no-op：成功收尾后那个 5 分钟定时器仍在，
       * 不加这道闸就会在 5 分钟后白跑一次 `loadAccounts`。
       */
      let pollSettled = false;
      const finishPolling = async () => {
        if (pollSettled) return;
        pollSettled = true;
        clearInterval(pollTimer);
        closeLoginWindow();
        await loadAccounts();
      };
      // 轮询等待登录完成
      const pollTimer = setInterval(async () => {
        try {
          const pollRes = await rpcCall('login.poll', { accountId, provider });
          if (!pollRes.done) return;
          // **失败终态**：宿主已结算（`done:true`）但带 `error`。
          // 必须与成功一样收窗 + 刷新，否则窗口会停在 127.0.0.1 上，
          // 用户既看不出登录已失败、也无法从面板得知原因。
          if (pollRes.error) {
            console.warn('[jet-hub] login failed:', pollRes.error);
            if (mounted.current) {
              // 复用面板既有的通知行（probeNotice 的渲染块）而不是新造 UI：
              // 面板的 `error` + `phase='error'` 是整页替换，会把刚刷新的
              // 账号列表盖掉；这一行只在列表上方加一条可读原因。
              setProbeNotice({ tone: 'error', text: `登录失败：${pollRes.error}`, details: [] });
            }
          }
          await finishPolling();
        } catch { /* 继续轮询 */ }
      }, 1000);
      // 超时（5 分钟）：轮询期间宿主全程异常时也必须收窗，
      // 只清定时器会留下一张永远挂着的窗口。
      setTimeout(() => { void finishPolling(); }, 300000);
    } catch (caught) {
      console.error('[jet-hub] create account failed:', caught);
      // 所有错误路径都要收掉空窗，否则就是一张永远白屏的孤儿窗。
      closeLoginWindow();
      if (caught?.code === 'login-in-progress') {
        // 宿主侧的 provider 级互斥（lobsterai / codearts）：已有未结算的登录会话。
        // 这不是「失败」，而是一句给用户的状态说明，故直接展示后端 message
        // （它已是可直接展示的中文文案），不加「新建账号失败：」前缀，也不再开窗。
        setError(caught.message || '已有登录进行中');
      } else {
        setError('新建账号失败：' + (caught?.message || '未知错误'));
      }
      setPhase('error');
    } finally {
      setCreating(false);
    }
  };

  const toggleAccount = async (accountId, enabled) => {
    try {
      await rpcCall('account.update', { accountId, patch: { enabled } });
      await loadAccounts();
    } catch (caught) {
      console.error('[jet-hub] toggle failed:', caught);
    }
  };

  const deleteAccount = async (accountId) => {
    if (!confirm('确认删除此账号？关联的凭据也将被清除。')) return;
    try {
      await rpcCall('account.delete', { accountId });
      await loadAccounts();
    } catch (caught) {
      console.error('[jet-hub] delete failed:', caught);
    }
  };

  /**
   * 重测 / 重置的统一入口。
   *
   * kind 决定调用哪个 RPC：
   * - 'retest'    account.retest    对单个账号发真实请求
   * - 'retestAll' account.retestAll 对本页全部账号（含停用）发真实请求
   * - 'reset'     account.reset     单账号直接清除标记
   * - 'resetAll'  account.resetAll  本页全部账号（含停用）直接清除标记
   *
   * 重测会真实消耗模型额度，因此「重测所有」在执行前要求确认。
   */
  const runLimitAction = async (kind, accountId) => {
    if (kind === 'retestAll' && !confirm('将对本页全部账号（含已停用）各发送一条真实消息来验证限流状态，会消耗模型额度。继续？')) {
      return;
    }
    setProbeBusy(kind === 'retestAll' || kind === 'resetAll' ? 'all' : 'one');
    setProbeNotice(null);
    try {
      let res;
      if (kind === 'retest') res = await rpcCall('account.retest', { accountId });
      else if (kind === 'retestAll') res = await rpcCall('account.retestAll', { provider });
      else if (kind === 'reset') res = await rpcCall('account.reset', { accountId });
      else res = await rpcCall('account.resetAll', { provider });

      if (!mounted.current) return;
      // 仍受限的模型要如实列出原因，否则用户只看到"没清除"会以为按钮失灵。
      const details = (res?.accounts || [])
        .flatMap(a => (a.stillLimited || []).map(m => `${a.nickname || a.accountId} · ${m.modelId}：${m.message || '仍受限'}`));
      const summary = summarizeProbe(kind, res);
      setProbeNotice({ tone: details.length > 0 ? 'warn' : 'ok', text: summary, details });
      await loadAccounts();
    } catch (caught) {
      console.error('[jet-hub] limit action failed:', caught);
      if (!mounted.current) return;
      setProbeNotice({ tone: 'error', text: `操作失败：${caught?.message || '未知错误'}`, details: [] });
    } finally {
      if (mounted.current) setProbeBusy(null);
    }
  };

  return React.createElement('section', { 'aria-label': `${provider} 账号管理` },
    // 标题与按钮分开成两块（而不是同一行的 space-between）：操作按钮多达 5 个，
    // 与面板标题挤在一行时既会被压缩又会溢出。标题独占一行、按钮组另起一行
    // 并允许换行，窄面板下也能完整显示。
    React.createElement('div', { className: 'dim-jh-panelHead' },
      React.createElement('h2', { className: 'dim-jh-panelTitle' },
        `${PROVIDERS.find(p => p.id === provider)?.label || provider} 账号管理`),
      React.createElement('div', { className: 'dim-jh-headerActions' },
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: MODEL_LIST_HELP,
          onClick: () => setShowModels(true),
        }, '显示列表'),
        canLoadCredits
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              title: '重新查询本页全部账号的剩余积分（Credits Balance）。余额由服务端实时计算，点此可刷新。',
              disabled: creditsLoading,
              onClick: () => void loadCredits(),
            }, creditsLoading ? '查询中…' : '刷新积分')
          : null,
        supportsCredits
          ? React.createElement('button', {
              className: 'dim-jh-btn',
              title: `领取全部 ${PROVIDERS.find(p => p.id === provider)?.label || provider} 账号（含已停用）的每日签到积分`,
              disabled: claiming || accounts.length === 0,
              onClick: () => void claimCredits(),
            }, claiming ? '领取中…' : '一键领取积分')
          : null,
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: RETEST_ALL_HELP,
          disabled: probeBusy !== null || accounts.length === 0,
          onClick: () => void runLimitAction('retestAll'),
        }, probeBusy === 'all' ? '重测中…' : '重测所有'),
        React.createElement('button', {
          className: 'dim-jh-btn',
          title: RESET_ALL_HELP,
          disabled: probeBusy !== null || accounts.length === 0,
          onClick: () => void runLimitAction('resetAll'),
        }, '重置所有'),
        React.createElement('button', {
          className: 'dim-jh-btn',
          'data-kind': 'primary',
          title: '通过浏览器登录一个新的账号并加入账号池。',
          onClick: () => void createAccount(),
          disabled: creating,
        }, creating ? '正在登录…' : '+ 新建账号'))),
    probeNotice
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': probeNotice.tone,
          role: 'status',
        },
        React.createElement('div', null, probeNotice.text),
        probeNotice.details.length > 0
          ? React.createElement('ul', { className: 'dim-jh-probeDetails' },
              probeNotice.details.map((d, i) => React.createElement('li', { key: i }, d)))
          : null)
      : null,
    claimNotice
      ? React.createElement('div', {
          className: 'dim-jh-probeNotice',
          'data-tone': claimNotice.tone,
          role: claimNotice.tone === 'error' ? 'alert' : 'status',
        }, React.createElement('div', null, claimNotice.text))
      : null,
    // 弹窗被拦截时的兜底入口。刻意**不做成按钮 + window.open(url)**：
    // 那需要在 onClick 里再开窗，而此刻用户手势是新鲜的、本可以成功 —— 但
    // 用手势内空窗的方案已经试过一次并失败了（拦截器策略），再失败一次用户
    // 就彻底没有入口。原生 <a href> 由浏览器自己处理导航，不受脚本开窗策略影响。
    manualLogin
      ? React.createElement('div', { className: 'dim-jh-manualLogin', role: 'status' },
          React.createElement('p', null, '登录窗口被浏览器拦截了。请点击下面的链接在浏览器中完成登录：'),
          React.createElement('a', {
            href: manualLogin.url,
            target: '_blank',
            rel: 'noreferrer noopener',
          }, '打开登录页面'))
      : null,
    phase === 'loading'
      ? React.createElement('div', { className: 'dim-jh-empty' }, '正在读取账号列表…')
      : phase === 'error'
        ? React.createElement('div', { className: 'dim-jh-empty', role: 'alert' },
            React.createElement('p', null, error),
            React.createElement('button', { className: 'dim-jh-btn', onClick: loadAccounts }, '重新读取'))
        : accounts.length === 0
          ? React.createElement('div', { className: 'dim-jh-empty' },
              React.createElement('p', null, '尚未配置账号'),
              React.createElement('p', null, '点击"+ 新建账号"进行浏览器登录。'))
          : React.createElement('div', null,
              accounts.map(account => React.createElement(AccountCard, {
                key: account.id,
                account,
                busy: probeBusy !== null,
                credits: credits[account.id],
                creditsLoading: creditsLoading && credits[account.id] === undefined,
                showCredits: canLoadCredits,
                onToggle: toggleAccount,
                onDelete: deleteAccount,
                onRetest: (id) => void runLimitAction('retest', id),
                onReset: (id) => void runLimitAction('reset', id),
              }))),
    // 模型列表以 modal 渲染：它是覆盖层，放在账号区之后只是组件树的书写顺序，
    // 实际靠 fixed 定位浮在整个面板之上，不再挤占账号池的版面。
    showModels
      ? React.createElement(ModelListPanel, {
          provider,
          rpcCall,
          onClose: () => setShowModels(false),
        })
      : null);
}

export function JetHubPage({ close, rpcCall }) {
  const [selected, setSelected] = React.useState(PROVIDERS[0].id);
  // 每次切换 provider 时递增版号，强制重新挂载 ProviderPanel 触发 loadAccounts
  const [version, setVersion] = React.useState(0);

  const selectProvider = (id) => {
    setSelected(id);
    setVersion(v => v + 1);
  };

  return React.createElement('section', { className: 'dim-jh-page', 'aria-label': 'Account Hub 账号管理' },
    React.createElement('header', { className: 'dim-jh-header' },
      React.createElement('div', { className: 'dim-jh-brand' },
        React.createElement('strong', { className: 'dim-jh-brandName' }, 'Account Hub'),
        React.createElement('p', { className: 'dim-jh-brandDesc' }, 'Provider 凭据管理与多账号支持')),
      close ? React.createElement('button', {
        className: 'dim-jh-btn',
        onClick: close,
      }, '关闭') : null),
    React.createElement('div', { className: 'dim-jh-layout' },
      React.createElement('nav', { className: 'dim-jh-rail', role: 'tablist', 'aria-label': 'Provider 导航' },
        PROVIDERS.map(p => React.createElement('button', {
          key: p.id,
          type: 'button',
          role: 'tab',
          className: 'dim-jh-provider',
          'aria-selected': p.id === selected,
          onClick: () => selectProvider(p.id),
        },
        React.createElement(ProviderLogo, { provider: p.id }),
        React.createElement('span', null,
          React.createElement('strong', null, p.label))))),
      React.createElement('main', {
        className: 'dim-jh-panel',
        role: 'tabpanel',
      },
      PROVIDERS.map(p => p.id === selected
        ? React.createElement(ProviderPanel, {
            key: p.id + '-' + version,
            provider: p.id,
            rpcCall,
          })
        : null))));
}
