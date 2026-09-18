/**
 * Trae CN（字节跳动 Trae 国内版）产品配置。
 *
 * ## 为什么不复用 `BuddyProduct` / `LobsteraiProduct`
 *
 * 三者是**三条互不相干的协议线**：Buddy 系走腾讯的 external-link 轮询登录 +
 * `X-Product-Code` 归属头；LobsterAI 走本地回调 + `authCode` 换 token + keyfrom
 * 身份载荷；Trae CN 走**本地回调 + PKCE（S256）+ authCode 换 token** +
 * `Cloud-IDE-JWT` 鉴权。三个类型的字段集合几乎不相交
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
 * **登录协议已用真机校准（2026-09-17）**，三条独立证据一致：
 *
 * 1. 官方 `main.js` 源码只读提取（`loginUrlBuilder.buildLoginUrl` @1640193、
 *    `gDe()` @1426128、`exchangeTokenByAuthCode` @1430351、
 *    `_buildDeviceInfo` @1430476）；
 * 2. 本机真实**成功**登录日志
 *    `%APPDATA%\Trae CN\logs\20260917T045023\main.log:136/139/140/141`
 *    （登录 URL / 回调载荷 / exchange 请求体 / exchange 响应体，四段逐字）；
 * 3. 授权页 chunk 的行为解剖（两条流程分支、`get("client_id")` 只读 snake_case）。
 *
 * 此前「回调 query 直接携带 refreshToken、无 authCode 交换」的假设**已被整体
 * 证伪**：真机走的是 PKCE(S256) → `authCodeInfo.AuthCode` → `trae/api/v3/oauth/ExchangeToken`。
 * 「直取 refreshToken」是**同一授权页在另一个参数组合下的分支**（不带
 * `code_challenge` 时页面自己调 `GetRefreshToken`，依赖浏览器里的 trae.cn
 * Cookie 会话），本实现**保留它作为兼容分支**并记录日志，但**主路径是 PKCE**。
 * 依据见 `src/trae-cn-oauth.ts` 的模块头注释。
 *
 * ## 仍未校准的部分
 *
 * 签到设备的来源已确认（`BoundDeviceID`），但**签到该用哪个号**仍未定论 ——
 * 见 {@link TraeCnDeviceIdSource}。
 */

/**
 * Trae CN 上游 API 基址（**编译期常量**）。
 *
 * 与 portal 分开成两个字段：登录页在 `www.trae.cn`，OpenAPI 在 `api.trae.cn`，
 * 两者是不同域名（实测确认），不排除未来进一步分离部署。
 *
 * ⚠️ 真机回调载荷里的 `host` 字段是 `https://api.trae.com.cn`（**`.com.cn`**），
 * 而 exchange 请求实际打到 `https://api.trae.cn`（**`.cn`**）—— 两个域名并存。
 * 本常量取**实际请求**的那个，绝不从回调载荷的 `host` 推断 baseURL
 * （与本插件「baseURL 是编译期常量」那条约定同因；回调载荷是服务端可变的
 * 声明，不是我们的配置）。
 */
export const TRAE_CN_API_BASE = 'https://api.trae.cn'

/**
 * Trae CN **IDE 网关**基址（`/api/ide/*` 专用，**编译期常量**）。
 *
 * ## 为什么必须与 {@link TRAE_CN_API_BASE} 分开（T6 真机校准，2026-09-18）
 *
 * `/api/ide/*` **不在** `api.trae.cn` 上：实测该 host 上的
 * `/api/ide/v1/ping` 回 **404**，而在本 host 上回 **200**。
 * 官方 product.json 的 `bootConfig.agent.trae.normal` 指定的就是本 host。
 * 对话（`/api/ide/v1/chat`）因此必须打到本网关 —— 原实现把它拼在
 * `api.trae.cn` 后面，是 T6 的真实错误（**路径本来就对，错的是 host**）。
 *
 * 签到 / 续期 / 余额**仍然走 `api.trae.cn`**：那三条协议线不在 IDE 网关下，
 * 换过来会 404。两个 base 不可互相替换。
 */
