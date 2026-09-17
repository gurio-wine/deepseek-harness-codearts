/**
 * Trae CN（字节跳动 Trae 国内版）产品配置。
 *
 * ## 为什么不复用 `BuddyProduct` / `LobsteraiProduct`
 *
 * 三者是**三条互不相干的协议线**：CodeBuddy 系走腾讯的 external-link 轮询登录 +
 * `X-Product-Code` 归属头；LobsterAI 走本地回调 + `authCode` 换 token + keyfrom
 * 身份载荷；Trae CN 走**回调 query 直接携带 refreshToken**（无 authCode 交换）+
 * `ExchangeToken` 续期 + `Cloud-IDE-JWT` 鉴权。三个类型的字段集合几乎不相交
 * （`productCode` / `apiDomain` / `userAgentByModelFamily` 对 Trae CN 全部无意义；
 * `clientSecret` / `machineId` 语义对前两者无意义），合并只会让调用方拿到联合类型
 * 后再也不得不做类型收窄。
 *
 * 因此这里定义**平行**的 `TraeCnProduct`：共用的是架构**模式**
 * （产品配置驱动、账号池、限流切换、模型黑名单），不是那个类型。
 *
 * ## 编译期常量约束（对齐 LobsterAI）
 *
 * `apiBase` / `portalBase` / `clientId` 全部是**编译期常量，不从凭据推断**。
 * 凭据里的字段是登录时的快照，跨环境迁移后会留下旧值；跟着凭据走会让请求的
 * baseURL 与身份标识自相矛盾（本插件在 `X-Domain` 上踩过同类坑，见 AGENTS.md）。
 *
 * ## 数据来源
 *
 * - 端点与请求体：调研报告实测确认（`POST /cloudide/api/v3/trae/oauth/ExchangeToken`，
 *   body `{ClientID, ClientSecret, RefreshToken, UserID}`）；
 * - `clientId` / `clientSecret`：Trae CN 桌面客户端内置的公开 OAuth 客户端标识
 *   （`clientSecret` 实测为占位串 `"-"`，服务端不校验它）；
 * - 登录 URL 形态：`traework2api/login.sh` 的做法 —— 起 loopback 服务器，
 *   登录页自行完成 `GetRefreshToken`，回调 URL 的 query 里带最终 refreshToken。
 *
 * ⚠️ **回调 URL 的确切形态待实测校准**（调研报告 T5）：当前实现把
 * 「回调 query 携带 refreshToken」作为**主路径**，并对回调 URL 打日志（脱敏）
 * 以便真实验证时校准。详见 `src/trae-cn-oauth.ts` 的 `TRAE_CN_CALLBACK_PATH`。
 */

/**
 * Trae CN 上游 API 基址（**编译期常量**）。
 *
 * 与 portal 分开成两个字段：登录页在 `www.trae.cn`，OpenAPI 在 `api.trae.cn`，
 * 两者是不同域名（实测确认），不排除未来进一步分离部署。
 */
export const TRAE_CN_API_BASE = 'https://api.trae.cn'

/** Trae CN 登录门户基址（**编译期常量**）。 */
export const TRAE_CN_PORTAL_BASE = 'https://www.trae.cn'

/**
 * OAuth 客户端 ID。
 *
 * 取自 Trae CN 桌面客户端的内置值（公开标识，非机密）。它同时是：
 * - 登录 URL 的 `clientID` query 参数；
 * - `ExchangeToken` 请求体的 `ClientID` 字段（**大小写不同，刻意保留各自形态**：
 *   登录 URL 用 `clientID`，请求体用 `ClientID`）。
 */
export const TRAE_CN_CLIENT_ID = 'ono9krqynydwx5'

/**
 * OAuth 客户端密钥。
 *
 * 实测值为占位串 `"-"`：服务端**不校验**该字段（调研报告已确认）。
 * 照抄原值而非留空 —— 空串可能被服务端当成「缺字段」而拒绝，
 * 而 `"-"` 是客户端实际发送的值。
 */
export const TRAE_CN_CLIENT_SECRET = '-'

/**
 * `ExchangeToken` 端点路径（续期）。
 *
 * 全路径 `https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`。
 * 这是 REFRESH_CONTRACT.cn 的实测形态：用 `RefreshToken` + `UserID` 换新
 * access token（JWT）。
 */
export const TRAE_CN_EXCHANGE_TOKEN_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'

/**
 * 登录回调路径。
 *
 * 登录 URL 的 `auth_callback_url` 为 `http://127.0.0.1:{port}/authorize`，
 * 故本地 loopback 服务器只接受这个路径的回调。
 *
 * ⚠️ **待 T5 校准**：调研报告指出回调 URL 的**确切形态未经实测**。当前实现
 * 假设「回调 query 携带 `refreshToken`」（这是 `traework2api/login.sh` 的行为：
 * 它解析回调 URL query 里的 refreshToken，再直接 ExchangeToken，说明登录页
 * 自己完成了 `GetRefreshToken`）。校准前，本模块的回调处理器会对**每条**回调
 * 记录脱敏后的原始 URL，便于真实登录时按日志修正参数名。
 */
