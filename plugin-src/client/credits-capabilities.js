/**
 * 各 provider 的积分能力矩阵 —— Account Hub 面板判断「要不要碰积分」的唯一真相源。
 *
 * 为什么必须单独成表、且必须在**发起请求之前**判断：
 *
 * Host 侧两个积分端点（`credits.balances` / `credits.claimAll`）都以
 * `productById(provider)` 解析产品配置（见 `src/jet-hub-rpc.ts`），而
 * **CodeArts 不属于 CodeBuddy 系产品**，解析结果为 `undefined`，端点必定回
 * `bad-request: unsupported provider: codearts`。客户端早期在面板挂载时对所有
 * provider 无条件调用 `credits.balances`，于是每打开一次 CodeArts 面板都会：
 *   1. 在控制台留下一条必然失败的报错（`[jet-hub] load credits failed`）；
 *   2. 把该页面每个账号卡片的「积分」渲染成「查询失败」。
 * 这不是偶发故障，而是「请求了后端明确不支持的能力」这一设计缺陷的必然结果。
 * 修法不是在 UI 上吞掉错误，而是**不发起这个请求**。
 *
 * 之所以用一张表而不是散落的 `provider === 'buddy' || provider === 'workbuddy'`
 * 判断：能力集合将来会随产品变化（新增 provider、某产品开放/下线接口），集中
 * 一处才可能与 `src/product.ts` 对齐，并由单测守住不漂移。
 *
 * 两个能力**彼此独立，不能互相推断**：
 *
 * | provider    | balance（积分余额） | dailyCheckin（每日签到领取） |
 * |-------------|---------------------|------------------------------|
 * | `codearts`  | ✗ 华为云账号体系     | ✗                            |
 * | `buddy`     | ✓                   | ✓                            |
 * | `workbuddy` | ✓                   | ✗ 国际版后端无签到接口        |
 * | `lobsterai` | ✓                   | ✓ `client-activities` 三步流程 |
 * | `trae-cn`   | ✓ 双池（通用 / Work） | ✓ `checkin_credits` 两步 + 设备头 |
 *
 * - `balance`：CodeBuddy 系走 `POST /v2/billing/meter/get-user-resource`，该端点
 *   在 CodeBuddy 与 WorkBuddy 国际版**通用**（仅 baseURL 随 `product.endpoint`
 *   切换）；LobsterAI 走 `GET /api/user/profile-summary`；Trae CN 走
 *   `POST /trae/api/v2/pay/web_user_ent_usage`，并按 `available_endpoint`
 *   **分池**（通用池是主数字、Work 池单独一项，见下）。见 README「积分余额」。
 * - `dailyCheckin`：CodeBuddy 系是 `checkin-activity-status` + `daily-checkin`，
 *   **仅 CodeBuddy 中国版**有；WorkBuddy 国际版内核里只有 `get-dosage-notify`
 *   （用量通知），没有签到接口，故其面板不渲染「一键领取积分」。LobsterAI 是
 *   `client-activities` 三步流程（`src/lobsterai-credits.ts`）；Trae CN 是
 *   `checkin_credits/status` → `claim` 两步（`src/trae-cn-credits.ts`，claim 必须
 *   带设备四件套），故两者都支持。
 *
 * `trae-cn` 的 `balance` 是**双池**：`total` 仍是通用池（chat 实际扣的就是它），
 * Work 池走超集字段 `workTotal`，两者在 UI 上**分开展示、绝不合并**
 * （`CreditBalanceRow` 见到 `workTotal` 才切双池形态；其余 provider 的余额对象
 * 没有该字段，渲染与登记前逐字节一致）。
 *
 * 判定一律**默认关闭**：未登记的 provider 视为不支持任何积分能力。这样将来
 * 新增 provider 时，若忘记在此登记，最坏结果是「暂时看不到积分」，而不是
 * 「每次打开面板都发一个必然失败的请求」。
 */

/** 单个 provider 的积分能力。 */
export const CREDITS_CAPABILITIES = Object.freeze({
  codearts: Object.freeze({ balance: false, dailyCheckin: false }),
  buddy: Object.freeze({ balance: true, dailyCheckin: true }),
  workbuddy: Object.freeze({ balance: true, dailyCheckin: false }),
  // LobsterAI：余额走 profile-summary，签到走 client-activities 三步流程，两项都支持。
  lobsterai: Object.freeze({ balance: true, dailyCheckin: true }),
  // Trae CN：余额走 web_user_ent_usage（双池：通用 / Work），签到走
  // checkin_credits 两步流程（claim 带设备四件套），两项都支持。
  // 键名是 `trae-cn`（带连字符，与 `PROVIDERS` 的 id 及后端 provider 实参一致）。
  'trae-cn': Object.freeze({ balance: true, dailyCheckin: true }),
});

/**
 * 该 provider 是否能查询积分余额。
 *
 * 为 false 时调用方**不得**发起 `credits.balances`，也不应渲染账号卡片的
 * 「积分」行与面板的「刷新积分」按钮 —— 否则卡片会永远停在「查询失败」。
 */
export function supportsCreditBalance(provider) {
  return CREDITS_CAPABILITIES[provider]?.balance === true;
}

/**
 * 该 provider 是否能执行每日签到领取（一键领取积分）。
 *
 * 为 false 时面板不渲染该按钮（CodeArts 无此能力；WorkBuddy 国际版后端无接口）。
 */
export function supportsDailyCheckin(provider) {
  return CREDITS_CAPABILITIES[provider]?.dailyCheckin === true;
}