export const TRAE_CN_IDE_API_BASE = 'https://trae-api-cn.mchost.guru'

/**
 * IDE 网关请求头：应用 ID（`x-app-id`）。
 *
 * 实测该网关按这几个头做客户端形态校验：**缺了直接 500 / 401，带上才是 200**
 * （所以它们不是「可选的遥测字段」，而是请求能否成立的一部分）。
 * 取自官方 product.json（公开标识，非机密）。
 */
export const TRAE_CN_IDE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/**
 * IDE 网关请求头：客户端版本号（`x-ide-version-code` 与 `x-app-version-code`）。
 *
 * ⚠️ **必须是纯数字**：真机实测发 `"3.3.100"` 会被网关 **400** 拒掉，
 * 发 `"107"` 才是 200。注意它与 {@link TRAE_CN_IDE_VERSION}（`3.3.100`，
 * 登录 URL 的 `x_app_version`）**不是一个号**，也不可互换 ——
 * 一个进 URL/请求体，一个进网关头，形态要求还不同。
 */
export const TRAE_CN_IDE_VERSION_CODE = '107'

/**
 * IDE 网关请求头：IDE 版本（`x-ide-version`，形如 `1.107.1`）。
 *
 * 与 {@link TRAE_CN_IDE_VERSION}（`3.3.100`）同名不同物，故本常量**刻意不叫**
 * `TRAE_CN_IDE_VERSION` —— 那个名字已被登录协议的 IDE 版本占用（真机 main.log
 * 逐字），改它会牵动登录 URL / `DeviceInfo.ClientVersion` / exchange body 三处。
 */
export const TRAE_CN_IDE_GATEWAY_VERSION = '1.107.1'

/** IDE 网关请求头：版本通道（`x-ide-version-type`，真机 `stable`）。 */
export const TRAE_CN_IDE_VERSION_TYPE = 'stable'

/** IDE 网关请求头：流量类型（`request-traffic-type`，真机 `normal`）。 */
export const TRAE_CN_REQUEST_TRAFFIC_TYPE = 'normal'

/**
 * IDE 网关请求头：`User-Agent`。
 *
 * 真机值为 `TraeClient/TTNet`（官方客户端自己的 UA），**不是**浏览器 UA。
 * 网关按 UA 归因客户端形态，故照抄实测值而不是留空。
 */
export const TRAE_CN_GATEWAY_USER_AGENT = 'TraeClient/TTNet'

/** Trae CN 登录门户基址（**编译期常量**）。 */
export const TRAE_CN_PORTAL_BASE = 'https://www.trae.cn'

/**
 * OAuth 客户端 ID。
 *
 * 取自 Trae CN 桌面客户端的内置值（公开标识，非机密）。它同时是：
 * - 登录 URL 的 **`client_id`** query 参数（**snake_case**）；
 * - 两个 `ExchangeToken` 端点的请求体字段 **`ClientID`**（**PascalCase**）。
 *
 * ## ⚠️ 两侧拼写方向相反，写错就是「认证中」卡死（真机根因，2026-09-17）
 *
 * | 位置 | 形态 | 举证 |
 * |---|---|---|
 * | 登录 URL query | `client_id`（snake_case） | 真机 main.log:136 逐字 |
 * | 授权页读取 | `get("client_id")` —— 读不到 `clientID` | 授权页源码 |
 * | JSON body | `ClientID`（PascalCase） | main.log:140 逐字 |
 *
 * 本文件曾把这条注释写反（「URL 用 `clientID`」），而它正是那次登录失败的
 * **思想源头**：授权页拿不到 `client_id` 后既不报错也不回调，页面停在
 * 「认证中」，从外部看完全像网络问题。故这里显式写死两个方向防回归 ——
 * `tests/unit/trae-cn-oauth.spec.ts` 另有逐项断言锁住两侧拼写。
 */