export const TRAE_CN_CALLBACK_PATH = '/authorize'

/** 登录页授权端点路径（拼在 `portalBase` 之后）。 */
export const TRAE_CN_AUTHORIZATION_PATH = '/authorization'

/** 控制面请求超时（毫秒）；流式对话请求不适用。 */
export const TRAE_CN_REQUEST_TIMEOUT_MS = 30_000

/** 登录流程总超时（毫秒）；与 LobsterAI / CodeArts 的 10 分钟窗口一致。 */
export const TRAE_CN_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 凭据对象里持久化的设备号来源标记（诊断用，不影响鉴权）。
 *
 * `deviceId` 的理论来源是 Aha 设备号（签到请求的 `x-device-id` 就是它）。
 * 拿不到时回退用 `machineId` 的十进制形态，并在凭据里标记来源，
 * 让「真实来源待校准」这件事在数据里可见，而不是悄悄用一个假设备号。
 */
export type TraeCnDeviceIdSource = 'aha' | 'machine-id-fallback'

/**
 * Trae CN 产品配置。
 *
 * 与 `BuddyProduct` / `LobsteraiProduct` 平行，字段全部为 Trae CN 实际需要的。
 */
export interface TraeCnProduct {
  /**
   * provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。
   *
   * **带连字符**：对齐用户与生态的叫法（`dsh-connect-trae` 等插件同样用
   * `trae-cn`）。注意它同时被 `jet-hub-rpc` 用来拼凭据 ref 前缀
   * （`${provider.toUpperCase()}_ACCOUNT_XXX` → `TRAE_CN_ACCOUNT_XXX`），
   * 这是**合法**的（连字符经 toUpperCase 后由 `_` 承接，
   * 见 `src/trae-cn-oauth.ts` 的 `traeCnAccountRefPrefix`）。
   *
   * 但它**不能**直接用来派生 cordis 服务名（`trae-cnAuth` 不是合法的 JS
   * 标识符风格），故服务名由 {@link TraeCnProduct.serviceName} **显式指定**。
   * 详见 `src/trae-cn-auth.ts` 的 `TraeCnAuthOptions.serviceName`。
   */
  id: 'trae-cn'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * cordis 服务名（`ctx.<serviceName>`）。
   *
   * **刻意不用 `${product.id}Auth` 机械派生**：产品 id 为 `trae-cn`，
   * 机械派生会得到 `trae-cnAuth` —— 带连字符的属性名虽在 JS 里合法，
   * 但与 `buddyAuth` / `workbuddyAuth` / `lobsteraiAuth` / `codeartsAuth`
   * 四个既有两个单词驼峰名风格不一致，且无法用点号语法访问
   * （必须写 `ctx['trae-cnAuth']`）。这里显式声明 `traeCnAuth`，
   * 让「用户可见的 provider 名」与「代码里的服务标识符」各自取合适的形态。
   */
  serviceName: string
  /** 登录门户基址（不含授权路径）。 */
  portalBase: string
  /** 上游 API 基址（不含路径）。 */
  apiBase: string
  /** OAuth 客户端 ID。 */
  clientId: string
  /** OAuth 客户端密钥（实测为占位串 `"-"`）。 */
  clientSecret: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 账号池凭据 ref 前缀（`{前缀}_{SUFFIX}`）。 */
  accountCredentialRefPrefix: string
}

/**
 * Trae CN provider 配置。
 *
 * 登录方式与腾讯系、LobsterAI 都不同：**两段式 loopback 回调**，
 * 回调 URL 的 query 直接携带 refreshToken（无 authCode 交换步骤）。
 */
export const TRAE_CN: TraeCnProduct = {
  id: 'trae-cn',
  displayName: 'Trae CN (字节跳动)',
  serviceName: 'traeCnAuth',
  portalBase: TRAE_CN_PORTAL_BASE,
  apiBase: TRAE_CN_API_BASE,
  clientId: TRAE_CN_CLIENT_ID,
  clientSecret: TRAE_CN_CLIENT_SECRET,
  defaultCredentialRef: 'TRAE_CN_ACCESS_TOKEN',
  accountCredentialRefPrefix: 'TRAE_CN_ACCOUNT',
}

/** 全部 Trae CN 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_TRAE_CN_PRODUCTS: readonly TraeCnProduct[] = [TRAE_CN]

/**
 * 按 provider id 取 Trae CN 产品配置；未知 id 返回 undefined。
 *
 * 与 `productById`（CodeBuddy 系）、`lobsteraiProductById` 分开：三者返回
 * **不同类型**，合并成一个函数会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function traeCnProductById(id: string): TraeCnProduct | undefined {
  return ALL_TRAE_CN_PRODUCTS.find((product) => product.id === id)
}
