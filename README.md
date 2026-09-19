# dsh-account-hub

deepseek-harness 插件：执行 CodeArts（华为云）登录流程，默认走新式 IAM OAuth
（portal `/authorize` 授权 → 本地 `/oauth/callback` 回调 → STS token 端点换取含
`refresh_token` 的凭据），到期前静默续期，无需再次打开浏览器；旧 ticket 流程保留
为显式回退（`flow: 'ticket'`）。插件还注册一个 `codearts` LLM provider 路由，使该
凭证可直接用于 CodeArts 后端模型调用。

此外插件内置另外四个 provider 路由：

- **buddy-cn（Buddy CN）** — 见 [Buddy CN provider](#buddy-cn-provider)；
  另支持「一键领取积分」（每日签到）。
- **buddy（Buddy）** — 见 [Buddy provider](#buddy-provider)。
- **lobsterai（LobsterAI）** — 见 [LobsterAI provider](#lobsterai-provider)；
  另支持「一键领取积分」（每日签到）。
- **trae-cn（Trae CN）** — 见
  [Trae CN provider](#trae-cn-provider字节跳动-trae-国内版)；
  后端已实现签到与积分余额（双池），前端能力矩阵登记见该节说明。
- **trae-cn-work（Trae CN Work）** — Trae CN 的第二条路径（TraeWork 网页协议，
  扣 Work 专属积分池），见
  [Trae CN Work provider](#trae-cn-work-providertraework-网页协议)；Account Hub
  面板**共用 Trae CN 的账号**，只提供双池积分行与模型开关。

六个 provider 的 Account Hub 面板都提供「**显示列表**」按钮，可逐个开关模型以控制其
是否出现在对话框的模型选择里（黑名单制，默认全部显示）——
见 [模型列表开关](#模型列表开关黑名单)。

## 仓库来源

本仓库是**独立维护**的 GitHub 仓库
（[gurio-wine/dsh-account-hub](https://github.com/gurio-wine/dsh-account-hub)），
也是安装与升级的**唯一上游**。它的原始来源是 Gitee 上的
[iJetLi/deepseek-harness-codearts](https://gitee.com/iJetLi/deepseek-harness-codearts)：
早期为镜像同步，现已脱离该仓库独立演进，功能与修复不再回传。谨向原始作者致谢。

本仓库并非 GitHub 意义上的 fork（不是从某个 GitHub 仓库 fork 出来的），两者是并行
的两个托管位置。本地检出若保留了 `upstream` 远端指向 Gitee，仅作为历史回溯通道，
**不要**把它当作升级来源，也不要把它的分支合并回来。

## 安装

该包尚未发布到 npm registry。提供两种安装方式：**git 仓库安装**（推荐，自动拉取
并构建）和**源码目录安装**（本地开发联调）。

### 方式一：从 git 仓库安装（推荐）

先在 profile 的 `pnpm-workspace.yaml` 中放行该包的 build 脚本
（路径形如 `~/.dsh/profiles/<name>/pnpm-workspace.yaml`）：

```yaml
allowBuilds:
  dsh-account-hub@git+https://github.com/gurio-wine/dsh-account-hub.git: true
```

再用 `dsh plugin add` 从 GitHub 拉取并安装：

```sh
dsh plugin --profile <name> add "https://github.com/gurio-wine/dsh-account-hub.git"
```

`add` 以 `git+https` 方式安装，pnpm 会运行 `prepare` 脚本自动构建 `lib/`，无需
手动 `pnpm build`。每次升级时重新 `add` 即可拉取最新版本并重建。

### 方式二：从源码目录安装（本地开发）

先在本仓库中构建 `lib/`，再用 `dsh plugin install` 将本地检出安装为 pnpm `link:`
依赖（指向本目录）：

```sh
pnpm build:all
dsh plugin --profile <name> install <path-to-this-repo>
```

> `dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:` 依赖运行
> `prepare` 脚本，因此必须先手动执行 `pnpm build:all` 生成 `lib/`，否则 dsh 启动时
> 报 `ERR_MODULE_NOT_FOUND: ... dsh-account-hub/lib/index.js`。
> 注意必须用 `build:all` 而非 `build`：后者只编译宿主侧，不产出
> `lib/client/jet-hub.js`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 从 dsh-codearts-auth 迁移

本插件原名 `dsh-codearts-auth`，设置页品牌为旧名，现统一更名为
`dsh-account-hub`（设置页显示 "Account Hub"）。**只有品牌层改名**，代码标识符与
存储键一律未动，因此迁移不丢数据。

已安装旧包的用户按两步走：

```sh
dsh plugin --profile <name> remove dsh-codearts-auth
dsh plugin --profile <name> add "https://github.com/gurio-wine/dsh-account-hub.git"
```

别忘了同步 profile 的 `pnpm-workspace.yaml`：`allowBuilds` 里旧包的整行替换为新包名
（即上面「方式一」那段）。GitHub 对旧地址有自动重定向，但仍建议直接写新地址。

> **账号与模型开关不会丢。** 账号索引与 `disabledModels` 模型开关存在 settings 的
> `jet-hub` 命名空间里，凭据存在 `ctx.credentials` 中（ref 如
> `CODEARTS_ACCESS_TOKEN` / `BUDDY_CN_ACCOUNT_XXX`）。这些**都是代码标识符，改名时刻意
> 保持原样** —— 变的只有包名与界面文案，所以重装后账号池、登录状态与显示列表设置
> 直接续用，无需重新登录。
>
> 上面这条说的是**包名**改名（`dsh-codearts-auth` → `dsh-account-hub`）。
> 2026-09-18 的 **provider** 改名是另一回事，它是一次**破坏性变更**，落在持久化
> 数据上，因此插件启动时**自动迁移**（见「provider 改名与数据迁移」一节）。

### provider 改名与数据迁移（2026-09-18）

**这是与上面那节性质完全不同的一次改名**：上面只动包名与界面文案，标识符一律
不变；而这次动的是 **provider 的 id 与显示名**，落在 `settings.yaml` 与
`.credentials.yaml` 里，属于**破坏性变更**。改名后的对应关系：

| 新显示名 | 新 id | 原显示名 | 原 id |
|---|---|---|---|
| **Buddy CN** | `buddy-cn` | CodeBuddy (腾讯) | `buddy` |
| **Buddy** | `buddy` | WorkBuddy (国际版) | `workbuddy` |
| **Codearts** | `codearts` | CodeArts (华为云) | 不变 |
| **LobsterAI** | `lobsterai` | LobsterAI (有道) | 不变 |
| **Trae CN** | `trae-cn` | Trae CN (字节跳动) | 不变 |

**两个腾讯系产品的 id 互换**，所以升级时数据必须跟着搬。插件启动时自动执行
一次性迁移（`src/provider-rename-migration.ts`），覆盖三处持久化数据：

- 账号条目的 `provider` / `credentialRef` / `id`（`settings.yaml` 的 `jet-hub` 命名空间）；
- `disabledModels` 模型开关的 provider 键；
- 凭据 ref 名（`.credentials.yaml`）：`BUDDY_*` → `BUDDY_CN_*`，
  `WORKBUDDY_*` → `BUDDY_*`。

迁移完成后写入 `schemaVersion: 1`，再次启动即整体跳过，**幂等可重入**。中途若
出现凭据冲突（目标 ref 已存在且值不同）或写入失败，该条账号**整体保留原样**并
记 `error` 日志，不会留下「账号指向新 ref、凭据还在旧 ref」的半迁移状态。

> **从旧版本升级后若发现账号不见了，重启一次即可。** 迁移是异步
> （fire-and-forget）执行的，不阻断插件启动；某一轮没跑完或遇到只读凭据源时，
> 数据保持原状，下次启动重试。
>
> **旧会话的模型路由需要手动重选一次。** 会话里记住的 provider 名是**历史字面量**
> —— 迁移只搬账号池与凭据，不会改写已存盘的会话记录。升级后若某个旧会话仍指向
> 旧 provider 名（如旧 `workbuddy`，语义已翻转为 `buddy-cn`/`buddy`），
> 在该会话里**重新选择一次模型**即可恢复。
>
> **出站协议值一律未改**（这是刻意的）：`X-Product-Code` 仍为
> `codebuddy` / `workbuddy`，`platform` 仍为 `ide` / `workbuddy-ai`，
> User-Agent 品牌字样与两个域名（`copilot.tencent.com` / `www.workbuddy.ai`）
> 全部照旧。腾讯后台按这些值归因用量，跟着显示名改会让账单归属错乱 ——
> **改名只发生在插件自己的 id / 显示名 / 服务名 / 设置命名空间 / 默认凭据 ref 上**。

### 通用说明

该包声明了 `dsh.bundle` 补丁（`cordis.patch.yml`），因此 profile 的 layer 栈会
自动拾取 `codearts-auth` 行。插件注入由 dsh base 提供的 `credentials`、
`commands` 和 `llm` 服务。

## 用法

- `/codearts-login` — 在浏览器中打开华为云 portal 授权页；授权后，插件经本地
  `/oauth/callback` 回调收取 `code`，并由 STS token 端点换取含 `refresh_token` 的
  AK/SK/SecurityToken 凭据。该命令是**阻塞式**的（等到用户在浏览器完成授权）；
  Account Hub 设置页走的是两段式非阻塞路径（见下）。
- `/codearts-status` — 显示 `configured`、`source`、`expiresAt`、
  `refreshable` 以及最新的 `refreshError`。
- `/codearts-refresh` — 手动静默续期凭据（refresh_token 换取；无 refresh_token 时提示重新登录）。
- 编程式调用：`ctx.codeartsAuth.login()`、`ctx.codeartsAuth.status()`、
  `ctx.codeartsAuth.refresh()`、`ctx.codeartsAuth.logout()`。

### 登录是两段式非阻塞的（2026-09 起）

Account Hub 的 **Codearts 面板**点「+ 新建账号」时，RPC **不再**在请求内等待浏览器
登录。原实现（`account.create` 里 `await codearts.login(...)`）最长阻塞 180 秒，
等它返回时触发点击的**用户手势早已过期** —— 客户端拿到 `loginUrl` 再开窗会被
浏览器弹窗拦截，客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉。现在的形态与
CodeBuddy 系（现 Buddy 系）、LobsterAI 完全一致（见 [AGENTS.md](AGENTS.md) 的「登录必须两段式」）：

1. **第一段（同步返回）**：`CodeArtsAuth.prepareLogin()` → `prepareCodeartsLogin()`
   起本地回调服务器（端口 ≥10000）、生成 PKCE/DPoP，返回 `{port, loginUrl,
   awaitCredential, cancel}`；`pool.addAccount` 写入**占位条目**
   （`refreshable: false`、无 `expiresAt`），随后立即 `return {ok: true, value:
   {accountId, loginUrl}}`。**流程内不打开浏览器** —— 打开动作归客户端，
   宿主再开一次会变成两个标签页。
2. **第二段（后台）**：后台 `awaitCredential()` 完成后由
   `CodeArtsAuth.persistLoginResult()` 写凭据并补全占位账号
   （`expiresAt` / `refreshable`）；失败则 `pool.removeAccount` 移除占位，
   避免留下无凭据的幽灵账号。
3. **轮询结算**：客户端每秒调 `login.poll`，宿主按 `accountId` 回
   `{done, error?}`。**失败是终态**：第二段失败时先登记失败原因、再删占位
   （`jet-hub-rpc.ts` 的 `loginFailures` 表），poll 回 `{done:true, error}`
   并**读到即清**；成功仍是 `{done:true, success:true}`，未完成是
   `{done:false}`。三者严格区分 —— 否则「失败」会退化成「永远未完成」，
   客户端白等 5 分钟且窗口不收（用户报障的残留标签页）。
   `login.poll` 还会**预检 `credentialRef` 合法性**（`isCredentialRefName`，
   与 `credentialRef()` 同一个 `REF_PATTERN`），非法时回
   `{done:true, error:'invalid-credential-ref'}` 而不是让 `credentialRef()`
   抛 TypeError 被包成 `handler-failed`（客户端会把它当网络抖动吞掉）。
   客户端三条终态路径（成功 / 失败 / 5 分钟超时）共用同一个收尾动作
   （`finishPolling`：停表 + 收窗 + 刷新账号列表）。

配套约束：

- **provider 级互斥**：同一时间只允许一个进行中的 Codearts 登录会话，重复点击返回
  `{ok:false, error:'login-in-progress'}`（判别联合，**不抛异常** —— 抛异常会被 RPC
  统一包装成 `jet-hub/handler-failed`，客户端就拿不到可判别的错误码）。
  不复用旧会话（会让一份凭据被多个占位 accountId 共享），也不静默新建
  （每次点击都会堆一个 loopback 端口到 180 秒超时）。互斥采用**同步占位**
  （`'preparing'` 槽位）：判空与 listen 之间隔着 `generateDpopKeyPair()` 等 await，
  若只在 listen 成功后才登记，并发连发会全部通过判空、各起一个监听；
  listen 失败会**归还槽位**，否则此后所有登录都会被永久挡住。
- **`account.delete` 会 cancel 对应会话**（`jet-hub-rpc.ts` 的
  `pendingCodeartsLogins` 登记表）：否则旧会话会一直占着回调端口到超时，
  用户删掉占位账号后重新登录会一直拿到 `login-in-progress`。
- `login()` 保留为**阻塞式便捷封装**（`prepare` + `awaitCredential` 的串联），
  供 `/codearts-login` 命令与 e2e 探针等同步调用方使用，行为不变。
- 端口 ≥10000、180 秒等待预算、PKCE（`code_challenge_method=SHA-256`）、
  成功/失败 307 重定向到 portal 结果页、旧 `secret` 回退轮询全部保留原语义。

## LLM provider

插件在 `ctx.llm` 上注册了一个 `codearts` provider 路由（OpenAI 兼容端点
`https://snap-access.cn-north-4.myhuaweicloud.com/api/v2`）。每个模型请求都使用
存储的 AK/SK/SecurityToken 按华为 `SDK-HMAC-SHA256` 方案签名，并附带
`Chat-Id`/`Session-Id` 请求头。默认广告的模型为 GLM-5.2、GLM-5.1、
GLM-5、GLM-5.3 Flash（`glm-5.3-flash`，1M 上下文）、盘古
openpangu-2.0-flash (92B) / openpangu-2.0-pro (505B)，
以及 DeepSeek V4 deepseek-v4-flash / deepseek-v4-pro（UI 标注每日 1000 万免费
Tokens 福利）。
登录后在 dsh Models 页面选择该 provider 即可。

> 注 1：CodeArts Agent IDE 模型列表显示的 flash ID 为 `deepseek-v4-flash-0731`
> （带日期后缀），但后端实际注册的可用 ID 是 `deepseek-v4-flash`（无后缀）。
> 用 `deepseek-v4-flash-0731` 调用会返回 `InferHub.002002009.404 The model is
> not registered`，因此本插件只注册无后缀的 `deepseek-v4-flash`。
>
> 注 2：`glm-5.3-flash`（GLM-5.3 Flash，2026-08 加入，1M 上下文）是 benefit
> （免费额度）模型：其 chat 请求必须携带 `maas_type: benefit` 请求头且该头
> 参与 `SDK-HMAC-SHA256` 签名，否则后端返回 `InferHub.002002009.404 The model
> is not registered`。适配器已自动处理，无需手动配置。
> （逆向自 CodeArts Agent IDE mitmproxy 抓包，对齐 deveco-code-rust 90aeb17d。）

凭据来自默认的新式 IAM OAuth 流程（含 `refresh_token`）。请求发起时会解析最新
凭据，若已过期则先静默续期，再用新 AK/SK/SecurityToken 签名，无需重新打开浏览器。

除 `codearts` 外，插件另注册五个独立路由：`buddy-cn`（见
[Buddy CN provider](#buddy-cn-provider)）与 `buddy`（见
[Buddy provider](#buddy-provider)）两个 buddy 系路由、`lobsterai`
（见 [LobsterAI provider](#lobsterai-provider)）、`trae-cn`
（见 [Trae CN provider](#trae-cn-provider字节跳动-trae-国内版)）与
`trae-cn-work`（见 [Trae CN Work provider](#trae-cn-work-providertraework-网页协议)）。
六者互不覆盖，可同时使用。

> `trae-cn-work` 与 `trae-cn` 是**同一批账号**（Work 无独立登录，见
> [Account Hub 里的 Trae CN Work 面板](#account-hub-里的-trae-cn-work-面板)），
> 但它们注册成**两个路由**：协议不同源、模型池不重合、扣的是两个互不通用的积分池。

## 凭证

- Ref：`CODEARTS_ACCESS_TOKEN`（POSIX 标识符格式的凭证 ref）。
- 值：JSON 字符串 `{ access_key_id, secret_access_key, security_token,
  expires_at, domain_id?, user_id?, user_name? }` — AK/SK 对用于给每个 CodeArts
  后端 API 请求签名。
- `status()` 报告 `configured`、`source`、`expiresAt`、`refreshable` 和
  `refreshError`。

## 续期（refresh）

- 默认登录流程为**新式 IAM OAuth**（PKCE + DPoP）：portal `/authorize` 授权 → 本地
  `/oauth/callback` 回调收取 `code` → `sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`
  换取含 `refresh_token` 的凭据。
- 凭据在过期前 1 小时静默续期（`getFirstRefreshTime` 语义：距过期 ≤1h 立即刷，
  否则 `now+1h` 叠加随机秒偏移），全程无浏览器、无人工操作。
- 刷新失败后 10 分钟重试（异常网络 1 分钟）；`refresh_token` 失效后停止续期并提示
  重新登录（原因会体现在 `status().refreshError` 中）。
- 旧 ticket 流程保留为显式回退：`/codearts-login` 默认走 OAuth；编程式调用
  `ctx.codeartsAuth.login({ flow: 'ticket' })`。ticket 凭据没有 `refresh_token`，
  其续期仍意味着重新运行浏览器登录流程。
- 手动续期：`/codearts-refresh` 或 `ctx.codeartsAuth.refresh()`。
- 续期定时器是 unref 的，在 `logout()` 和插件卸载时停止。
- 运行时依赖新增 `jose`（用于 DPoP JWS 签发，与 CodeArts Agent 插件实现一致）。

## 开发

- `pnpm test` — 单元测试（快速，无网络）。
- `pnpm test:e2e` — 针对华为线上端点的真实登录流程；需要在打开的浏览器中由人工
  点击授权按钮（续期为静默刷新，无需再次点击）。
- `pnpm typecheck`、`pnpm build:all`。

### 构建

- `pnpm build` — 用 tsc 将 `src/` 编译到 `lib/`（生成 `.js`、`.d.ts` 和 source
  map）。插件**宿主侧**入口是 `lib/index.js`。
- `pnpm build:client` — 用 esbuild 将 `plugin-src/client/` 打包为
  `lib/client/jet-hub.js`（Account Hub 设置页的客户端 bundle，由 `exports["./client"]`
  引用）。它**不在** `tsc` 的编译范围内，必须单独构建。
- `pnpm build:all` — 依次执行上面两步（`build` + `build:client`），是完整的构建。
- `pnpm typecheck` — 只做类型检查（`tsc --noEmit`），不产出文件，可在构建前快速
  验证。

`lib/` 已被 gitignore，因此构建是安装或运行前的必需步骤。只执行 `pnpm build`
会漏掉客户端 bundle，dsh 启动时会因 `exports["./client"]` 指向的文件不存在而
加载失败（Account Hub 设置页不显示），请改用 `pnpm build:all`。

每次修改 `src/` 或 `plugin-src/` 后都需要重新执行 `pnpm build:all`——dsh 启动时
不会自动重建。

### 安装到 profile 之前先构建

详见「安装」小节。`dsh plugin install` 以 `link:` 方式安装，pnpm 不会为 `link:`
依赖运行 `prepare` 脚本，因此必须先 `pnpm build:all` 生成 `lib/`（含客户端
bundle）。

## 工作原理

默认登录流程（新式 IAM OAuth，PKCE + DPoP）：

1. 生成 PKCE 配对与 DPoP ES256 密钥对，并启动本地 `127.0.0.1` 回调服务器
   （端口 ≥10000）。
2. 构造 portal `/authorize` URL 并打开华为云授权页面（两段式下这一步由客户端
   在用户手势内完成）。
3. 授权后浏览器回调本地 `/oauth/callback`，携带授权码 `code`。
4. 向 STS token 端点（`sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`）用
   `code` 换取含 `refresh_token` 的凭据 JSON，并存储到 `CODEARTS_ACCESS_TOKEN` 下。
5. 凭据到期前静默续期（见「续期（refresh）」），无需再次打开浏览器。

上述 1–2 步在代码中即 `prepareCodeartsLogin()`（第一段），4–5 步的落盘即
`persistLoginResult()`（第二段）；阻塞式 `runOAuthFlow()` / `login()` 只是
「第一段 → 打开浏览器 → 第二段」的串联。

旧 ticket 流程保留为显式回退（编程式调用 `ctx.codeartsAuth.login({ flow: 'ticket' })`）：
生成 `ticket_id`，打开 `devcloud.cn-north-4.huaweicloud.com/doer/redirect` 认证页，
回调后轮询 snap-manager ticket 端点（120 × 1 秒）获取临时凭证；此类凭据没有
`refresh_token`，其续期仍意味着重新运行浏览器登录流程。

## Buddy CN provider

独立路由 `buddy-cn`（**Buddy CN**，原 CodeBuddy 中国版；OpenAI 兼容端点
`https://copilot.tencent.com/v2/chat/completions`），Bearer `access_token` 鉴权。
cordis 服务名是显式指定的 `ctx.buddyCnAuth` —— 带连字符的 id 机械派生会得到
非标识符风格的 `buddy-cnAuth`，与 `trae-cn` 是同一先例。

登录采用 external-link-v2 轮询式（与 CodeArts 的本地回调服务器不同，Buddy CN
不起本地端口，而是轮询后端 API）：

1. `POST /v2/plugin/auth/state?platform=ide` → 取得 `state` 与 `authUrl`。
2. 打开浏览器到 `https://www.codebuddy.cn/login/?platform=ide&state=...`。
3. 轮询 `GET /v2/plugin/auth/token?state=...`（1 秒间隔、5 分钟超时）→ 令牌；
   错误码 `11217` 表示 token 未就绪，继续轮询。
4. 轮询 `GET /v2/plugin/login/account?state=...` → 账户信息；错误码 `12151`
   表示账户信息未就绪，继续轮询。
5. 续期：`POST /v2/plugin/auth/token/refresh`，通过 `X-Refresh-Token` 头提交
   refresh_token。

- **登录入口：Account Hub 设置页的 Buddy CN 面板**（支持多账号与账号池自动切换）。
  已不再注册斜杠命令 —— 设置面板已覆盖登录、状态查看与续期，命令式入口冗余。
- 编程式调用：`ctx.buddyCnAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 模型列表：以内置的产品目录为准（`src/product.ts` 的 `fallbackModels`），
  远端 `GET /v3/config` 可用时优先采用其元数据。
- 请求头：除 `Authorization: Bearer` 外，还需 `X-Domain`、`X-Product`、
  `X-Product-Code` 以及伪装为 `CodeBuddyIDE/1.106.1` 的 `User-Agent`。
- 凭据 ref：单账号 `BUDDY_CN_ACCESS_TOKEN`，多账号 `BUDDY_CN_ACCOUNT_<UUID_SHORT>`；
  值为含 `access_token` / `refresh_token` / `expires_at` 的 JSON 字符串。

> **流式工具调用 id 稳定性**：Buddy CN 仅首个工具调用分片携带真实 id
> （`chatcmpl-tool-xxx`），后续参数分片只有 `index`。适配器按 index 缓存并沿用
> 真实 id（缺失时回退 `call_{index}`），保证同一工具的所有分片 id 一致——否则
> 跨轮次（每轮都从 `call_0` 重新编号）会把 `tool/result` 配对到错误的历史条目。

## Buddy provider

独立路由 `buddy`（**Buddy**，原 WorkBuddy 国际版 / WorkBuddy AI），与
[Buddy CN provider](#buddy-cn-provider) **同源**：共用同一 CLI 内核与同一认证协议
（cli-external-link 轮询式），Bearer `access_token` 鉴权。差异收敛在
`src/product.ts` 的产品配置里：

| 项 | Buddy CN（中国版） | Buddy（国际版） |
|---|---|---|
| `endpoint` | `https://copilot.tencent.com` | **`https://www.workbuddy.ai`** |
| `platform` | `ide` | **`workbuddy-ai`** |
| 登录 URL 附加参数 | 无 | **`version` / `loginSessionId`** |
| `pluginVersion` | — | `5.5.2` |

**协议值不随 id 改名**：本路由的 id 已从 `workbuddy` 改为 `buddy`，但它出站的
`X-Product-Code` **仍是 `workbuddy`**、`X-Product` / `X-IDE-Name` / `X-IDE-Type`
**仍是 `WorkBuddy`**、`platform` 仍是 `workbuddy-ai` —— 腾讯后台按这些值归因用量。

**模型列表不能与 Buddy CN 共用**：两者的路径与响应解析完全相同
（`GET /v3/config` → `data.data.models` / `data.data.agents`），差异只来自
`endpoint` —— 不同区域的后端返回不同模型池（中国版含 glm / hy / deepseek 系，
国际版含 claude / gpt / gemini / kimi 系）。因此 `endpoint` 必须随产品切换，
不能被当成全局常量。

登录流程与 Buddy CN 一致（`auth/state` → 浏览器授权 → 轮询 `auth/token` →
轮询 `login/account`），仅身份标识与端点按上表区分。`X-Domain` 随 `apiDomain`
切换为 `www.workbuddy.ai`。

**没有每日签到积分**：国际版后端不提供**签到**接口（内核中只有
`/v2/billing/meter/get-dosage-notify` 用量通知），因此 Account Hub 的 Buddy
面板**不显示「一键领取积分」按钮**；签到领取在 Buddy CN 面板完成。

> **但积分余额（Credits Balance）可以查。** 签到与余额是两项独立能力：国际版
> 确实没有签到，但**有**积分余额查询接口，见下节。不要因为"没有签到"就推断
> 也查不到余额。

- **登录入口：Account Hub 设置页的 Buddy 面板**（支持多账号与账号池自动切换）。
  同样不注册斜杠命令。
- 编程式调用：`ctx.buddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 凭据 ref：
  - 单账号：`BUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
    `expires_at` 的 JSON 字符串（与 `BUDDY_CN_ACCESS_TOKEN` 同构）。
  - 多账号：`BUDDY_ACCOUNT_<UUID_SHORT>`，由 Account Hub 设置页「+ 新建账号」
    登录时自动生成并登记到账号池；每条账号记录带 `provider: 'buddy'`，
    与 Buddy CN 的 `BUDDY_CN_ACCOUNT_*` 相互隔离，不会串用凭据或限流标记。
  - ⚠️ 迁移期注意：`BUDDY_ACCOUNT_*` 这个前缀**历史上属于中国版**。升级时由
    `src/provider-rename-migration.ts` 按「中国版先让位、国际版后搬入」的两趟
    顺序腾空并复用，见「provider 改名与数据迁移」一节。
- **从中国版升级**：本插件**更早**的版本曾把当时名为 `workbuddy` 的这条路由指向
  中国版端点（`copilot.tencent.com`；该路由现名 `buddy`）。启动时会自动清理凭据
  `domain` 与当前 `apiDomain` 不符的旧账号（这类凭据在新端点必然失败），
  清理结果记入日志，请在 Account Hub 重新登录。
- 续期：与 Buddy CN 共用同一套机制，插件启动后每 30 分钟对可续期账号静默刷新
  （`refresh_token` 经 `X-Refresh-Token` 头提交），无需重新打开浏览器。
- 请求头、模型列表拉取与流式工具调用 id 处理均与 Buddy CN 一致，详见上一节。

### 与 Account Hub 设置页的关系

Account Hub（设置页）的账号面板按 provider 分组展示，Buddy 是其中一栏：

- 面板提供账号列表、新建账号（浏览器登录入池）、启用/停用、删除，以及「重测 /
  重测所有 / 重置 / 重置所有」限流标记操作，行为与 Buddy CN 面板一致，但
  只操作 `provider: 'buddy'` 的账号。
- 账号卡片展示 credentialRef、有效期（含「自动续期」标记）、限流状态与**积分
  余额**（见下节）。「一键领取积分」按钮**仅 Buddy CN 面板提供**，结果来自
  RPC 端点 `credits.claimAll`（实现见 `src/jet-hub-rpc.ts`，签到客户端见
  `src/credits.ts`）。
- 后端另实现了 `credits.status`（查询某 provider 下全部启用账号的签到状态），
  但**前端尚无消费者**：`plugin-src/client/jet-hub.js` 只调用 `credits.claimAll`，
  `credits.status` 目前仅供外部脚本或直接 RPC 调用使用。
- 对应 LLM provider 的设置命名空间为 `llm-buddy`（Buddy CN 是 `llm-buddy-cn`，
  两者由 `llm-${product.id}` 派生）。

### 模型列表开关（黑名单）

Account Hub 面板标题栏的「**显示列表**」按钮展开该 provider 的**全部模型**，每个模型
后面带一个开关，**默认打开**。关闭后该模型不再出现在对话框的模型选择列表里。

采用**黑名单制**：只有被显式关闭的模型会被隐藏，未记录的模型（含服务端后续新增的
模型）一律默认显示。这与白名单制的关键差别在于——新模型上线时无需任何配置就会
自动出现在选择器里，不会被静默挡在门外。

- 开关状态持久化在 `jet-hub` settings 命名空间的 `disabledModels` 字段
  （形如 `{ 'buddy-cn': { 'glm-5.2': true } }`），与账号池同处一个 namespace。
- 模型列表来自 `ctx.llm.listModels()`，**即对话框模型选择器读取的同一份目录**
  （会话控制器的 `buildModelCatalog`），因此设置页展示的模型与实际可选集合始终
  一致，不会出现「设置里有、选择器里没有」的错位。
- 过滤发生在适配器的 `listModels`（`src/llm-adapter.ts` / `src/buddy-adapter.ts` /
  `src/lobsterai-adapter.ts`），
  每次调用都直接读账号池的黑名单，因此**改开关后下一轮模型目录刷新即生效**，
  无需重启或重建适配器。
- **只影响目录播报，不改变路由能力**：被关闭的模型仍可被 `resolveModel` 解析、
  仍能正常收发请求。这是 DSH 对 `listModels` 的约定（目录是建议性的，缺省不构成
  请求拒绝）。好处是已有会话若正用着某个被关闭的模型，不会被强制中断。
- 开关按 provider 隔离，Codearts / Buddy CN / Buddy / LobsterAI / Trae CN /
  Trae CN Work **六份黑名单互不影响**。改名迁移会把这六份的 provider 键一并搬到
  新命名，见「provider 改名与数据迁移」。
- Trae CN Work 是独立的第六份：两个池的模型 id 完全不重合，共用一份黑名单会让
  关闭 IDE 的某个模型连带影响 Work 路径（`TraeCnWorkAdapter.listModels` 读的正是
  `trae-cn-work` 这个键）。
- 相关 RPC 端点：`model.list`（列出模型并回填 `disabled`）、`model.setDisabled`
  （打开/关闭单个模型），实现见 `src/jet-hub-rpc.ts`。

### 积分余额（Credits Balance）

账号卡片上的「积分」一行显示该账号的**可用积分**，与 IDE 顶部显示的
`Credits Balance` 是同一个数值。鼠标悬停可看到各资源包的明细与到期时间。

**支持范围**覆盖四个 provider、三套端点，语义一致：

- **Buddy 系（`buddy-cn` / `buddy` 通用，仅 baseURL 随 `product.endpoint`
  切换）**：

  ```
  POST /v2/billing/meter/get-user-resource    body {}
  ```

- **LobsterAI**：

  ```
  GET /api/user/profile-summary    → data.totalCreditsRemaining
  ```

  不要用 `/api/user/quota`（只有 `freeCreditsTotal=300`，不含活动积分，实测某账号
  `profile-summary` 有 5297.72 而 `quota` 只有 300）。

- **Trae CN**：

  ```
  POST /trae/api/v2/pay/web_user_ent_usage    body {"require_usage":true}
  ```

  响应里的礼包按 `available_endpoint` **分池**（0=通用积分、1=Work 积分）。
  `fetchTraeCnCreditBalance` 返回的 `total` 是**通用池**合计（本插件走的 IDE
  对话消耗的就是它），Work 池走**单独的 `workTotal` 字段**，两者**绝不合并成一个数**
  —— Work 专属积分只在 TraeWork（`work.trae.cn` 网页版 / 桌面版）能花。
  **不要**用 `ug/activity/info` 的活动口径：实测它写「200 work 积分」而实际到账
  150 通用积分，是口径陷阱。详见 [Trae CN provider](#trae-cn-provider字节跳动-trae-国内版)
  的「签到与积分余额」。

「余额为 0」与「查不到」严格区分：失败时 `balance` 为 `null` 并带 `error`，
卡片显示原因而非 0。

> **Trae CN 的前端已登记。** 三个积分端点的 provider 分发在
> `src/trae-cn-credits.ts` + `src/jet-hub-rpc.ts`，客户端一侧两件事都已落地：
> 1. `plugin-src/client/credits-capabilities.js` 登记了 `trae-cn`（`balance` ✓、
>    `dailyCheckin` ✓），`PROVIDERS` 同步加入该 tab —— 面板因此显示「积分」行、
>    「刷新积分」与「一键领取积分」按钮；
> 2. `CreditBalanceRow` 见到余额对象带 `workTotal` 时切**双池形态**，显示
>    「通用 154.22 / Work 2000」；两池**绝不合并**，且 Work 用弱化色（Work 专属
>    积分只在 TraeWork 能花，IDE 对话只消耗通用池）。没有 `workTotal` 的 provider
>    渲染**逐元素不变**，由 `tests/unit/jet-hub-credit-balance-row.spec.ts` 用
>    整树深比较守住。
>
> ✅ 宿主侧接线已完成（`47f253f`）：`account.create` / `account.refresh` /
> `account-probe.ts` 三处的 `trae-cn` 分支与 `registerJetHubRpc` 的 `traeCn`
> 实例均已就位，Trae CN 面板可以新建账号、刷新凭据与重测限流标记。

**CodeArts 不支持**：它是华为云账号体系，没有上述任何一条计费接口。因此 CodeArts
面板**不显示「积分」行，也不显示「刷新积分」按钮**，且不会发起
`credits.balances` 请求。这一点由 `plugin-src/client/credits-capabilities.js`
的能力矩阵在**请求前**判定，而非等后端返回错误再吞掉。

> 历史缺陷：早期客户端在面板挂载时对所有 provider 无条件调用
> `credits.balances`，于是每次打开 CodeArts 面板都会在控制台报
> `unsupported provider: codearts`，并把每个账号卡片的「积分」渲染成
> 「查询失败」。修法是不发起该请求——后端 `productById()` 的拒绝是正确的
> 契约行为，不该被当作运行时故障展示。

**Trae CN Work 面板显示同一份双池余额**：`credits.balances` 收到 `trae-cn-work`
时由 `src/jet-hub-rpc.ts` 的 `poolProviderFor()` 映射到 `trae-cn` 的**同一个实现**
（同批账号、同端点、同 `workTotal` 拆分）。刻意不新写一套 Work 专用逻辑——
余额是**账号属性**，不是路径属性。Work 面板因此能直接回答它存在的那个问题：
Work 池还剩多少。

**但 Work 面板不显示签到按钮**（矩阵里 `dailyCheckin: false`）：签到是账号级、
当日一次的操作，两个面板都放按钮必然导致同一账号重复领取。详见
[Account Hub 里的 Trae CN Work 面板](#account-hub-里的-trae-cn-work-面板)。

### 一键领取积分（每日签到）

**当前由 Buddy CN、LobsterAI 与 Trae CN 三个面板提供**该按钮。签到在本插件里
共有**三套互不相通的实现**（Buddy CN / LobsterAI / Trae CN，协议、端点、幂等
判据全不同，各自独立成文件）；三者的客户端能力登记均已落地，故三个面板都显示
该按钮。Codearts 是华为云账号体系不参与；Buddy（国际版）后端没有签到接口，
故其面板不显示；**Trae CN Work 与 Trae CN 是同一批账号**，签到已在 Trae CN
面板提供，故本面板刻意不显示（否则同一账号两处领取）。详见「积分余额」
一节末尾的说明。

在 Account Hub 对应面板标题栏点击「**一键领取积分**」，插件会对该面板下
**全部账号**顺序执行每日签到领取：

> **含已停用账号。** 停用只影响账号池的自动选择与限流切换，不改变账号本身
> 是否已签到——用户点「一键领取」时期望所有账号都尝试一遍。

**Buddy CN（两步）**：

1. 先查签到活动状态（`POST /v2/billing/meter/checkin-activity-status`）；
2. 活动未开启或今日已签到则跳过领取请求，只报告状态；
3. 否则调用领取端点（`POST /v2/billing/meter/daily-checkin`）领取当日积分。

**LobsterAI（三步，见 `src/lobsterai-credits.ts`）**：

1. 查活动槽位（`GET /api/client-activities/slot`，带固定的
   `placement` / `containerApiVersion` / `platform` 参数）；
2. 查活动上下文（`GET /api/client-activities/{code}/context`），
   读 `claimedToday` 与 `actions` 决定是否可领；
3. 领取（`POST /api/client-activities/{code}/actions/check_in`，
   请求带客户端幂等键 `idempotencyKey`）。

> LobsterAI 的 `clientVersion` 是签到**必填**参数，由插件动态拉取
> （`api-overmind.youdao.com` 的更新接口，缓存 12 小时）；
> 拉取失败时回退内置兜底版本并在日志告警 —— 比参考实现的
> 「取不到就完全放弃签到」更宽容。

**Trae CN（两步 + 设备四件套，见 `src/trae-cn-credits.ts`）**：

1. 先查签到状态（`POST /trae/api/v2/ug/checkin_credits/status`，body
   `{"req_source":1}`）；
2. `checked_in` 为真则跳过领取（幂等短路），服务端显式 `enable:false`
   则报 `inactive`；
3. 否则调领取端点（`POST …/checkin_credits/claim`，同样 body
   `{"req_source":1}`）。

> **Trae 的签到必须带设备头**（与腾讯系、LobsterAI 都不同）：`x-device-id`
> 取自凭据里的 `device_id`（= 登录 exchange 返回的 `BoundDeviceID`），另带
> `x-device-type: windows` / `x-os-version` / `x-app-version`。claim 严格校验，
> 缺了直接回 `code:9004`。✅ **T9 已校准（2026-09-18）**：status / claim
> **都不校验设备号形态**（16 位十进制号 / `BoundDeviceID` / 空串全回 `code:0`），
> 只有**完全不带设备头**才会 `did_checked_in:false` —— 详见「Trae CN provider」章节。
> 幂等判据是 **`checked_in`（账号级当日）**，**不是** `did_checked_in`
> ——后者是设备级语义，换台设备仍为 false，拿它判幂等会对已领账号重复发请求。
> 无 auth 时服务端返回的是 **HTTP 200 + `code:1001` + `enable:false`**
> （不是 401），故判定一律**以 body `code` 为准**。
>
> ⚠️ **`x-os-version` 是运行时取值，不是常量**（2026-09-19 身份保真修复）：
> 反混淆真机客户端 `out/main.js` 的 claim 调用链后确认它发的是 **`os.version()`**
> 的返回值（本机 `Windows 10 Home`，带品牌名的市场营销名），而本插件原先硬编码
> `Windows 10.0.22631`（构建号）——**同一个插件对同一台机器报了两种操作系统身份**
> （登录 URL 的 `x_os_version` 一直是 `Windows 10 Home`）。现已改为运行时
> `node:os` 的 `os.version()`，两者形态统一。`x-app-version` 同步升到 `3.3.102`
> （原 `3.3.100` 落后两个补丁号）。
> **这是身份保真，不是 `9074` 的解药** —— `9074` 已由真机实证为**瞬时频次软限流**
> （同账号隔一会儿重试即成功），与设备身份形态无关。

完成后按钮下方给出结果摘要（如「3 个账号领取成功（+300 积分），1 个今日已领取」）。
**有账号失败时，摘要行下面逐个失败账号各列一行**
「`<昵称或账号 id>`：`<服务端 message>`（code `<code>`）」—— 摘要里的
「1 个失败」只说有几个，服务端原文才说明**为什么**（风控限流 / 凭据失效 /
活动结束的处置完全不同）。`message` 为空时回退固定文案「领取失败」，
`code` 缺失时显示「未知」；成功、已领、活动未开启都不产生明细行。

**失败行末尾还会追加 `· logid <值>`**（当服务端给了时）——见下方
「失败诊断的 logid 透传」。

领取按账号隔离：单个账号凭据缺失、损坏或请求失败不会中断整批，只计入失败数。
完整结构化结果（`results[].outcome`）仍保留在 RPC 响应里，需要时也可查看日志。

几点实现约定：

- 领取是**顺序执行**的，避免并发触发风控；账号较多时需要等待片刻。
- **Buddy CN** 重复领取是幂等的：服务端返回 HTTP 400 + `code 10001`（「今天已签到，
  请明天再来」），插件把它识别为 `already-claimed` 而非失败。
- **LobsterAI** 的幂等由**客户端**保证：请求带 `idempotencyKey`，且领取前先读
  `context` 的 `claimedToday` 与 `actions`；重复领取会被识别为 `already-claimed`。
- Buddy CN 的状态查询用 `checkin-activity-status` 而非 `checkin-status`；后者返回
  占位数据（`active:false`、`checkin_dates:null`），会让人误判为活动未开启。
- Buddy CN 的请求**不需要** `X-Device-Token`（图灵盾）——已实测验证。
- LobsterAI 的签到**不需要签名**，只用 `Authorization: Bearer`；也**不发**腾讯系的
  `X-Domain` / `X-Product` / `X-Product-Code` 头。
- Trae CN 的签到用 `Authorization: Cloud-IDE-JWT`（另带两个等值 token 头）+
  `Origin` / `Referer` = `https://www.trae.cn`；**不发**任何腾讯系或 LobsterAI 归属头。

### 失败诊断的 logid 透传

失败时界面能给出「服务端原文 + 业务码」还不够：这两样只说「失败了、为什么」，
**说不出「这一次请求在服务端到底发生了什么」**。字节系网关为此在响应头返回
`x-tt-logid`（真机样本 `20260919142909176141A5DE791F4FE75E`），它是向服务端
追查单次请求的**唯一线索** —— 用户报障时给出这一串，服务端才查得到当时现场。

三段链路（缺一段这串就到不了用户眼前）：

| 段 | 位置 | 落点 |
|---|---|---|
| 1. 类型 | `src/credits.ts` | `ClaimOutcome` 失败分支新增**可选**字段 `logid?: string` |
| 2. 宿主 | `src/trae-cn-credits.ts` | `postJson` 读响应头 `x-tt-logid`（大小写不敏感、trim、空白视为没有），失败路径一路带到 `outcome.logid` |
| 3. 前端 | `plugin-src/client/jet-hub.js` | `formatClaimFailureLine` 在 logid 非空时追加 ` · logid <值>` |

几个刻意的取舍：

- **字段可选**：`ClaimOutcome` 是**三套协议共用**的判别联合，`logid` 必须可选，
  否则 Buddy 系与 LobsterAI 的 outcome 构造点全部要改（且它们根本没有这个值）。
- **只在失败分支**：成功路径不带该字段（没有追查需求）。
- **没有值就不带字段**，而不是 `logid: ''` —— 前端判「非空才追加」时两种都要挡住，
  但字段缺失能让「宿主压根没读到」与「读到了空串」在调试时区分开。
- **传输层失败（fetch 抛错）没有响应，因此没有 logid**：这是**如实缺失**，
  不是漏读 —— 请求根本没到服务端，也就没有服务端日志可查。
- **Buddy 系与 LobsterAI 未透传**：两条线的 `postJson` / `requestJson` 里
  `response` 对象虽然在手，但**没有任何已知的等价 logid 响应头**（未经真机确认）。
  按「不发明字段名」的既有约定**保持不动**；将来真机发现等价头再补。

想单独验证领取闭环（会真实改动账号当日签到状态）可运行
`pnpm test:e2e:buddy-claim` 或 `pnpm test:e2e:lobsterai-claim`，
说明见 `tests/e2e/README.md`。

## LobsterAI provider（有道龙虾）

独立路由 `lobsterai`（有道 **LobsterAI**），OpenAI 兼容端点
`https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions`，
Bearer `access_token` 鉴权。

该 provider 与腾讯系**协议完全不同**，因此实现是独立一套
（`src/lobsterai*.ts`），只共用架构模式（产品配置驱动、账号池、限流切换、
模型黑名单）。关键差异：

| 项 | Buddy 系（Buddy CN / Buddy） | LobsterAI |
|---|---|---|
| 登录方式 | 轮询后端 API（无本地服务器） | **本地回调服务器**收 `authCode` 后换 token |
| 登录/API 域名 | 同一个 `endpoint` | **两个域名**（portal 与 apiBase） |
| 请求头 | `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` | 仅 `X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version` |
| 续期请求体 | 只带 `refreshToken`（走 `X-Refresh-Token` 头） | 还要带 `firstKeyfrom` / `latestKeyfrom` / `uuid` |
| `clientVersion` | 编译期常量 | **运行时从第三方接口动态拉取** |
| 每日签到 | 两步（状态 + 领取） | **三步**（slot + context + check_in） |
| 图片输入 | 支持 | **不支持**（`inputModalities` 仅 `text`） |
| 思考等级 | 支持（按模型声明档位） | 支持（8/27 项声明档位，下发 `reasoning_effort`） |

- **登录入口：Account Hub 设置页的 LobsterAI 面板**（支持多账号与账号池自动切换）。
  不注册斜杠命令。
- 编程式调用：`ctx.lobsteraiAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()` / `resolveClientVersion()`。
- **登录是两段式非阻塞的**（2026-09 起）：Account Hub 点「+ 新建账号」时，
  RPC 只做 `prepareLogin()`（起本地回调服务器）并**立即返回 `loginUrl`**，
  由客户端在同一用户手势内开窗；登录在后台完成后才写凭据并补全账号字段。
  `login()` 保留为阻塞式便捷封装（会等到用户在浏览器完成，最长 10 分钟），
  供 e2e 探针等同步调用方使用。同一时间只允许一个进行中的登录会话，
  重复点击会拿到 `login-in-progress`。
- 凭据 ref：
  - 单账号：`LOBSTERAI_ACCESS_TOKEN`；
  - 多账号：`LOBSTERAI_ACCOUNT_<UUID_SHORT>`，由 Account Hub「+ 新建账号」生成。
- 凭据结构（JSON 字符串）：除 `access_token` / `refresh_token` / `expires_at` 外，
  还持久化 `uuid` / `first_keyfrom` / `latest_keyfrom` 三个**身份字段** ——
  它们是续期请求体的必填项，丢失会导致静默续期失败、只能重新登录。
- 模型列表：远端 `GET /api/models/available` 优先（它是权威来源），
  失败时回退 `src/lobsterai-product.ts` 的 **27 个内置模型**（2026-09-19 真机照抄）。
  ⚠️ **响应形状是「统一信封 + `data` 直接为数组」**（`{code:0,msg,data:[…]}`），
  不是 `data.data` —— 早期实现按 `data.data` 取值，而信封校验又拒绝数组，
  于是**恒返回空数组**、永远回退内置表，这正是「选择器模型比产品少」的根因。
- 续期：启动后每 30 分钟对可续期账号静默刷新（与其他 provider 同一调度器）。
  **终态判定比参考实现更精确**：只有 HTTP 401/403 或业务码 40100/40101
  才判为 `refresh_token` 失效；网络抖动走可重试路径，不会误让用户重新登录。

### 思考档位（reasoning effort）：**已接线**（2026-09-19 真机取证）

- **档位来源**：远端模型目录的 `thinkingConfig.options[].level`（权威），
  逐字符照抄为 `reasoningEfforts`。真机 27 项中 **8 项**带 `thinkingConfig`
  （`deepseek-flash` / `deepseek-v4-pro` / `glm-5.3` 系 3 项 /
  `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` / `glm-5.2`），
  档位均为 `high` / `max`；其余 19 项**不声明**（DSH 选择器里该行不渲染）。
- **下发字段名 `reasoning_effort`**，三条独立互证：
  1. **服务端行为**：只改该字段取值 —— `bogus-xyz` 与 `off` 返回 HTTP 500、
     `none` 返回 200 且无思考内容、`high`/`max` 返回 200 且带 `reasoning_content`。
     若服务端不解析该字段，未知取值不可能 500。
  2. **产品自身实现**：桌面端 `app.asar` 内 openclaw 的 `openai-completions`
     传输层在 `supportsReasoningEffort` 时写 `params.reasoning_effort`。
  3. `requestCapabilities: ['lobsterai-options-v1']` 对应的 `lobsterai_options`(v1)
     是**另一套**能力协商，不承载档位。
- ⚠️ **`off` 档被刻意剔除**：真机 `options` 里确有 `off`，但
  `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`
  发 `reasoning_effort:"off"` 会 **HTTP 500**（3/3 复现），而 `glm-5.x` 返回 200
  —— 同一档位跨模型行为不一致。等价关闭语义是 `none`（实测 200 且零思考），
  但真机 `options` 里没有 `none`，故**不自行发明档位**。
- **不替上游补档**：不带该字段时服务端照样返回 `reasoning_content`
  （默认档由服务端决定），故**不**照搬 buddy 的「deepseek 系必须补档」逻辑。
- **上下文窗口**用真机 `contextWindow`（14 项 1,000,000 / 2 项 262,144 /
  2 项 256,000），真机为 `null` 的 9 项**不声明**（不编造）。

> **已知待实测项**（见 `docs/lobsterai-integration-plan.md` §7.2）：
> 图片输入与 `prompt_cache_key`。这些在实现里取了**保守默认**（不发送），
> 不会因未知而失败。
> ⚠️ 思考档的**「档位是否真的改变思考量」尚未做统计显著实验**：单次对比
> （`high`/`max` 的 `reasoning_content` 字符数）被采样噪声淹没
> （同档 3 次重复的离散度大于档位间差异），故只声明「字段被服务端真实消费」，
> 不声明「档位单调提升思考量」。

## Trae CN provider（字节跳动 Trae 国内版）

独立路由 `trae-cn`，上游 API 基址 `https://api.trae.cn`（登录 / 续期 / 签到 /
余额），**IDE 网关** `https://trae-api-cn.mchost.guru`（`/api/ide/*`，即对话），
登录门户 `https://www.trae.cn`。

该 provider 与既有四条线**均不同源**，因此实现是独立一套 `src/trae-cn*.ts`，
只共用架构模式（产品配置驱动、账号池、限流切换、模型黑名单）。

| 项 | 腾讯系 | LobsterAI | **Trae CN** |
|---|---|---|---|
| 登录 | 轮询后端 API | 本地回调收 `authCode` → exchange | **本地回调 + PKCE(S256)，回调投递 `authCodeInfo`** |
| 换 token | 轮询结果自带 | `authCode` 换 access+refresh | **`POST /trae/api/v3/oauth/ExchangeToken`（body 五字段）** |
| 续期 | `X-Refresh-Token` 头 | `POST /api/auth/refresh` | **`POST /cloudide/api/v3/trae/oauth/ExchangeToken`（body 四字段）** |
| 鉴权 | `Bearer` + 归属头 | `Bearer` | **`Cloud-IDE-JWT`**（另带两个等值 token 头） |

> ✅ **登录协议已用真机校准（2026-09-17）**。三条独立证据一致：官方 `main.js`
> 源码只读提取（`buildLoginUrl` / `gDe` / `exchangeTokenByAuthCode` /
> `_buildDeviceInfo`）、本机**成功**登录日志
> `%APPDATA%\Trae CN\logs\20260917T045023\main.log:136/139/140/141`（登录 URL /
> 回调载荷 / exchange 请求体 / 响应体，四段逐字）、与授权页 chunk 的行为解剖。
> 此前「回调 query 直接携带 refreshToken、无 authCode 交换」的假设**已被整体证伪**：
> 真机走 PKCE。那套假设曾让登录**静默失败**（页面停在「认证中」），根因见下。

### 登录机制（两段式 + PKCE）

第一段起本地 loopback 服务器（随机端口），构造登录 URL（**22 个参数，逐项对齐
真机** main.log:136）：

```
https://www.trae.cn/authorization?login_version=1&auth_from=trae&login_channel=native_ide
  &plugin_version=2.3.83560&auth_type=local&client_id=ono9krqynydwx5&redirect=0
  &login_trace_id={uuid}&auth_callback_url=http://127.0.0.1:{port}/authorize
  &machine_id={64hex}&device_id={16位十进制}&x_device_id=…&x_machine_id=…
  &x_device_brand=&x_device_type=windows&x_os_version=Windows%2010%20Home&x_env=
  &x_app_version=3.3.100&x_app_type=stable
  &code_challenge={43字符}&code_challenge_method=S256&channel_name=common
```

**三个曾经写错的点，每一个都能单独让登录静默失败**（页面既不报错也不回调，
只在首屏显示「认证中」——从外部看完全像网络问题）：

1. **`client_id` 是 snake_case**。授权页只读 `client_id`，读不到就停在「认证中」
   （这就是用户报障的根因）。`src/trae-cn-product.ts` 的注释曾把这条写反
   （「URL 用 `clientID`」），现已显式写死两个方向防回归。
2. **缺流程标记** `auth_type=local` / `login_channel=native_ide` /
   `login_version=1`：授权页认不出本地回调模式。
3. **缺 PKCE**（`code_challenge` + `code_challenge_method=S256`）：授权页
   不会走 AuthCode 分支，我们也就拿不到 `authCodeInfo`。
   方法名是 **`S256`**，不是 CodeArts 那套 `SHA-256`。

`machine_id` 是 **64 位 hex**（生成随机即可，服务端不校验其真实性）；
`device_id` 是 **16 位纯十进制**。
> ⚠️ 这里说的 `device_id` 是**登录 URL 的那个**（`generateTraeCnDeviceId`），
> 形态要求来自**登录握手**。它与签到头的 `x-device-id`（凭据里的
> `BoundDeviceID`，服务端**不校验形态**）是**两个位置** —— 详见「Trae CN provider」
> 章节的「设备号在本项目里是两个位置」。
> 早先把「形态不符」的后果记成「会触发 9074 风控」是**归因错误**：`9074` 是
> **瞬时频次软限流**，与设备号形态无关。
`login_trace_id` 是本次登录的 UUID，回调把它原样带回，是「这次回调属于这次登录」的
现成凭证。

第二段：用户在浏览器完成授权后，登录页回调本地服务器，投递
**`authCodeInfo` + `userInfo` 两个双重编码的 JSON 字符串**（URL query 里再套一层
JSON），随后立即调交换端点换取 access token：

```
POST https://api.trae.cn/trae/api/v3/oauth/ExchangeToken
body {ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}   ← 五字段
```

⚠️ **交换端点有两套**，都在服务端并存，混用必 404：
登录用 `trae/api/v3/oauth/ExchangeToken`（鉴权靠 `AuthCode` + PKCE verifier，
body **不含** `ClientSecret` / `DeviceProof`）；续期用
`cloudide/api/v3/trae/oauth/ExchangeToken`（body 四字段，含 `ClientSecret`）。
真实响应是 `Result` 信封：

```json
{"ResponseMetadata":{…},
 "Result":{"BoundDeviceID":"wl2k1e2endpp32","DeviceBindStatus":"BOUND",
           "RefreshToken":"…","Token":"…","TokenExpireAt":1790801493459}}
```

`DeviceInfo` 是**真机 12 字段**（`DeviceID` / `MachineID` / `PlatformCode`
/ `DeviceType` / `DeviceName` / `DeviceModel` / `ClientVersion`
/ `DevicePublicKey` / `DeviceBrand` / `DeviceCPU` / `OSInfo` / `OSVersion`）。
本插件能如实提供的只有前四项与 `ClientVersion`/`OSInfo`/`OSVersion`；
`DeviceBrand`/`DeviceCPU`/`DeviceModel` **留空**（不猜硬件型号）。
`DevicePublicKey` 为 EC P-256 SPKI PEM，**每次登录现场生成**（官方 `vDe()`
同款）——曾因「该路径不发 DeviceProof」留空串，2026-09-18 真机实测 exchange
回 400 `10101 无效参数`，服务端至少校验其非空合法。
`DeviceName` 取主机名（真机取 `net.exe user` 的 Full Name）。

**回调分层**（畸形请求不得终结登录）：

| 请求 | 响应 | 对会话的影响 |
|---|---|---|
| 带 `authCodeInfo` / `refreshToken` 且交换成功 | **307 回跳授权页结果页**（`redirect=1`） | 结算（成功） |
| 带 `authCodeInfo` / `refreshToken` 但交换失败 | 500 纯文本 | 结算（交换失败） |
| `OPTIONS` 预检 | 204 + CORS 头 | 无 |
| 路径不符 | 404 + CORS 头 | 无 |
| 无载荷 / 畸形 | 400（不回显请求内容） | **无** —— 会话继续等真回调 |

早先实现把「解析不出凭据」当成登录失败（reject + 关端口），实测一次 500 探测
就终结了整个会话（端口关闭、占位账号被删），用户之后即使真的完成授权也无处回调。
现在只有「成功」「交换失败」「超时」「cancel」四种情况终结会话。

**成功回调是 307 回跳，不是静态 HTML**（对齐官方 `updateLocalCredential`）：
回调页停在 `127.0.0.1:{port}` 上自身无法离开（HTML 里没有 `window.close()`）。
弹窗被拦截、用户走面板内 `<a target="_blank">` 手动链接时客户端**没有窗口引用**，
`closeLoginWindow()` 够不到那张标签页 —— 307 回跳是唯一能把它送回
`www.trae.cn`（授权页渲染「登录成功」结果页）的机制。回跳目标是**同一条授权页
URL、只把 `redirect` 换成 `1`**（官方 `getLoginUrl(…, 1, …)` →
`buildLoginUrl` 里 `redirect=${r||0}` → `writeHead(307,{Location:a})` 逐字同构，
从本机 `%LOCALAPPDATA%\Programs\Trae CN\resources\app\out\main.js` 提取）。
**失败路径维持 500 纯文本**：官方失败分支会带 errorCode/errorMsg 回跳，而本插件
的错误码体系与官方不通用，回跳一个渲染形态无法保证的页面比明确的 500 更难查。

回调服务器**带 CORS 头**（`Access-Control-Allow-Origin: *` 与 OPTIONS 处理）：
官方实现里回调是整页跳转、同源策略不介入，但我们的登录页由客户端开窗，
一旦回调走 `fetch`/预检路径，缺 CORS 头会让浏览器**静默丢弃响应**
（表现为「登录页显示成功、宿主一直在等」）。

**兼容分支**：授权页是双模的 —— URL 不带 `code_challenge` 时它靠浏览器 Cookie
会话自己调 `GetRefreshToken`，回调投递 `refreshToken`。本实现**主发 PKCE**
（与桌面客户端同款、不依赖「浏览器里已登录 trae.cn」这个额外前置），回调侧
**两条都收**并把走了哪条写进日志。走兼容分支时没有 exchange 响应、也就没有
`BoundDeviceID`，凭据的 `device_id` **如实留空** —— 绝不拿 `machine_id` 折算
一个假的 16 位号顶上（伪造设备身份比缺字段更坏，缺字段至少能被发现）。

`prepareLogin()` 立即返回 `loginUrl`，由客户端在同一用户手势内开窗；
`login()` 保留为阻塞式便捷封装。

### 凭据（五件套，按账号整体配对）

| 字段 | 说明 |
|---|---|
| `refresh_token` | 刷新令牌（续期端点的 `RefreshToken`） |
| `user_id` | 用户 ID（续期端点的 `UserID`，**必填**，续期缺它只能重新登录；来源是回调 `userInfo.UserID`） |
| `client_id` | OAuth 客户端 ID（`ono9krqynydwx5`） |
| `device_id` | **登录 exchange 返回的 `BoundDeviceID`**（真机 `wl2k1e2endpp32`，14 位字母数字） |
| `machine_id` | 机器号（64 位 hex；登录 URL 用） |

- 单账号 ref：`TRAE_CN_ACCESS_TOKEN`；多账号：`TRAE_CN_ACCOUNT_<SUFFIX>`；
- access token 用法：`Authorization: Cloud-IDE-JWT <access>`，另带
  `X-Ide-Token` 与 `X-Cloudide-Token`（三个头同值）；
- 过期时间取 exchange 响应的 `TokenExpireAt`（服务端权威），缺失时回退 token 的 JWT `exp`；
- 续期：`POST /cloudide/api/v3/trae/oauth/ExchangeToken`，
  body `{ClientID, ClientSecret, RefreshToken, UserID}` —— `ClientSecret`
  实测为占位串 `"-"`，服务端不校验。
- 终态判定：HTTP 401/403 或响应缺 access token 才判 `refresh_token` 失效；
  网络抖动 / 5xx / 429 走可重试路径。

### 服务名与 provider 名的解耦

provider id 是 `trae-cn`（带连字符，对齐用户与生态叫法），但 cordis 服务名
**不是**机械派生的 `trae-cnAuth`，而是显式指定的 `ctx.traeCnAuth`
（见 `src/trae-cn-product.ts` 的 `serviceName`）。理由是带连字符的属性名
无法用点号语法访问，且与另外四个 provider 的命名风格不一致。

> ✅ **T5（回调 URL 形态）已用真机日志校准**（2026-09-17 main.log:136/139），
> 不再是候选表：参数名、编码形态、回调载荷结构（`authCodeInfo` / `userInfo`）
> 全部逐字确认，`device_id` 的来源也已查清（exchange 响应的 `BoundDeviceID`）。
> 旧的 `machine-id-fallback` 降级路径与 `aha` 来源标记已**删除**。
>
> ✅ **T9 已校准（2026-09-18）**：签到端点的 `x-device-id` 读的是凭据里的
> `device_id`（= `BoundDeviceID`），而真机实测 status / claim **都不校验设备号
> 形态** —— 16 位十进制号、`BoundDeviceID`、空串三者返回**逐字节相同**；
> **完全不带设备头**时才出现 `did_checked_in:false`（这恰好印证它是设备级语义）。
> 故照常取凭据值，**不要**拿 `machine_id` 折算一个假的 16 位号顶上
> （伪造设备身份比缺字段更坏）。`code:9004` 因此只可能意味着「服务端不认可我们
> 构造的设备身份」，此时按 `x-os-version` / `x-app-version` 的实测值校准。

### 模型路由（LLM 适配器）

路由名 `trae-cn`，适配器 `TraeCnAdapter`（`src/trae-cn-adapter.ts`），
随插件启动注册到 `ctx.llm`，同时注册 `llm-trae-cn` settings namespace ——
后者**必须**存在，否则模型设置页会在 `refFor → deriveKeyRef(provider)` 处崩溃。
注意该 namespace 里的连字符是**正确**的：namespace 是字符串键而非 JS 标识符，
与 cordis 服务名（`traeCnAuth`）走的是两套命名规则。

**端点**：`POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`
（**SOLO 通道**，2026-09-19 迁移，见下），请求头
`Cloud-IDE-JWT <access>` + 同值 `X-Ide-Token` / `X-Cloudide-Token` +
**网关全套头**（见下），`Accept: text/event-stream`；请求体是
`{messages, model, config_name, function, stream: true, tools?, reasoning_effort_level?}`，
**不发**任何腾讯系或 LobsterAI 归属头。

> ✅ **2026-09-19 端点迁移：`/api/ide/v1/chat` → `/api/agent/v3/llm_utils_chat`。**
>
> **病根（五轮真机取证定案）**：旧 `/api/ide/v1/chat` 是**旧 aiserver 通道**，
> 它的 `llm_raw_chat` 场景只认 **5 项旧池**，我方请求（`glm-5.3` 等新池模型）
> **恒回 `event:error {code:3003, "all models failed"}`**，历史零成功。
> 真实客户端的新池聊天走的是
> 「AhaRpc → ai-agent 子进程 → `harness.dll` → 原生出网」五段链路，
> 第三方无法复刻。
>
> **解法**：SOLO 通道 `/api/agent/v3/llm_utils_chat` **已用我方凭据实测走通**
> —— `glm-5.2` 流式正常、`glm-5.3` + tools 结构化调用全绿（HTTP 200 SSE）。
> host **不变**（仍是 `trae-api-cn.mchost.guru`），凭据不变，头集合差异已排除
> （网关对多余头宽容）。**决定成败的是端点 + body 的 `config_name` / `function`
> 两字段**。
>
> T6 那次「路径本来就对，错的是 host」的结论对**旧通道**仍然成立，但它解释不了
> 新池拿不到模型这件事 —— 两者是**两个不同层的问题**：T6 是 host 拼错，
> 本次是**端点选错了通道**。旧路径与候选表 `TRAE_CN_CHAT_PATH_CANDIDATES`
> 已**整体删除**（留着会让人以为 `/api/ide/v1/*` 仍是可选路径，它们对新池全部无效）。

**请求体的 SOLO 形态**（`buildTraeCnSoloBody`，逐字段实测）：

| 字段 | 说明 |
|---|---|
| `model` / `config_name` | **两个字段都要给，且恒等**（网关按 `config_name` 选配置） |
| `function` | **模型来源 function**：CN 区为 `solo_work_remote`（41 项）/ `solo_work_lite` |
| `messages[].content` | **`[{type:'text',text}]` 数组**（不是裸字符串） |
| `role:"developer"` | **归一为 `"system"`**（上游不认 developer） |
| assistant `tool_calls[].function` | **出站改名 `function_call`**（无 er；入站帧仍是 `function`，故解析侧不动） |
| `tools[].function.parameters` | **JSON 字符串**（传对象会 `4001 parameter type does not match binding data`） |
| `reasoning_effort_level` | **维持不变**（见下「思考档位」的说明） |

⚠️ **`function` 必须逐模型记住来源**：`glm-5.3` **只在 `solo_work_remote` 集里**，
写死 `solo_work_lite` 必回 `4001 param is invalid`（真机实测）。静态回退表的
11 项**全部**映射到 `solo_work_remote`（实测确认都在 remote 集内）；动态目录的
条目**自带**来源 function。

### ⚠️ `x-ide-version-code` 是 SOLO 网关的「选表键」（4001 的另一个根因）

**SOLO 网关按 `x-ide-version-code` 决定上游返回哪张模型配置表**。发旧 IDE 通道的
`107` 时，网关选出的是一张**空表** —— 后果不是「某个模型不可用」，而是**任何模型**
都回 `4001 param is invalid`。这是端点迁移后 chat 全败的**第二个根因**（第一个是
端点选错通道，见上），`bedd149` 当时假设「版本头维持现状即可」**是错的**。

实机验证过的**成功组合**（chat 端点，`glm-5.3-flash` 流式正常）：

```
x-ide-version-code: 20260820      ← SOLO 代际；**必须是 8 位日期式 YYYYMMDD**
x-ide-version:      0.1.61        ← SOLO 代际（不是 1.107.1）
User-Agent:         Trae/0.1.61   ← 与上面两个头同代际
```

- **值域**（目录端点值扫描）：只有 **8 位日期式**才命中非空配置表；`20260801` 起
  表已满 **41 项**，取证当日（`20260919`）同为 41 项；
- **只认 `x-ide-version-code`**：`x-app-version-code` 与选表**无关**（已隔离验证），
  但本实现让它与前者**同代际**，免得两个版本头自相矛盾；
- **两组版本码同名不同物，不可合并**（`src/trae-cn-product.ts` 里是**四个**独立
  常量）：`TRAE_CN_IDE_VERSION_CODE`（`107`）/ `TRAE_CN_IDE_GATEWAY_VERSION`
  （`1.107.1`）属 **IDE 网关代际**，`TRAE_CN_SOLO_VERSION_CODE`（`20260820`）/
  `TRAE_CN_SOLO_IDE_VERSION`（`0.1.61`）属 **SOLO 代际**。它们占同一个请求头，
  但**值域与语义都不同** —— 「顺手统一」就会把 chat 打回恒 `4001`；
- 历史旁证：第三方实现（traework2api 的 `constants.ts`）早有注释记着同一现象
  （「version-code 决定上游返回哪张模型配置表……拿 `20260716` 直接调 `glm-5.3`
  会 4001」）；
- ⚠️ **签到链路不适用**：`traeCnCreditsHeaders`（签到）的版本头**不动** ——
  它属另一条协议线，`x-app-version: 3.3.102` 已独立校准。

**网关必须带齐的请求头**（`request-traffic-type` / UA / 追踪头是 SOLO 通道的实测值）：

```
x-app-id:            6eefa01c-1036-4c7e-9ca5-d891f63bfcd8
x-ide-version-code:  20260820       ← SOLO 代际；选表键，发 107 会选出空表 → 4001
x-app-version-code:  20260820       ← 与选表无关（已隔离验证），同发只为不自相矛盾
x-ide-version:       0.1.61         ← SOLO 代际（旧 IDE 代际是 1.107.1）
x-ide-version-type:  stable
request-traffic-type: prod           ← SOLO 通道实测值（旧 IDE 通道是 normal）
x-plugin-channel:    icube-ai        ← SOLO 通道新增
x-request-id / x-trae-request-id: <同一个 UUID>
x-custom-trace-id:   <requestId 去横线后前 32 字符>
x-flow-traceparent:  04-<traceId>-<traceId 前 16>-01
x-uid:               <凭据的 user_id>
x-device-id:         <凭据的 device_id>   ← 与签到头同源
x-device-type:       windows
x-os-version:        <本机 os.version()，与签到头同源>
User-Agent:          Trae/0.1.61          ← SOLO 代际（旧通道是 TraeClient/TTNet）
```

追踪四头**同源**：`x-request-id` 是一个 UUID，`x-custom-trace-id` 是它去横线后的
前 32 字符，`x-flow-traceparent` 是 W3C 形态。生成一次、三处复用 —— 每处各生成
一个会让上游的调用链对不上；而**每次请求都必须是新的 id**（复用会把多次调用混成
一条链）。

注意登录 URL 的 `x_app_version`（`3.3.100`）与这些网关头**同名不同物、形态要求
还不同**：一个进 URL/请求体，一个进网关头。IDE 代际的两个常量
（`107` / `1.107.1`）**保留在源码里**，是为了让「107 从哪来」有据可查，并防止
后来者把两个代际「顺手统一」。`src/trae-cn-product.ts` 里现在是**四个**独立常量。

**SSE 不是 OpenAI 协议**。上游返回**具名事件**流，帧解析在 `src/trae-cn-sse.ts`
（SOLO 通道的帧格式与旧通道**逐字一致**，故解析器一字未改）：

```
event:metadata      data:{"conversation_id":…}      ← 忽略（`meta` 亦识别）
event:timing_cost   data:{provider_model_name:…}    ← 忽略
event:output        data:{"response":"片段"}         ← 正文增量
event:token_usage   data:{prompt_tokens,…}          ← usage
event:done          data:{…}                        ← 流结束
event:error         data:{"code":4008,"message":…}  ← 失败（HTTP 仍为 200）
```

事件名同样取自本机客户端字符串池：Rust 侧
`…/adapter/llm/event.rs` 有一份权威事件类型清单，每个变体都带一条
`Failed to deserialize <name> event` 诊断串（实测提取到 22 条）。
`tool_calls[].function_call`（无 er）是**出站改名**，入站帧里仍是 `function` ——
故解析侧不需要任何改动。

**错误分类按业务码，不按 HTTP 状态码**（`src/trae-cn-errors.ts`，纯函数）：

| 动作 | 业务码 | 说明 |
|---|---|---|
| **换号** | `4008` `4021` `5003` `977`（限流）、`4200`–`4203`（额度）、`1001` `1002` `4010` `4014`（账号失效）、`4011` `4013` `4015`（风控） | 对齐官方 `isSecurityError` 语义：账号失效与风控同样换号 |
| **退避不换号** | `4007` `3004` `9074`（软限流）、**`3003`（MODEL_FAIL，基础设施类）**、`4000005` `4050`–`4052`（排队） | 排队与基础设施故障都是**全局**状态，换号只会把同一个问题再问一遍并多烧一个账号的额度 |
| **直接报错** | `4001`（参数）、`4006`（超长）、`4023`（模型不存在） | 确定性失败，换号与退避都是浪费往返 |
| **直报（带原始码）** | 其它未知码 | 保守默认：未知码可能是终态（积分耗尽的真实码 T3 尚未实测到），直报能让真机第一次遇到就把码暴露在文案里，一步校准 |

`3003`（`MODEL_FAIL`，`all models failed`）是**端点迁移取证时补入**的：它正是旧
IDE 通道对我方新池请求的恒定回复。归**可重试**（退避）而非直报，是因为它明确是
基础设施/容量类的瞬时失败，退避后可能就好了；同时它**不换号**（与具体账号无关），
也**不记冷却徽章**（不是账号级的模型限流）。

非 200 的 HTTP 失败（网络层/网关）走兜底：`401`/`403` → 换号，`429`/`408`/`5xx` → 退避，
其余直报。`4006` 映射为 `CONTEXT_WINDOW_EXCEEDED`（触发 DSH 上下文自动压缩），
换号与退避都映射为可重试的 `RATE_LIMIT`。

> ⚠️ **绝不允许把流内错误转成优雅关闭**：`event:error` / `code >= 4000` 必须把
> 业务码**直报**给 DSH。转成优雅关闭会让 DSH 报「Stream ended without
> finish_reason」，真因永远丢失（`dsh-connect-trae` 的教训）。

**结构上与 LobsterAI 的根本差异**：Trae 的业务失败发生在 **HTTP 200 的
`event:error` 帧**里，所以换号循环必须能接住**流内**失败 —— LobsterAI 的错误
全在 `!response.ok` 分支，流一旦开始就没有换号的余地。换号上限同 LobsterAI
（3 个账号，含首次）。若流已经开始产出正文才报错，则**不再换号**（换号会让用户
看到「半截回答 + 完整回答」两段内容，比直接报错更糟），改为直报。

**模型目录 = 动态 `get_detail_param`（权威）+ 静态 11 项回退**（2026-09-19 起）。

| 项 | 值 |
|---|---|
| 端点 | `POST /api/ide/v1/get_detail_param`（同一网关，与 chat **同源凭据与头**） |
| body | `{function, config_names:null, need_prompt:false, current_config_info:null, poly_prompt:true, mode_type:null, agent_type:null}` |
| function | CN 区**两个都拉**：`solo_work_remote`（优先）与 `solo_work_lite`，取并集 |
| 解析 | `config_info_list[].config_name` / `display_config.display_name` / `model_detail_list[0].prompt_max_tokens`（回退 `context_window_tokens.dev`）与 `.max_tokens` |
| 缓存 | 12h TTL（参照 LobsterAI 的 `clientVersion` 缓存先例）；**失败不写缓存**，下次调用重试 |
| 回退 | 目录整体不可用 → 现行 11 项静态表（`TRAE_CN_FALLBACK_MODELS`） |

> ✅ **推翻 2026-09-18 的「远端不可接」结论**：那条结论**是对的，但试错了端点** ——
> `model_list` 只回 6 项旧池、`batch_get_detail_param` 只回 4 个 seed 配置。
> 真正可用的是 `get_detail_param`，且**必须按 `function` 分别拉取后取并集**：
> roster 被 Trae 摊在多个 SOLO function 下（`glm-5.3` 只在 `solo_work_remote`）。

**目录过滤规则**（`src/trae-cn-models.ts` 的 `mergeTraeCnDirectory`）：

1. **remote 优先**：同名 id 以先到的 function 为准（顺序即优先级）；
2. **remote 成功时剔除 lite 独有项** —— 实测「用户可调的项要么两个 function
   都在集、要么 remote 独有」，故**只在 lite 出现**的项就是内部 agent 项；
3. **内部项过滤两道网**：点名（`summary` / `file_search_agent` /
   `explore_sub_agent_v2` / `browser_use_subagent` / `computer_use_subagent`）
   + 形态（id 里含 `agent` / `subagent`）。现存 11 项**一个都不命中**该形态，
   故不会误杀用户可调的模型；
4. **刻意不接 remote 骨架合并**：把远端独有项也列出来会引入 `join` 不到的不可调项
   （如旧表里的 `Doubao-Seed-Code`），选中即路由失败；
5. **多模态标记由静态表补齐**（目录端点不带该字段）：只对**静态表已有的 id** 补值、
   **不新增条目**。不补的话，动态目录一旦生效，支持图片的模型会全部变成纯文本
   —— 同一模型在「目录成功」与「目录失败」两条路径下报出不同模态，是自相矛盾。

**静态回退表（11 项）**：

> ⚠️ **为什么是 11 项而不是真机目录的 16 项**（2026-09-19 二次取证）：
> 原表 16 项录自**旧 IDE 通道**的 `chat_v3` 目录；chat 迁到 **SOLO 通道**后，
> 该通道 roster 的 **41 项**里**没有**下面这 5 项，故它们**调不了**：
>
> | 剔除的 id | 展示名 |
> |---|---|
> | `Doubao-Seed-Code` | `Seed-Code` |
> | `glm-5.3-flash` | `GLM-5.3-Flash` |
> | `deepseek-v4.1-flash` | `DeepSeek-V4.1-Flash` |
> | `kimi-k2.8-preview` | `Kimi-K2.8-Preview` |
> | `qwen3.8-flash` | `Qwen3.8-Flash` |
>
> 理由不是「表要精简」，而是**本 provider 只走 SOLO 通道**（IDE 通道已由五轮真机
> 取证定案废弃）。回退表里留着 SOLO 调不了的 id，唯一效果是**在模型选择器里产出
> 必然 `4001` 的选项** —— 用户选中即失败，且失败原因（选表键/代际不匹配）与模型
> 本身无关，极难自行诊断。动态目录成功时本来也不会列出它们，故剔除后两条路径的
> 目录**首次一致**。
>
> 注意 `Doubao-Seed-Code` 的剔除**只针对本 provider**：它在
> `trae-cn-work`（`solo_agent_remote` 代际）里是**默认模型**，两张表互不影响。

| id | 展示名 | 多模态 | max_tokens | 上下文（dev/max） |
|---|---|---|---|---|
| `Doubao-Seed-Evolving` | `Seed-Evolving` | ✓ | 64000 | 262144/1048576 |
| `Doubao-Seed-2.1-Pro` | `Seed-2.1-Pro-0915` | ✓ | 64000 | 262144/1048576 |
| `Doubao-Seed-2.1-Turbo` | `Seed-2.1-Turbo` | ✓ | 32000 | 262144 |
| `glm-5.3` | `GLM-5.3` | ✗ | 64000 | 119040/1048576 |
| `glm-5.2` | `GLM-5.2` | ✗ | 64000 | 119040/1048576 |
| `DeepSeek-V4-Flash-Official` | `DeepSeek-V4-Flash 正式版` | ✗ | 64000 | 119040/1048576 |
| `DeepSeek-V4-Pro-Official` | `DeepSeek-V4-Pro 正式版` | ✗ | 64000 | 119040/1048576 |
| `kimi-k3` | `Kimi-K3` | ✓ | 64000 | 204800/1048576 |
| `minimax-m3` | `MiniMax-M3` | ✓ | 64000 | 119040/1048576 |
| `qwen3.8-max` | `Qwen3.8-Max` | ✓ | 64000 | 204800/1048576 |
| `qwen-3.7-plus` | `Qwen3.7-Plus` | ✓ | 64000 | 204800/1048576 |

来源：真机 `chat_v3` 模型目录（2026-09-18），由 Trae 客户端 **vscdb 缓存**与
**160 处日志事件**互证；id / 展示名 / 多模态标记 / max_tokens / 窗口**逐字符**照抄。
id 形态极不规则（`qwen-3.7-plus` 带连字符、`minimax-m3` 全小写）——**任何规整化
都会让请求打到不存在的模型上**，故原样保留。

⚠️ 该表现在是**回退表**（不再是唯一目录），但它仍是**唯一**记录「多模态标记」的
地方：目录端点不带该字段，故动态目录生效时由 `applyTraeCnStaticModalities` 按 id
把标记补回来（只补不增，见上「目录过滤规则」第 5 条）。

- 上下文窗口取 **dev 档**（如 `262144/1048576` → 262144）：它是客户端默认实际
  使用的窗口。max 档（多数 1048576）是理论上限，按它声明会让 DSH 的上下文压缩
  迟迟不触发；动态目录同口径取 `prompt_max_tokens`（回退 `context_window_tokens.dev`）；
- `inputModalities` **按模型给**：多模态项（原 16 项里 12 项、**现存 11 项里 7 项**
  —— 被剔除的 5 项恰好全是多模态项）输出 `['text','image']`，其余 `['text']`。
  `listModels` 与 `resolveModel` 读的是同一个 `supportsImages` 字段，两处口径强制
  同源（不一致会让选择器与请求路径自相矛盾）；
- `maxTokens` **只记录不 materialize**：DSH 的 `defaultMaxTokens` 会在调用方未给
  上限时自动填进请求体，而本仓库另外四个 provider 一个都没设该字段 ——
  由适配器替用户决定输出上限是行为变更，不在本次范围内。
- **消耗倍率不再解析**：旧实现会从 `display_contact_config.consumption_rate.data.rate`
  读出倍率但不展示（DSH 的 `LlmModelInfo` 没有放自定义元数据的位置，塞进
  `description` 会污染选择器文案）。新的目录解析器**不读它** —— 读出来没有任何
  落点，留着只会让人以为它被用上了。

**思考档位（reasoning effort）已接线**：原 16 项里 13 项声明档位、现存 11 项里
**8 项**声明，另 3 项（`minimax-m3` / `qwen-3.7-plus` / `Doubao-Seed-Evolving`）
刻意不声明（被剔除的 5 项恰好全都有档位）。

- 档位数据来自真机 **vscdb 缓存**（`User/globalStorage/state.vscdb` 的
  `reasoning_effort_config{support_thinking, options, default_level}`，
  2026-09-18 只读提取）。两套模型池各有一份：**`chat_v3`（IDE 对话，即本插件
  走的路径）** 与 `solo_agent`（SOLO）——本插件取 **`chat_v3`** 那套。两者档位
  集合相同，但默认档不同（如 `glm-5.3` 在 chat_v3 是 `high`、solo_agent 是
  `extra_high`），**不可混用**；
- 档位 id **逐字符照抄**（`light` / `high` / `extra_high`，**不是** buddy 系的
  `low`/`max`/`xhigh`）。DSH 的 `ReasoningEffortId` 是 branded string、
  **不校验取值**，改写会让请求里的档位与上游对不上。展示名对齐 Trae 客户端中文
  文案（轻 / 高 / 极高）并附英文原词；
- 默认档照抄真机 `default_level`：多数为 `high`，**`kimi-k3` 是 `extra_high`**
  （同族的 `kimi-k2.8-preview` 也已随 5 项 SOLO 不可调 id 剔除）；
- 不声明 `reasoning` 的模型在 DSH 模型选择器里显示「当前模型未提供推理等级」
  ——那是**唯一**数据源（`resolveModel().reasoning`），不声明时该行根本不渲染。

**下发字段名是 `reasoning_effort_level`，不是 `reasoning_effort`**（2026-09-18 定案）。
官方客户端的 `ai-modules-chat` bundle 里，`resolveReasoningEffortRequestField`
默认产出 `reasoning_effort_level`，只有**字节内网账号**（`scope===BYTEDANCE`）
才走 `reasoning_effort`；本插件用的是普通国内账号，故取前者。`ai_agent.dll` 的
serde 字段块里两者**并列存在**，印证这是「两套账号体系各用一个」而非猜测。

> ⚠️ **端点迁移后仍然不改这个字段名**（2026-09-19 的决定，刻意为之）：
> SOLO 通道的第三方可用实现下发的是 `reasoning_effort`，但那是 **SOLO 代际**的
> 写法，**未做 A/B 验证**。在拿到「同一请求两种字段名哪个真生效」的对比证据之前
> 不盲改 —— 那是把一条有证据的结论换成一条没有证据的猜测。值域
> `light` / `high` / `extra_high` 同样不变。

> ⚠️ **已知未验证项**：上游是否**真的按档位改变思考**尚未做对比实验。真机
> A/B **无法**用「是否报错」区分两个字段名 —— 测试账号在带与不带档位时都回
> `code:4008`（配额），字段校验阶段被 4008 掩盖（该账号在
> `pay/web_user_ent_usage` 上仍显示通用池 2650 积分，故 4008 不是「余额为 0」，
> 但也不是可用来判定字段名的信号）。字段名本身由上述静态证据三方互证定案；
> 「档位是否生效」需一次能跑通的对话来对比 `reasoning_content` 长度。

> ℹ️ **远端目录项的档位**：`get_detail_param` 的条目若带
> `reasoning_effort_config`（`support_thinking:true` + 非空 `options`），同样会被
> 声明；**没有该字段就不声明** —— 不编造档位。`default_level` 不在 `options` 内时
> **只丢默认档、保留档位列表**（上游发出不自洽组合时用户仍能手动选档）。

**旧「为何不接远端模型目录」的实测表仍然有效，但它只说明那三个端点不可用**
（2026-09-18 三端点实测结论）：

| 端点 | 实测结果 |
|---|---|
| `model_list`（`{"type":"chat"}` + 完整网关头） | 只回 **6 项旧池**（Doubao-1.5 代） |
| `batch_get_detail_param` | 只回 **4 个 seed 配置** |
| 其余约 200 种形状组合 | 18 项新池**一个都不出现** |

**`get_detail_param` 不在那张表里，它是可用的**（见上「模型目录」小节）。
旧实现据此写下的「`fetchRemoteModels` 刻意不接线、静态表即正解」**已作废**；
旧的容忍式解析器 `parseTraeCnModels`（从 `data`/`models`/`model_list` 等候选键里
猜数组）与它配套的 `TraeCnRemoteModel` 类型**已整体删除** —— 现在只读实测路径
`config_info_list`，不做信封猜测：上游真改版时，一个**空目录**（回退静态表，
用户仍能用）比「猜对形状但读错字段」的半成品更容易诊断。

4 个旧死 id 的下落：`qwen3.7-max` **已下线**；`deepseek-v4-flash` /
`doubao-seed-2-1-pro` / `MiniMax-M3` 是拼写或大小写错误的**近似形态**
（真机分别是 `deepseek-v4.1-flash` / `Doubao-Seed-2.1-Pro` / `minimax-m3`；其中
`deepseek-v4.1-flash` 已随 SOLO 不可调 id 一并剔除）。
真机目录里**没有** `deepseek//deepseek-chat` 与 `deepseek//deepseek-reasoner`
—— 那是账号自定义的 BYOK 条目，不属云端目录，已排除。

**表外模型的 `4001` 有可读提示**（`src/trae-cn-adapter.ts` 的 `withOffCatalogHint`）：
`4001 param is invalid` 在本 provider 上有**两个完全不同的成因**，而上游文案一模
一样 —— 一是**模型不在可用目录里**（用户手输的 id、或历史会话里被剔除的旧 id，
如 `glm-5.3-flash`），解法是**重选模型**；二是**请求形态问题**（参数类型/body
字段），解法是改代码。不区分的话，用户只会以为插件坏了。故在 `4001` 且
**模型不在当前目录**（判定与 `function` 路由同源，同一个 `catalogEntries()`）时，
错误文案追加一句「（该模型已不在 Trae CN 可用目录中，请在 Hub 的显示列表里重选）」。
其它错误码**不加**：`4023`（模型不存在）上游自带语义、文案已够清楚。

**与其它 provider 一致的约定**：`stream()` 把 `options.model` 传给
`resolveCredential` 与 `refresh`（硬约定，见「账号池与多账号」）；
`listModels()` 实时读 `pool.disabledModelsFor('trae-cn')` 应用黑名单；
**声明** reasoning 档位（现存 8/11 项，真机 vscdb；下发字段 `reasoning_effort_level`，
仅透传调用方显式传的值、不主动补档 —— 补档由 DSH 按 `defaultEffort` 完成）。
目录拉取本身**不传 model**（目录对所有模型一致，不做逐模型限流过滤）。

> ⚠️ **图片输入有意不一致**：目录照实报 `['text','image']`（那是**模型**的能力），
> 而 `stream()` 仍对图片块抛 `UNSUPPORTED_CONTENT`（那是**本适配器**的能力 ——
> `serializeTraeCnMessages` 只展平文本块，没有把 image 块编码成上游要的形态）。
> 正常调用到不了那道抛错：DSH 会按 `inputModalities` 在路由层把图片投影成文本
> 占位（`projectImagesForTextModel`）；抛错是防「绕过路由层直接调 `stream()`」
> 的最后一道防线。两处**不要「顺手」改成一致**。

### 签到与积分余额

实现是独立一套 `src/trae-cn-credits.ts`（协议与 Buddy 系、LobsterAI 都不同），
三个 RPC 端点在同一处按 provider 分发（`src/jet-hub-rpc.ts`）。

**端点与请求体**（host `https://api.trae.cn`，鉴权 `Cloud-IDE-JWT`）：

| 用途 | 端点 | body |
|---|---|---|
| 签到状态 | `POST /trae/api/v2/ug/checkin_credits/status` | `{"req_source":1}` |
| 签到领取 | `POST /trae/api/v2/ug/checkin_credits/claim` | `{"req_source":1}` |
| 积分余额 | `POST /trae/api/v2/pay/web_user_ent_usage` | `{"require_usage":true}` |

**请求头**（除三个鉴权头外）：

```
Origin:  https://www.trae.cn
Referer: https://www.trae.cn
x-device-id:   <凭据里的 device_id（= 登录 exchange 的 BoundDeviceID）>
x-device-type: windows
x-os-version:  <本机 os.version() 的运行时取值，如 Windows 10 Home>
x-app-version: 3.3.102
```

- 设备四件套是 **claim 的硬要求**，缺失时服务端回 `code:9004`。
  `x-device-id` **取自凭据**（`device_id` 字段），不是登录 URL 里那个随机生成的
  16 位号 —— 后者只参与登录握手，不是设备身份。
  ✅ **T9 已校准（2026-09-18）**：设备**号形态**不被校验（16 位十进制号 /
  `BoundDeviceID` / 空串全回 `code:0`），只有**完全不带设备头**才 `did_checked_in:false`；
- ⚠️ **`x-os-version` 是运行时值**（2026-09-19）：真机客户端发 `os.version()`
  的返回值（带品牌名的市场营销名），故本插件同样在运行时取 `node:os` 的
  `os.version()`，不再硬编码构建号。`x-app-version` 同步升到 `3.3.102`。
- `Origin` / `Referer` 取编译期常量 `product.portalBase`，**不从凭据推断**
  （与 `X-Domain` 那条约定同因）；
- `req_source:1` 照抄**唯一次实测成功**的组合。✅ **T1 已校准**：带与不带服务端返回
  **逐字节相同**，它不是 9004 的成因；保留它只因为成本是零。

#### 「设备号」在本项目里是**两个位置**（2026-09-19 澄清，消 T9 矛盾假象）

「设备号」一词曾被同时用在这两个字段上，于是产生了「T9 说不校验形态、别处却说
形态不符有风险」的矛盾假象 —— 它们说的是**两个不同的字段**：

| 位置 | 取值 | 形态要求 |
|---|---|---|
| **登录 URL 的 `device_id`**（`src/trae-cn-oauth.ts` 的 `generateTraeCnDeviceId`） | 登录时现场生成的随机号 | **必须 16 位纯十进制**（登录握手的形态要求） |
| **claim 的 `x-device-id`**（`src/trae-cn-credits.ts`） | 凭据里的 `device_id`（= exchange 返回的 `BoundDeviceID`） | **不校验形态**，静默可用（T9 实测） |

本文档前面「`device_id` 是 16 位纯十进制」讲的是**登录 URL 那个**。

另外修正一处**归因错误**：早先注释把「设备号形态不符」的后果记成「会触发 9074
风控」。`9074` 是**瞬时频次软限流**（同账号隔一会儿重试即成功，见
`src/trae-cn-errors.ts` 的软限流码表），与设备号形态无关；保留登录 URL 的 16 位
形态的理由是**登录握手的形态校验**。

#### 两处与真机不同但**刻意不改**的（防「顺手统一」）

反混淆真机客户端后确认 claim 还有两处与我们不同，**刻意保留**：

| 项 | 真机 | 本实现 | 不改的理由 |
|---|---|---|---|
| `x-device-id` | AHA/iCube SDK 的 16 位号 | 凭据的 `BoundDeviceID` | (a) 服务端**不校验形态**（T9 实测 `BoundDeviceID` 拿到 `code:0`）；(b) 伪造 16 位号是 `README.md` 明令禁止的「伪造设备身份」；(c) 读 Trae 客户端 `storage.json` 是跨产品耦合，其 schema 不受本插件控制 |
| `X-Ide-Token` / `X-Cloudide-Token` | 未逐字确认 | 保留 | 签到不需要（三选一即可），但 **chat 网关可能依赖**（未验证）；`traeCnAccessHeaders` 是签到与 chat **共用**的构造器，去头风险大于收益 |

⚠️ **本次「身份保真」修复不是 `9074` 的解药**：`9074` 已由真机实证为**瞬时频次
软限流**（同账号隔一会儿重试即成功），与设备身份形态无关。改 `x-os-version` /
`x-app-version` 是为了让出站身份与真实客户端一致，消除「服务端按身份归因/风控时
看到的是一个不存在的客户端形态」这类隐患。

**幂等判据是 `checked_in`（账号级当日）**，`did_checked_in` 是**设备级**语义
（换设备仍为 false），**不要用**。领取流程自身先查状态、已领则短路，
故 RPC 分发处传 `precheckStatus: false`（对齐 LobsterAI 的多步流程）。

**失败时透传服务端 logid**：claim / status 失败若响应头带 `x-tt-logid`，它会被
带到 `outcome.logid` 并在 Account Hub 的失败行末尾显示 ` · logid <值>` ——
这是向服务端追查单次请求的唯一线索。三段链路与取舍见前面的
「失败诊断的 logid 透传」。

**余额按 `available_endpoint` 分池**：

| 池 | `available_endpoint` | 返回字段 | 展示 |
|---|---|---|---|
| 通用积分 | `0` | `total` | **主数字**（本插件能实际用掉的就是它） |
| Work 积分 | `1` | `workTotal` | 单独一项（如「通用 154.22 / Work 2000」） |

**Work 积分的准确口径**（取代早先「chat 只扣通用池」的简写）：

- **Work 专属积分只在 TraeWork 里能花**（`work.trae.cn` 网页版 / 桌面版）；
- **TraeCode / IDE 对话只消耗通用积分** —— 也就是本插件走的那条路径；
- 在 TraeWork 中两类积分按**到期时间先后**扣，Work 专属**仅在到期时间相同时**优先；
- **2026-09 起签到发的是通用积分**（不是 Work 专属）。

**两池绝不合并成一个数**：合并会让用户以为 Work 的额度可以用来对话，
从而对「明明显示还有 2000 却说余额不足」感到莫名其妙。返回类型是
`CreditBalance` 的**超集** `TraeCnCreditBalance`（多出 `pools` 与 `workTotal`），
故 `collectCreditBalances` 能直接复用；非通用池的包名在 `packages` 里带
`[Work 积分]` 前缀，避免明细里那个 2000 看起来像通用额度。

> ✅ **UI 已消费 `workTotal`**：`CreditBalanceRow` 在该字段存在且可解析时渲染
> 「通用 X / Work Y」两段，Work 用弱化色且**绝不与通用相加**。其余 provider 的
> 余额对象没有该字段，渲染逐元素不变（`tests/unit/jet-hub-credit-balance-row.spec.ts`）。
> 改动前端后必须 `pnpm build:all` 重建客户端 bundle 才生效。

**判定一律以 body `code` 为准，不看 HTTP 状态**（对齐 Buddy 系既有约定）：
无 auth 时服务端返回的是 **HTTP 200 + `code:1001` + `enable:false`**，按状态码判
会把它当成成功。`code:1001` 在两个端点上的文案统一为「凭据已失效，请重新登录」。

> ✅ **T7 已按真机校准（2026-09-18）**：该端点响应**没有 `code` 信封** ——
> 顶层是 `{"is_credits_billing":…,"usage_summary":{…},"user_entitlement_pack_list":[…]}`
> （沿用 code 信封会让余额**恒失败**，与「余额为 0」无关）。礼包数组在**根层**
> `user_entitlement_pack_list`；额度嵌在
> `entitlement_base_info.product_extra.package_extra.quota.credits_limit`
> （回退 `entitlement_base_info.quota`），**余额 = `credits_limit` −
> `usage.credits_amount`**（`usage` 可为 `{}`，按「该包未产生用量」计 0）；
> `available_endpoint` 也在 `entitlement_base_info` 里（不在条目顶层）。
> 候选表（`TRAE_CN_BALANCE_ARRAY_KEYS` / `_REMAIN_FIELDS`）、指纹扫描与三级回退链
> **全部保留作兜底**，但主路径是上述嵌套口径。真机样例：endpoint=0 包
> limit 2000 / consumed 2000 → 通用池 **0**；endpoint=1 包 limit 2000 /
> `usage:{}` → Work 池 **2000**。
>
> ⚠️ **T8 仍待校准**：领取响应里「本次获得积分」的字段名
> （`TRAE_CN_CLAIM_CREDIT_FIELDS`），未命中时按 0 计并输出一行**只含字段名、
> 不含值**的日志。status / claim 的其它逻辑真机全通，未动。
>
> 两处的调试出口是 `TraeCnCreditsOptions.onDebug`，在 RPC 分发处接到
> `ctx.logger.info`（**看宿主日志，面板上看不到**），输出一律只有键名与结构判定。

## Trae CN Work provider（TraeWork 网页协议）

`trae-cn-work`（显示名 **Trae CN Work**）是 Trae CN 的**第二条路径**：
走 **TraeWork（`work.trae.cn`）网页 RPC**，消耗 **Work 专属积分池**
（`available_endpoint=1`）。

### 为什么需要它：两个池、两套模型、两条协议

Trae CN 账号的积分**分两个互不通用的池**，而**只有 Work 池能在 TraeWork 里花**
（见上文「余额按 `available_endpoint` 分池」）。IDE 路径只扣通用池，因此当
**通用池耗尽而 Work 池仍有额度**时，IDE 路径必回 `4008`，而 Work 路径正常扣费 ——
两条路径的可用性**互相独立**。

| | `trae-cn`（IDE 路径） | `trae-cn-work`（本 provider） |
|---|---|---|
| Host | `trae-api-cn.mchost.guru`（IDE 网关） | `work.trae.cn`（同源网页 RPC） |
| 网关头 | 必须带齐 `x-app-id` / 日期式 `x-ide-version-code` 等全套 | **不需要**，仅鉴权三头 |
| 请求形态 | 单次 `POST /api/agent/v3/llm_utils_chat`（无状态） | **三段式**（建会话 → 发消息 → 订阅 SSE） |
| 模型池 | 动态 `get_detail_param`（回退 11 项静态表） | **14 项 `solo_agent_remote`，id 与 IDE 池完全不重合** |
| 扣费池 | 通用积分（`endpoint=0`） | **Work 专属（`endpoint=1`）** |
| 思考档落点 | 请求体**顶层** `reasoning_effort_level` | **`custom_model` 对象内部**同名字段 |
| 会话清理 | 无状态，无需清理 | **每轮 DELETE** |

> **两个池的模型 id 完全不重合**（只有 `Doubao-Seed-Code` 同名，且上下文窗口不同），
> 这是「两个 provider 而非一个带开关的 provider」的直接理由 —— 合并目录会产生
> 无法路由的条目。

**选择指引**：通用池有额度、要用 IDE 那套模型 → 选 `Trae CN`；
通用池耗尽或想用 Work 的额度 → 选 `Trae CN Work`。

### 账号与凭据：**复用 Trae CN**（本 provider 唯一的非常规接线）

Work **没有独立登录** —— 它用**同一批 Trae CN 账号**（`TRAE_CN_ACCOUNT_*`）、
同一份凭据、同一套限流切换。故本 provider **不注册独立 auth 服务**。

⚠️ 由此产生一处**必须分开、且两个方向的错误都是静默的**接线：

| 用途 | 取值 |
|---|---|
| 注册到 `ctx.llm` 的路由名 / settingsNs / 模型黑名单 | `trae-cn-work` |
| **账号池查询**（`getAvailableAccount` / `findAccountIdByCredential` / `updateModelRateLimit`） | **`trae-cn`** |

- 池查询若用 `trae-cn-work`：账号条目的 `provider` 字段是 `trae-cn`，
  **一个都匹配不到** → 适配器每次都抛 `MISSING_CREDENTIAL`（「请先登录」），
  而账号明明在列表里；
- 路由名若用 `trae-cn`：本 provider 根本不会出现在模型选择器里。

两个方向都**不报错**，只是查不到/不出现。该值由
`TraeCnWorkProduct.poolProviderId` 显式承载（与 `id` 并列命名，防止被「顺手统一」）。

### 协议配方（**全部真机实测**，2026-09-18）

三段式，host 恒为 `https://work.trae.cn`，鉴权与 IDE 路径相同
（`Authorization: Cloud-IDE-JWT <access>` + 同值 `X-Ide-Token` / `X-Cloudide-Token`）：

| # | 请求 | 关键点 |
|---|---|---|
| 1 | `POST /api/remote/v1/chat_sessions`，body `{"mode":"code"}` | → `{"code":0,"data":{"chat_session_id":"…"}}` |
| 2 | `POST /api/remote/v1/chat_sessions/{sid}/messages` | body 见下 |
| 3 | `GET /api/remote/v1/chat_sessions/{sid}/events?reply_to_message_id={mid}` | `Accept: text/event-stream` → SSE |
| — | `DELETE /api/remote/v1/chat_sessions/{sid}` | **每轮收完必调** |

发消息 body（官方 `buildSendMessageRequest` 逐字）：

```json
{"chat_session_id":"…","content":[],"query":"[{\"type\":\"text\",\"data\":{\"content\":\"hi\"}}]",
 "model_name":"Doubao-Seed-Code","agent_type":"solo_agent_remote","agent_id":"solo_agent_remote",
 "model_selection_strategy":"manual","origin":"web"}
```

- `query` 是 **JSON 字符串**（不是数组），元素形态 `{type:"text",data:{content}}` ——
  注意是 **`data.content`**，与 IDE 路径的 `text_content` 不同；
- `agent_type` / `agent_id` / `model_selection_strategy` / `origin` 是**出站身份标识**，
  服务端按它们归因 agent 形态，一个字符都不能动。

### 会话生命周期：每轮自建自删

每次 `stream()` 调用 = **建会话 → 发消息 → 订阅 → 收完 → DELETE**，删除在
`finally` 里且**失败仅告警不抛**。

- **为什么必须删**：Work 的会话会在云端拉起**沙箱**（真机
  `platform_timing.sandbox_name` 形如 `run-agent-<sid>-xxxx`），且会话会出现在
  用户的 TraeWork 列表里 —— 每问一句就往用户列表塞一条是很糟的副作用；
- **为什么删除失败不抛**：用户要的是回复，会话残留是**副作用**而非本次请求的
  失败原因；把清理失败变成用户可见错误，会让一次成功的对话因收尾问题报错；
- **`finally` 覆盖整次尝试**（不只是成功路径）：建会话成功而**发消息/订阅失败**
  时，会话已经在云端建起来了 —— 只在成功分支删会让这些会话**全部泄漏**；
- **为什么不做持久会话复用**：能省两次往返，但引入状态耦合（DSH 的每次
  `stream()` 是独立的，可能并发/来自不同分支）。每轮新建把该复杂度归零，
  代价是两次额外往返（真机建会话 ~0.3s、删 ~0.2s，相对 3–13s 的生成时间可忽略）。

### SSE 解析：`plan_item` 是**累计快照**，不是增量

这是本 provider 最容易搞错、且搞错就整段文字重复的地方。

真机逐帧记录显示，同一 `plan_item.id` 的 `thought` 与 `reasoning_content`
**每一帧都是「到目前为止的全文」**：

```
[3575ms] thought=""      reason="The"
[3776ms] thought=""      reason="The user wants me to"
[3968ms] thought=""      reason="The user wants me to reply with exactly: alpha beta gamma delta"
[4108ms] thought=""      reason="…alpha beta gamma delta epsilon"
```

逐帧验证：后一帧恒为前一帧的**前缀扩展**。因此**不能**把每帧当增量拼接 ——
那会得到 `TheThe user wants me toThe user wants me to reply…`。
适配器按 `plan_item.id` 记录上一次快照，**只发新增的后缀**
（`diffCumulativeSnapshot`）。快照若不是前一次的扩展（服务端重算/回退），
则记一条诊断（`snapshotRewinds`）并**放弃**该次差异，而不是发一段会造成错乱的"差异"。

**正文有两条通道**，真机各出现过一次，两条都必须认：

1. **`plan_item.thought`** —— 逐帧累计增长的流式通道（真机第 1 轮）；
2. **`plan_item.tool_call_info.params.summary`**（`name === "finish"`）——
   真机第 2 轮的 `thought` **全程为空**，正文只出现在这里。

只认第一条会漏掉「模型直接收尾」的回复（表现为空回复）；只认第二条则失去流式效果。
两者合流进同一个正文块并**去重**（只补发 `thought` 尚未覆盖的后缀），
故第 1 轮那种「summary 与 thought 最终相同」的情形**不会重复**。

**其它事件一律忽略**：真机观测到的事件全集是
`status_changed` / `platform_timing` / `metadata` / `model_config` /
`session_title_message` / `session_icon_message` / `timing_events` /
`plan_item` / `token_usage` / `done`。其中只有 `plan_item` / `token_usage` /
`done` 对 harness 有意义 —— 把其余帧的 JSON 当正文渲染会让用户看到元数据乱码。

- **`model_config` 的 `model_name` 带 `__dev` 后缀**（真机 `Doubao-Seed-Code__dev`，
  而请求发的是 `Doubao-Seed-Code`）。`__dev` 是服务端的**配置通道标记**
  （dev 档上下文窗口），不是模型 id 的一部分 —— 任何拿它去比对静态表的代码都会
  **一项都匹配不上**，故解析时统一剥掉；
- **`id:` 行**：Work 的帧比 IDE 路径多一个 `id:` 行，解析器忽略它；
- **终止判据**：`done` 帧，或 `status_changed.new_status ∈ {4,5}`。
  ⚠️ 真机两轮**都只出现 `new_status: 3`**（会话开始）并以 `done` 收尾，
  4/5 **从未出现** —— 它是按调研配方保留的候选判据，不是实测结论；
- **`token_usage`** 有完整计数（真机含 `cache_read_input_tokens` 与
  `reasoning_tokens`），已接进 DSH 的用量回调；`inputTokens` 只计**未命中缓存**
  的部分（与其余 provider 同口径）。

### 模型目录：**远端可用**（与 IDE 路径相反），但**必须按 agent 分组取**

Work 的 `GET /api/remote/v1/models` **真机 200**，故本 provider **已接线**，
远端是权威来源，静态表（`TRAE_CN_WORK_FALLBACK_MODELS`）只在整体失败时顶替。
（IDE 路径的目录走的是**另一个**端点 `get_detail_param`，同样已接线，见
「Trae CN provider」章节的「模型目录」小节。）

⚠️ **这个端点按 `function`（= agent）分池，`function` 由 query 决定**。
2026-09-19 真机实测（同一凭据，仅 query 不同）：

| 请求 | 返回分组 |
|---|---|
| `GET …/models`（**裸打**） | `solo_coder` **12 项** |
| `?functions=solo_agent_remote` | `solo_agent_remote` **14 项** |
| `?functions=solo_agent_remote&show_custom_model=true` | `solo_agent_remote` **16 项** |

而本适配器出站请求体的 `agent_type` / `agent_id` 是 **`solo_agent_remote`**，
所以请求必须带 `functions=solo_agent_remote`（常量 `TRAE_CN_WORK_MODELS_QUERY`）。

> **这是一处已修复的缺陷，不是可选优化**：早期实现裸打端点，于是拿
> **`solo_coder` 的目录去驱动 `solo_agent_remote` 的请求**。两个池**只有
> `Doubao-Seed-Code` 一个同名 id**。后果是双向的 —— 选择器里少了本池 13 项，
> 而列出的 11 项**选中后路由不到**（它们属于另一个池）。

三组**不是同一批模型的三个视图**，故也**不合并**三组：同名 id 的窗口不同
（`Doubao-Seed-Code` 在本组是 256000，在 `solo_coder` 组是 184000）、
组内默认项不同（`solo_design_remote` 的默认是 `kimi-k2.7-code`）、
成员大面积不重合。解析器**只取本 agent 那组**；多组且无本组时返回空目录
（回退静态表），**刻意不拼接**。

响应结构（注意**分组**，不是顶层平铺数组）：

```json
{"code":0,"data":{"list":[{"function":"solo_agent_remote","models":[ …14 项… ]}]}}
```

每项字段：`name` / `multimodal` / `is_default` / `display_name` / `is_new` /
`is_beta` / `icon` / `features`（**JSON 字符串**）/ `config_source` / `is_preset` /
`max_mode` / `context_window_tokens`（`{dev,max}`），部分项带
`reasoning_effort_config`。倍率在 `features.consumption_rate.data.rate` ——
`features` 要**再解析一次**（它是字符串）。

解析器**只认这个实测形态**，不做「`data` 直接是数组」这类容忍式回退：
那些形态从未被观测到，写进来只是把未验证的假设固化成代码；上游真改版时，
一个**空目录**（回退静态表，用户仍能用）比「猜对形状但字段读错」的半成品目录
更容易诊断。

**静态表 14 项**（真机 `solo_agent_remote` 组逐字，倍率为实测值）：

| id | 展示名 | 多模态 | 上下文 | 倍率 | 思考档 |
|---|---|---|---|---|---|
| `Doubao-Seed-Evolving` | Seed-Evolving | ✓ | 256000 | 0.8 | — |
| `Doubao-Seed-2.1-Pro` | Seed-2.1-Pro-0915 | ✓ | 256000 | 0.8 | light / high |
| `Doubao-Seed-2.1-Turbo` | Seed-2.1-Turbo | ✓ | 256000 | 0.2 | light / high |
| `Doubao-Seed-Code` | Seed-Code（默认） | ✓ | 256000 | 0.06 | light / high |
| `glm-5.3` | GLM-5.3 | ✗ | 200000 | 0.78 | light / high / extra_high |
| `glm-5.2` | GLM-5.2 | ✗ | 200000 | 0.78 | high / extra_high |
| `DeepSeek-V4-Flash-Official` | DeepSeek-V4-Flash 正式版 | ✗ | 200000 | 0.08 | light / high / extra_high |
| `DeepSeek-V4-Pro-Official` | DeepSeek-V4-Pro 正式版 | ✗ | 200000 | 0.36 | light / high / extra_high |
| `kimi-k3` | Kimi-K3 | ✓ | 200000 | 1.83 | light / high / extra_high |
| `kimi-k2.7-code` | Kimi-K2.7-Code | ✓ | 200000 | 0.83 | — |
| `kimi-k2.6` | Kimi-K2.6 | ✓ | 200000 | 0.75 | — |
| `minimax-m3` | MiniMax-M3 | ✓ | 200000 | 0.26 | — |
| `qwen3.8-max` | Qwen3.8-Max | ✓ | 200000 | 1.5 | light / high / extra_high |
| `qwen-3.7-plus` | Qwen3.7-Plus | ✓ | 200000 | 0.25 | — |

远端带 `show_custom_model=true` 时会**多回 2 项账号私有自定义模型**
（真机 `deepseek-chat` / `deepseek-reasoner`，`config_source:3` / 非 preset /
带 `custom_model_id`）。它们是**按账号**存在服务端的（三方 key 由服务端持有），
故**只出现在远端目录、不进静态表** —— 塞进共用静态表会让每个账号都看到
不属于自己的条目。真机实测这两项**当前路由不通**：发出后收到 SSE
`error` 帧 `code:4028`「Authentication Fails, Your api key: ****b192 is invalid」
（`4028` 在网页版错误码表里正是 `custom_model_origin_error`），即服务端确实
按 id 取到了该账号存的三方 key、但那把 key 已失效。这是**账号侧的三方配置问题**，
不是适配器缺能力，故如实列出并把上游原文透给用户。

### 思考档：**已接线**（9/14 项声明），落点在 `custom_model` **内部**

> ⚠️ **落点与 IDE 路径不同，不要「统一」掉**：
> - IDE 路径（`src/trae-cn-adapter.ts`）：`reasoning_effort_level` 在请求体**顶层**；
> - Work 路径（`src/trae-cn-work-adapter.ts`）：同名字段在 **`custom_model` 对象内部**。

真机 `solo_agent_remote` 组里 **9/14 项**带
`reasoning_effort_config{support_thinking:true, options:[…], default_level:"…"}`，
档位 id 逐字符照抄（`light` / `high` / `extra_high`），默认档取自
`default_level`。其余 5 项（`Doubao-Seed-Evolving` / `minimax-m3` /
`qwen-3.7-plus` 是 `support_thinking:false`，`kimi-k2.7-code` / `kimi-k2.6`
连该字段都没有）**保持不声明** —— 给一个上游不认的档位会让每次请求都带上
无效字段。

**下发字段名与落点的取证链**（网页版 bundle `1626.b49a23c3.js`）：

```js
// getModelRequestSelection()：档位塞进 custom_model 的构造式里
r = {provider, is_preset, config_name, config_source, model_name,
     display_model_name, ak, base_url, custom_model_id,
     use_remote_service, multimodal, prompt_max_tokens};
"reasoning_effort_level" === t.field && void 0 !== t.value
  && (r.reasoning_effort_level = t.value);
```

而 `resolveReasoningEffortRequestField` 默认返回
`{field:"reasoning_effort_level", value}`，只有**字节内网账号**
（`scope===BYTEDANCE`）才走 `reasoning_effort` —— 与 IDE 路径同源结论：
**字段名同名，落点不同**。

**真机 A/B（2026-09-19）**，同 prompt、模型 `Doubao-Seed-Code`：

| 请求体 | `token_usage.reasoning_tokens` | `plan_item.reasoning_content` |
|---|---|---|
| 不带本字段 | **131** | 344 字（15 帧） |
| `custom_model.reasoning_effort_level="light"` | **13 / 17**（两次） | 56 / 71 字 |
| `custom_model.reasoning_effort="light"` | 28 | 66 字 |

「不带」与带 `reasoning_effort_level` 差一个数量级，而带**错名**的
`reasoning_effort` 与「不带」同量级 —— 即上游只认 `reasoning_effort_level`，
且它确实改变了思考量（不是被静默忽略的无效字段）。

适配器**只在调用方显式给了档位时才构造 `custom_model`**（不主动补档：DSH 已按
`reasoning.defaultEffort` 在省略时补好，适配器再补一次会与 DSH 的口径分叉）。
未指定档位时**整个 `custom_model` 都不发** —— 即线上原有行为，零行为变更。

### 错误分类：**以 HTTP 状态码为主**（Work 码表未标定）

与 IDE 路径**关键差异**：IDE 的码表已用官方 bundle + `ai_agent.dll` 三方互证，
Work 的码表**没有任何实测样本**（真机两轮全绿，一帧错误都没遇到）。
直接复用 IDE 码表会把未经验证的假设当成事实，故：

- **HTTP 状态码**（两条路径都成立的客观事实）是主判据：401/403 → 换号、
  429/408/5xx → 退避、其余 → 直报；
- **业务码**只接住两个跨路径可确证的额度码与几个限流/退避码
  （`TRAE_CN_WORK_KNOWN_*`），**未知码一律直报并带原文** ——
  真机第一次遇到就会把真实码暴露在错误文案里，一步即可校准。

> 未知码**刻意不猜动作**：猜成 `switch-account` 会把一个确定性失败放大成 N 次
> 无用请求，且**真实码被吞掉**（用户只看到「都失败了」）。

同理，`fail` 一律映射为 `INVALID_REQUEST`，**不**照搬 IDE 路径的
`4006 → CONTEXT_WINDOW_EXCEEDED`：把一个未标定的码当「上下文超长」会让 DSH
**误触发上下文压缩**，那是会真实改写用户会话历史的副作用。

### 协议漂移风险

⚠️ `/api/remote/v1/*` 是 **TraeWork 前端自己调的浏览器内部 RPC，没有公开契约**，
随时可能随前端发版改变字段或路径。本 provider 已把全部路径与形态常量集中在
`src/trae-cn-work-product.ts`，上游一变只需改这一处；但**无法从协议层预防**这类
漂移 —— 真出现时应以真机重新校准（本仓库的 `TraeCnWork*` 注释里保留了每一次
实测的原始帧与字段，便于比对）。

### 真机实测记录（2026-09-18，三轮对话）

用**与适配器完全相同的代码路径**（`lib/trae-cn-work-adapter.js` 的
`stream()`，不是平行脚本）验证：

| 项 | 结果 |
|---|---|
| `GET /api/remote/v1/models`（裸打） | HTTP 200，**`solo_coder` 12 项**（⚠️ 不是本 agent 的池，见上） |
| 三段式全链路 | 建会话 200 → 发消息 200 → 订阅 200（`text/event-stream`） |
| 正文 | `"work adapter verified"`（走 `thought` 通道） |
| 思考 | `"\n我现在需要按照用户的要求精确回复：work adapter verified"` |
| 用量 | `input 332 / output 18 / cacheRead 20792 / reasoning 15` |
| 收尾 | `finish(stop)`，chunk 序列 `usage → block-start → reasoning-delta×2 → block-start → text-delta → block-end×2 → finish` |
| **Work 池扣费** | **0.0568**（前 1999.816 → 后 1999.7592） |
| **通用池扣费** | **0.0000**（未动，印证两池独立） |
| 会话清理 | 适配器自己发出 `DELETE … → 200`；重复 DELETE 同一 sid 回 **404**（确认已删） |

三轮实测的 Work 池扣费分别为 **0.0616 / 0.0652 / 0.0572 / 0.0568**
（前两轮为裸协议探针，后两轮走适配器），通用池**全程 0.0000**。

### 模型目录与思考档重新取证（2026-09-19）

用户报障「模型比 TraeWork 网页版少、且不能选思考程度」，重新取证后确认为
**读错目录分组**（详见「模型目录」一节），并据此修正。取证手段与结论：

| 项 | 结果 |
|---|---|
| 目录三组对照 | 裸打 `solo_coder` 12 项 / `?functions=solo_agent_remote` 14 项 / 再加 `show_custom_model=true` 16 项 |
| 网页版调用形态 | bundle `1626.b49a23c3.js` 的 `fetchModels()` 明确传 `functions` 与 `show_custom_model` |
| 思考档声明 | `solo_agent_remote` 组 **9/14 项** `support_thinking:true`（旧结论基于 `solo_coder` 组，是错的） |
| 档位 id | `light` / `high` / `extra_high`（逐字符照抄，`glm-5.2` 只有 `high`/`extra_high`） |
| 下发落点 | `custom_model.reasoning_effort_level`（bundle `getModelRequestSelection()` 逐字） |
| 真机 A/B | 不带字段 `reasoning_tokens=131` / `light` 档 13·17 / 错名字段 28（见「思考档」一节的表） |
| 私有自定义模型 | 2 项 `config_source:3`，按账号存在服务端；实测 `code:4028`（三方 key 失效） |

> 本次取证共消耗 Work 池 10 轮对话（约 0.6 积分），每轮均按适配器同款路径
> `finally DELETE` 清理会话。

### Account Hub 里的 Trae CN Work 面板

`PROVIDERS` 含 **Trae CN Work** 一栏（排在 Trae CN 之后），能力矩阵登记为
`balance ✓ / dailyCheckin ✗`。它与 Trae CN 面板的关系是**同一批账号的两个视图**：

| 项 | Trae CN Work 面板 |
|---|---|
| 账号列表 | **与 Trae CN 完全相同**（同批 `TRAE_CN_ACCOUNT_*`、同一套限流切换） |
| 积分行 | ✓ 双池「通用 X / Work Y」（同一个端点、同一份返回） |
| 「刷新积分」 | ✓ |
| 「一键领取积分」 | ✗ **刻意不渲染** —— 签到留在 Trae CN 面板 |
| 「+ 新建账号」 | ✗ **刻意不渲染** —— 改为一行提示「与 Trae CN 共用账号，请在 Trae CN 面板登录」 |
| 卡片操作（刷新 / 删除 / 启停 / 重测 / 重置） | ✓ 照常（按 accountId / credentialRef 操作，与面板无关）|
| 「显示列表」（模型开关） | ✓ 作用于 **`trae-cn-work` 这个键**（两个池的模型不重合，黑名单必须分开） |

**为什么签到不在本面板**：签到是**账号级、当日一次**的操作，与走哪条路径无关。
两个面板都放按钮，必然导致同一个账号在两处重复领取 —— 第二次点击只会得到
「今天已签到」，在用户看来就是按钮坏了。

**为什么没有登录入口**：Work 没有独立登录协议，它的账号与凭据完全复用 Trae CN。
两个面板各放一个登录按钮，用户会在「到底该在哪个面板登录」上反复试错，而两条
入口写的是同一份数据。

**面板 id → 账号池键的映射收敛在一处**：`src/jet-hub-rpc.ts` 的 `poolProviderFor()`
把 `trae-cn-work` 映射成 `TraeCnWorkProduct.poolProviderId`（`trae-cn`），
取代了积分三端点里原本硬编码的 `req.provider === TRAE_CN.id`。客户端**发的是面板
id**、不做任何映射 —— 若在客户端映射，宿主那几个按池过滤的分支就必须跟着改，
同一件事写两遍且可能分叉。

刻意**不**映射的两个入口：`account.create`（映射会让二次点击给同一份凭据建出
第二个占位账号）与 `model.list` / `model.setDisabled`（黑名单按 provider id 存，
映射过去会把 Work 的开关写进 IDE 路径的黑名单）。锁死这些语义的是
`tests/unit/trae-cn-work-hub-panel.spec.ts`。