export const TRAE_CN_CLIENT_ID = 'ono9krqynydwx5'

/**
 * OAuth 客户端密钥。
 *
 * 实测值为占位串 `"-"`：服务端**不校验**该字段。仅用于**续期**端点
 * （`cloudide/api/v3/trae/oauth/ExchangeToken`，body 含 `ClientSecret`）；
 * 登录的 authCode 交换端点 body **不含**该字段。
 * 照抄原值而非留空 —— 空串可能被服务端当成「缺字段」而拒绝，
 * 而 `"-"` 是客户端实际发送的值。
 */
export const TRAE_CN_CLIENT_SECRET = '-'

/**
 * `ExchangeToken` 端点路径 —— **续期**（`RefreshToken` + `UserID`）。
 *
 * 全路径 `https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`。
 * 这是 REFRESH_CONTRACT.cn 的实测形态：用 `RefreshToken` + `UserID` 换新
 * access token（JWT）。
 *
 * ⚠️ **与登录时的 authCode 交换不是同一个端点**（路径首段不同：本端点
 * `cloudide/api/…`，登录端点 `trae/api/…`）。两者在服务端**并存**，
 * 见 {@link TRAE_CN_AUTH_EXCHANGE_PATH}。混用会让登录/续期之一 404。
 */
export const TRAE_CN_EXCHANGE_TOKEN_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'

/**
 * `ExchangeToken` 端点路径 —— **登录后的 AuthCode 交换**（PKCE 流程第二步）。
 *
 * 全路径 `https://api.trae.cn/trae/api/v3/oauth/ExchangeToken`，真机实测
 * （main.log:140 的 `[exchangeTokenByAuthCode] request`）逐字确认。
 *
 * body 五字段：`{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}` ——
 * **没有** `ClientSecret`、**没有** `DeviceProof`（那两者属于 `cloudide/api/…`
 * 那条续期路径）。
 */
export const TRAE_CN_AUTH_EXCHANGE_PATH = '/trae/api/v3/oauth/ExchangeToken'

/**
 * 登录回调路径。
 *
 * 登录 URL 的 `auth_callback_url` 为 `http://127.0.0.1:{port}/authorize`，
 * 故本地 loopback 服务器只接受这个路径的回调。
 *
 * ✅ **已用真机日志校准（T5，2026-09-17 main.log:136）**：回调路径与
 * `auth_callback_url` 形态均与实测一致，不再是假设。
 */
export const TRAE_CN_CALLBACK_PATH = '/authorize'

/**
 * 登录 URL 上的客户端流程常量（**全部取自真机** main.log:136 逐字）。
 *
 * ## 为什么这四个字面量值得做成常量
 *
 * 它们的共同点是「服务端/授权页按存在性判流程分支，缺失时的表现是**静默**的」：
 * 页面既不报错也不回调，只在首屏显示「认证中」。少任何一个都无法从错误信息
 * 反推原因 —— 这就是本 provider 首次真机登录失败的机型（见 {@link TRAE_CN_CLIENT_ID}）。
 *
 * - {@link TRAE_CN_LOGIN_VERSION}：登录协议版本（授权页据此选解析分支）；
 * - {@link TRAE_CN_LOGIN_AUTH_FROM}：来源标识，真机 `trae`（SOLO 形态为 `solo`，
 *   本 provider 只走 `trae`）；
 * - {@link TRAE_CN_LOGIN_CHANNEL}：`native_ide` —— 声明「本地 IDE 回调」这一
 *   登录通道，授权页据此决定**是否**调 `GetRefreshToken` 与投递何种载荷；
 * - {@link TRAE_CN_LOGIN_AUTH_TYPE}：`local` —— **缺它是失败的直接原因**：
 *   授权页认不出本地回调模式便一直停在「认证中」。
 */
export const TRAE_CN_LOGIN_VERSION = '1'
/** 登录 URL 的 `auth_from`（真机 `trae`；SOLO 形态的 `solo` 不适用本 provider）。 */
export const TRAE_CN_LOGIN_AUTH_FROM = 'trae'
/** 登录 URL 的 `login_channel`（真机 `native_ide`）。 */
export const TRAE_CN_LOGIN_CHANNEL = 'native_ide'
/** 登录 URL 的 `auth_type`（真机 `local`；缺失时授权页停在「认证中」）。 */
export const TRAE_CN_LOGIN_AUTH_TYPE = 'local'
/**
 * 插件版本（登录 URL 的 `plugin_version`）。
 *
 * 取自本机客户端 `main.js` 尾部 sourcemap 注释
 * （`/stable/2.3.83560/win32/x64/main.js.map`）与真机 main.log:136，
 * 两处一致。官方实现取的是 `productService.tronBuildVersion` ——
 * 即**客户端插件版本**，与 {@link TRAE_CN_IDE_VERSION} 是两个不同的号。
 */
export const TRAE_CN_PLUGIN_VERSION = '2.3.83560'
/**
 * IDE 版本（登录 URL 的 `x_app_version`，也是 `DeviceInfo.ClientVersion`
 * 与 exchange body 的 `IDEVersion`）。
 *
 * 真机值与签到设备头的 `x-app-version` 相同（均为 `3.3.100`），
 * 故本常量与 `TRAE_CN_APP_VERSION` 同值；**刻意分成两个常量**，
 * 因为它们是两条独立的协议线（登录 URL / 签到头），任一变动不应牵动另一个。
 */
export const TRAE_CN_IDE_VERSION = '3.3.100'
/** 登录 URL 的 `x_app_type`（真机 `stable`）。 */
export const TRAE_CN_APP_TYPE = 'stable'
/**
 * 登录 URL 的 `channel_name`（真机 `common`）。
 *
 * 官方实现在 `productService.channelName` 存在时才追加；本 provider 恒发 `common`
 * （真机实测值），不做条件分支 —— 少一个参数就多一种静默失败形态。
 */
export const TRAE_CN_CHANNEL_NAME = 'common'
/**
 * `redirect` 参数值（真机 `0`）。
 *
 * 官方实现是 `redirect || 0`，即「未指定时填 0」。本 provider 无重定向需求，
 * 恒为 `0`。
 */
export const TRAE_CN_LOGIN_REDIRECT = '0'
/**
 * 登录**成功回调**回跳时用的 `redirect` 值（官方 `1`）。
 *
 * ## 来源（本机官方客户端逐字提取，非发明）
 *
 * `%LOCALAPPDATA%\Programs\Trae CN\resources\app\out\main.js` 的
 * `updateLocalCredential` 函数里，成功分支调用
 * `s()`（无参）→ `getLoginUrl(t, await this.server.getPort(), 1, …)` →
 * `buildLoginUrl` 里 `redirect=${r||0}`；随后 `i.writeHead(307,{Location:a}),i.end()`
 * —— 即**用同一条授权页 URL 构造器、把 `redirect` 换成 `1`**，再 307 回跳。
 *
 * 失败分支走 `s(errorCode, errorMsg)`，同样 307（本插件失败路径维持 500，
 * 见 `trae-cn-oauth.ts` 回调处理器的说明）。
 *
 * ## 为什么必须有这一跳
 *
 * 回调页停在 `127.0.0.1:{port}`，自身无法离开（静态 HTML 没有 `window.close()`）。
 * 弹窗被拦截、用户走面板内 `<a target="_blank">` 手动链接时，客户端**没有窗口
 * 引用**，`closeLoginWindow()` 够不到那张标签页 —— 307 回跳是唯一能让它离开
 * loopback 的机制（官方同款）。授权页收到 `redirect=1` 后渲染「登录成功」结果页。
 */
export const TRAE_CN_LOGIN_REDIRECT_CALLBACK = '1'
/**
 * `DeviceInfo.PlatformCode` —— 真机 `IDE_PC`（官方实现按 SOLO/IDE 二分，
 * 本 provider 恒为 IDE 形态）。
 */
export const TRAE_CN_PLATFORM_CODE = 'IDE_PC'
/**
 * `DeviceInfo.DeviceType` —— 真机字面量 `PC`。
 */
export const TRAE_CN_DEVICE_TYPE_PC = 'PC'
/**
 * 登录 URL 的 `x_device_type` / `DeviceInfo.OSInfo` —— 真机值 `windows`。
 *
 * 与 `TRAE_CN_DEVICE_TYPE`（签到头的 `x-device-type`）同值但**刻意分开**：
 * 两条协议线的取值来源不同，任一侧调整都不该牵动另一侧。
 */
export const TRAE_CN_LOGIN_OS_INFO = 'windows'
/**
 * 登录 URL 的 `x_os_version` / `DeviceInfo.OSVersion` —— 真机逐字值
 * `Windows 10 Home`（该机器上 `getSystemInformation().osVersion` 的输出）。
 *
 * ⚠️ 这是**真机取值**而非发明：官方实现取系统信息，本插件无法等价获取，
 * 故采「客户端形态伪装」常量（与签到头的 `TRAE_CN_OS_VERSION` 同一约定）。
 * 注意两者形态不同：这里是**市场营销名**（`Windows 10 Home`），
 * 签到头用的是**构建号**（`Windows 10.0.22631`）—— 别互相替换。
 */
export const TRAE_CN_LOGIN_OS_VERSION = 'Windows 10 Home'

/** 登录页授权端点路径（拼在 `portalBase` 之后）。 */
export const TRAE_CN_AUTHORIZATION_PATH = '/authorization'

/**
 * chat（流式对话）端点**路径**（拼在 {@link TRAE_CN_IDE_API_BASE} 之后）。
 *
 * ## ✅ T6 已真机校准（2026-09-18）：路径本来就对，错的是 host
 *
 * 本值取自本机客户端的只读提取（`resources/app/modules/ai-agent/ai_agent.dll`
 * 的字符串池），真机实测**确认它就是正确路径** —— 上游返回的是正常 SSE
 * （`event:output` 逐字），业务错误也在 HTTP 200 的 `event:error` 帧里
 * （实测 `code:4001`），与 `src/trae-cn-errors.ts` 的设计假设一致。
 *
 * 曾经的错误不在路径上：它被拼在 `api.trae.cn` 后面，而 `/api/ide/*` 在
 * 那个 host 上 **404**（真正的网关是 {@link TRAE_CN_IDE_API_BASE}）。
 * 即「T6 的症状（404）与病因（host）不同」—— 若当初照候选表逐个试路径，
 * 四条全都会 404，反而会把正确的路径排除掉。
 *
 * 候选表（{@link TRAE_CN_CHAT_PATH_CANDIDATES}）因此**已失去运行时意义**，
 * 保留仅为诊断留痕（见该常量的说明）。
 */
export const TRAE_CN_CHAT_PATH = '/api/ide/v1/chat'

/**
 * 候选端点表（仅用于诊断与历史留痕，**运行时不使用**）。
 *
 * 真机校准（2026-09-18）已确认主选 `/api/ide/v1/chat` 正确，其余三个候选
 * 不再有排查价值。保留数组是为了让「曾经为什么这么猜」在代码里可查 ——
 * 删除它会让后来者重新经历一次「路径 vs host」的误判。
 */
export const TRAE_CN_CHAT_PATH_CANDIDATES: readonly string[] = [
  '/api/ide/v1/chat',
  '/api/ide/v1/llm_raw_chat',
  '/api/ide/v2/llm_raw_chat',
  '/api/ide/v1/chat_prompt',
]

/**
 * 模型目录端点路径（**刻意不接线**）。
 *
 * ## 为什么本插件不接远端模型目录（2026-09-18 三端点实测结论）
 *
 * 结论：**新模型池在任何 HTTP 端点上都拿不到**，静态表才是正解。三条证据：
 *
 * | 端点 | 实测结果 |
 * |---|---|
 * | `model_list`（`{"type":"chat"}` + 完整网关头） | 只回 **6 项旧池**（Doubao-1.5 代） |
 * | `batch_get_detail_param` | 只回 **4 个 seed 配置** |
 * | 其余 ~200 种形状组合 | 18 项新池**一个都不出现** |
 *
 * 官方客户端之所以能看到新池，靠的是 `harness.dll` **内嵌的静态映射** +
 * 本地缓存（vscdb），不是某个可调用的 HTTP 接口。
 *
 * 故 {@link TRAE_CN_FALLBACK_MODELS} 不是「兜底」，而是**唯一正确的目录**；
 * 适配器的 `fetchRemoteModels` 保持未接线（接口保留，注入方留空）。
 * 若将来上游真给出目录端点，改这里与 README 的「模型目录」小节即可。
 *
 * ⚠️ **待办**：`parseTraeCnModels` 解析器随之**无调用方**（远端不接就没有响应可解）。
 * 刻意保留而不删：真接线时它仍是入口，且它的候选表是从客户端响应形态推出来的。
 * 现状在 README 的「模型目录」小节有登记。
 */
export const TRAE_CN_MODELS_PATH = '/api/ide/v1/get_detail_param'

/** 控制面请求超时（毫秒）；流式对话请求不适用。 */
export const TRAE_CN_REQUEST_TIMEOUT_MS = 30_000

/** 登录流程总超时（毫秒）；与 LobsterAI / CodeArts 的 10 分钟窗口一致。 */
export const TRAE_CN_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 凭据对象里持久化的设备号来源标记（诊断用，不影响鉴权）。
 *
 * ## 值域已按真机证据收敛（2026-09-17）
 *
 * `device_id` 的来源**已经查清**：它是登录 exchange 响应的
 * `Result.BoundDeviceID`（真机 `wl2k1e2endpp32`，14 位小写字母+数字）。
 * 这**不是**客户端上报的 `DeviceID`（16 位十进制）或 `MachineID`（64 hex）
 * 的回显 —— 服务端新发了一个绑定标识，`DeviceBindStatus: "BOUND"` 与之配套。
 *
 * 故旧的 `machine-id-fallback` 降级路径已**删除**：登录 URL 里的 `device_id`
 * 是我们随机生成的临时值（仅参与登录握手与风控形态校验），把它折算成设备号
 * 存进凭据是**伪造设备身份**，比缺字段更坏 —— 缺字段至少能被发现。
 *
 * @see TraeCnDeviceIdSource
 */
export type TraeCnDeviceIdSource = 'exchange-bound-device-id'

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
   * 但与 `buddyCnAuth` / `buddyAuth` / `lobsteraiAuth` / `codeartsAuth`
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
 * 登录方式与腾讯系、LobsterAI 都不同：**两段式 loopback 回调 + PKCE(S256)**，
 * 回调投递 `authCodeInfo`（AuthCode 模式），再由本插件调
 * `trae/api/v3/oauth/ExchangeToken` 换 token。
 */
export const TRAE_CN: TraeCnProduct = {
  id: 'trae-cn',
  displayName: 'Trae CN',
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
 * 与 `productById`（Buddy 系）、`lobsteraiProductById` 分开：三者返回
 * **不同类型**，合并成一个函数会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function traeCnProductById(id: string): TraeCnProduct | undefined {
  return ALL_TRAE_CN_PRODUCTS.find((product) => product.id === id)
}
