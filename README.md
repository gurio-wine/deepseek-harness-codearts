# dsh-account-hub

deepseek-harness 插件：执行 CodeArts（华为云）登录流程，默认走新式 IAM OAuth
（portal `/authorize` 授权 → 本地 `/oauth/callback` 回调 → STS token 端点换取含
`refresh_token` 的凭据），到期前静默续期，无需再次打开浏览器；旧 ticket 流程保留
为显式回退（`flow: 'ticket'`）。插件还注册一个 `codearts` LLM provider 路由，使该
凭证可直接用于 CodeArts 后端模型调用。

此外插件内置另外四个 provider 路由：

- **buddy（腾讯 CodeBuddy）** — 见 [buddy provider](#buddy-provider)；
  另支持「一键领取积分」（每日签到）。
- **workbuddy（腾讯 WorkBuddy 国际版）** — 见 [WorkBuddy provider](#workbuddy-provider)。
- **lobsterai（有道 LobsterAI / 龙虾）** — 见 [LobsterAI provider](#lobsterai-provider)；
  另支持「一键领取积分」（每日签到）。
- **trae-cn（字节跳动 Trae 国内版）** — 见
  [Trae CN provider](#trae-cn-provider字节跳动-trae-国内版)；
  后端已实现签到与积分余额（双池），前端能力矩阵登记见该节说明。

五个 provider 的 Account Hub 面板都提供「**显示列表**」按钮，可逐个开关模型以控制其
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
> `CODEARTS_ACCESS_TOKEN` / `BUDDY_ACCOUNT_XXX`）。这些**都是代码标识符，改名时刻意
> 保持原样** —— 变的只有包名与界面文案，所以重装后账号池、登录状态与显示列表设置
> 直接续用，无需重新登录。

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

Account Hub 的 **CodeArts 面板**点「+ 新建账号」时，RPC **不再**在请求内等待浏览器
登录。原实现（`account.create` 里 `await codearts.login(...)`）最长阻塞 180 秒，
等它返回时触发点击的**用户手势早已过期** —— 客户端拿到 `loginUrl` 再开窗会被
浏览器弹窗拦截，客户端的兜底逻辑于是自行开窗、把 DSH 页面顶掉。现在的形态与
CodeBuddy 系、LobsterAI 完全一致（见 [AGENTS.md](AGENTS.md) 的「登录必须两段式」）：

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

- **provider 级互斥**：同一时间只允许一个进行中的 CodeArts 登录会话，重复点击返回
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

除 `codearts` 外，插件另注册三个独立路由：`buddy`（见
[buddy provider](#buddy-provider)）与 `workbuddy`（见
[WorkBuddy provider](#workbuddy-provider)）两个腾讯系路由，以及 `lobsterai`
（见 [LobsterAI provider](#lobsterai-provider)）。四者互不覆盖，可同时使用。

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

## buddy provider

独立路由 `buddy`（腾讯 CodeBuddy，OpenAI 兼容端点
`https://copilot.tencent.com/v2/chat/completions`），Bearer `access_token` 鉴权。

登录采用 external-link-v2 轮询式（与 CodeArts 的本地回调服务器不同，CodeBuddy
不起本地端口，而是轮询后端 API）：

1. `POST /v2/plugin/auth/state?platform=ide` → 取得 `state` 与 `authUrl`。
2. 打开浏览器到 `https://www.codebuddy.cn/login/?platform=ide&state=...`。
3. 轮询 `GET /v2/plugin/auth/token?state=...`（1 秒间隔、5 分钟超时）→ 令牌；
   错误码 `11217` 表示 token 未就绪，继续轮询。
4. 轮询 `GET /v2/plugin/login/account?state=...` → 账户信息；错误码 `12151`
   表示账户信息未就绪，继续轮询。
5. 续期：`POST /v2/plugin/auth/token/refresh`，通过 `X-Refresh-Token` 头提交
   refresh_token。

- **登录入口：Account Hub 设置页的 CodeBuddy 面板**（支持多账号与账号池自动切换）。
  已不再注册斜杠命令 —— 设置面板已覆盖登录、状态查看与续期，命令式入口冗余。
- 编程式调用：`ctx.buddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 模型列表：以内置的产品目录为准（`src/product.ts` 的 `fallbackModels`），
  远端 `GET /v3/config` 可用时优先采用其元数据。
- 请求头：除 `Authorization: Bearer` 外，还需 `X-Domain`、`X-Product`、
  `X-Product-Code` 以及伪装为 `CodeBuddyIDE/1.106.1` 的 `User-Agent`。
- 凭据 ref：`BUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
  `expires_at` 的 JSON 字符串。

> **流式工具调用 id 稳定性**：CodeBuddy 仅首个工具调用分片携带真实 id
> （`chatcmpl-tool-xxx`），后续参数分片只有 `index`。适配器按 index 缓存并沿用
> 真实 id（缺失时回退 `call_{index}`），保证同一工具的所有分片 id 一致——否则
> 跨轮次（每轮都从 `call_0` 重新编号）会把 `tool/result` 配对到错误的历史条目。

## WorkBuddy provider（国际版）

独立路由 `workbuddy`（腾讯 **WorkBuddy 国际版 / WorkBuddy AI**），与
[buddy provider](#buddy-provider) **同源**：共用同一 CLI 内核与同一认证协议
（cli-external-link 轮询式），Bearer `access_token` 鉴权。差异收敛在
`src/product.ts` 的产品配置里：

| 项 | CodeBuddy（中国） | WorkBuddy（国际版） |
|---|---|---|
| `endpoint` | `https://copilot.tencent.com` | **`https://www.workbuddy.ai`** |
| `platform` | `ide` | **`workbuddy-ai`** |
| 登录 URL 附加参数 | 无 | **`version` / `loginSessionId`** |
| `pluginVersion` | — | `5.5.2` |

**模型列表不能与中国版共用**：两者的路径与响应解析完全相同
（`GET /v3/config` → `data.data.models` / `data.data.agents`），差异只来自
`endpoint` —— 不同区域的后端返回不同模型池（中国版含 glm / hy / deepseek 系，
国际版含 claude / gpt / gemini / kimi 系）。因此 `endpoint` 必须随产品切换，
不能被当成全局常量。

登录流程与 CodeBuddy 一致（`auth/state` → 浏览器授权 → 轮询 `auth/token` →
轮询 `login/account`），仅身份标识与端点按上表区分。`X-Product-Code` 为
`workbuddy`，`X-Domain` 随 `apiDomain` 切换为 `www.workbuddy.ai`。

**没有每日签到积分**：国际版后端不提供**签到**接口（内核中只有
`/v2/billing/meter/get-dosage-notify` 用量通知），因此 Account Hub 的 WorkBuddy
面板**不显示「一键领取积分」按钮**；签到领取在 CodeBuddy 面板完成。

> **但积分余额（Credits Balance）可以查。** 签到与余额是两项独立能力：国际版
> 确实没有签到，但**有**积分余额查询接口，见下节。不要因为"没有签到"就推断
> 也查不到余额。

- **登录入口：Account Hub 设置页的 WorkBuddy 面板**（支持多账号与账号池自动切换）。
  同样不注册斜杠命令。
- 编程式调用：`ctx.workbuddyAuth.login()` / `status()` / `refresh()` / `logout()` /
  `fetchModels()`。
- 凭据 ref：
  - 单账号：`WORKBUDDY_ACCESS_TOKEN`，值为含 `access_token` / `refresh_token` /
    `expires_at` 的 JSON 字符串（与 `BUDDY_ACCESS_TOKEN` 同构）。
  - 多账号：`WORKBUDDY_ACCOUNT_<UUID_SHORT>`，由 Account Hub 设置页「+ 新建账号」
    登录时自动生成并登记到账号池；每条账号记录带 `provider: 'workbuddy'`，
    与 CodeBuddy 的 `BUDDY_ACCOUNT_*` 相互隔离，不会串用凭据或限流标记。
- **从中国版升级**：本插件早期版本把 `workbuddy` 指向中国版
  （`copilot.tencent.com`）。启动时会自动清理凭据 `domain` 与当前
  `apiDomain` 不符的旧账号（这类凭据在新端点必然失败），清理结果记入日志，
  请在 Account Hub 重新登录。
- 续期：与 CodeBuddy 共用同一套机制，插件启动后每 30 分钟对可续期账号静默刷新
  （`refresh_token` 经 `X-Refresh-Token` 头提交），无需重新打开浏览器。
- 请求头、模型列表拉取与流式工具调用 id 处理均与 CodeBuddy 一致，详见上一节。

### 与 Account Hub 设置页的关系

Account Hub（设置页）的账号面板按 provider 分组展示，WorkBuddy 是其中一栏：

- 面板提供账号列表、新建账号（浏览器登录入池）、启用/停用、删除，以及「重测 /
  重测所有 / 重置 / 重置所有」限流标记操作，行为与 CodeBuddy 面板一致，但
  只操作 `provider: 'workbuddy'` 的账号。
- 账号卡片展示 credentialRef、有效期（含「自动续期」标记）、限流状态与**积分
  余额**（见下节）。「一键领取积分」按钮**仅 CodeBuddy 面板提供**，结果来自
  RPC 端点 `credits.claimAll`（实现见 `src/jet-hub-rpc.ts`，签到客户端见
  `src/credits.ts`）。
- 后端另实现了 `credits.status`（查询某 provider 下全部启用账号的签到状态），
  但**前端尚无消费者**：`plugin-src/client/jet-hub.js` 只调用 `credits.claimAll`，
  `credits.status` 目前仅供外部脚本或直接 RPC 调用使用。
- 对应 LLM provider 的设置命名空间为 `llm-workbuddy`。

### 模型列表开关（黑名单）

Account Hub 面板标题栏的「**显示列表**」按钮展开该 provider 的**全部模型**，每个模型
后面带一个开关，**默认打开**。关闭后该模型不再出现在对话框的模型选择列表里。

采用**黑名单制**：只有被显式关闭的模型会被隐藏，未记录的模型（含服务端后续新增的
模型）一律默认显示。这与白名单制的关键差别在于——新模型上线时无需任何配置就会
自动出现在选择器里，不会被静默挡在门外。

- 开关状态持久化在 `jet-hub` settings 命名空间的 `disabledModels` 字段
  （形如 `{ buddy: { 'glm-5.2': true } }`），与账号池同处一个 namespace。
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
- 开关按 provider 隔离，CodeArts / CodeBuddy / WorkBuddy / LobsterAI 四份黑名单互不影响。
- 相关 RPC 端点：`model.list`（列出模型并回填 `disabled`）、`model.setDisabled`
  （打开/关闭单个模型），实现见 `src/jet-hub-rpc.ts`。

### 积分余额（Credits Balance）

账号卡片上的「积分」一行显示该账号的**可用积分**，与 IDE 顶部显示的
`Credits Balance` 是同一个数值。鼠标悬停可看到各资源包的明细与到期时间。

**支持范围**覆盖四个 provider、三套端点，语义一致：

- **CodeBuddy 系（`buddy` / `workbuddy` 通用，仅 baseURL 随 `product.endpoint`
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

### 一键领取积分（每日签到）

**当前由 CodeBuddy、LobsterAI 与 Trae CN 三个面板提供**该按钮。签到在本插件里
共有**三套互不相通的实现**（CodeBuddy / LobsterAI / Trae CN，协议、端点、幂等
判据全不同，各自独立成文件）；三者的客户端能力登记均已落地，故三个面板都显示
该按钮。CodeArts 是华为云账号体系不参与；WorkBuddy 国际版后端没有签到接口，
故其面板不显示。详见「积分余额」一节末尾的说明。

在 Account Hub 对应面板标题栏点击「**一键领取积分**」，插件会对该面板下
**全部账号**顺序执行每日签到领取：

> **含已停用账号。** 停用只影响账号池的自动选择与限流切换，不改变账号本身
> 是否已签到——用户点「一键领取」时期望所有账号都尝试一遍。

**CodeBuddy（两步）**：

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

完成后按钮下方给出结果摘要（如「3 个账号领取成功（+300 积分），1 个今日已领取」）。
领取按账号隔离：单个账号凭据缺失、损坏或请求失败不会中断整批，只计入失败数；
摘要**只显示各类计数**（如「1 个失败」），不展示每个账号的失败原因——原因保留在
`results[].outcome.message` 中，需要时请通过 RPC 响应或日志查看。

几点实现约定：

- 领取是**顺序执行**的，避免并发触发风控；账号较多时需要等待片刻。
- **CodeBuddy** 重复领取是幂等的：服务端返回 HTTP 400 + `code 10001`（「今天已签到，
  请明天再来」），插件把它识别为 `already-claimed` 而非失败。
- **LobsterAI** 的幂等由**客户端**保证：请求带 `idempotencyKey`，且领取前先读
  `context` 的 `claimedToday` 与 `actions`；重复领取会被识别为 `already-claimed`。
- CodeBuddy 的状态查询用 `checkin-activity-status` 而非 `checkin-status`；后者返回
  占位数据（`active:false`、`checkin_dates:null`），会让人误判为活动未开启。
- CodeBuddy 的请求**不需要** `X-Device-Token`（图灵盾）——已实测验证。
- LobsterAI 的签到**不需要签名**，只用 `Authorization: Bearer`；也**不发**腾讯系的
  `X-Domain` / `X-Product` / `X-Product-Code` 头。
- Trae CN 的签到用 `Authorization: Cloud-IDE-JWT`（另带两个等值 token 头）+
  `Origin` / `Referer` = `https://www.trae.cn`；**不发**任何腾讯系或 LobsterAI 归属头。

想单独验证领取闭环（会真实改动账号当日签到状态）可运行
`pnpm test:e2e:workbuddy-claim` 或 `pnpm test:e2e:lobsterai-claim`，
说明见 `tests/e2e/README.md`。

## LobsterAI provider（有道龙虾）

独立路由 `lobsterai`（有道 **LobsterAI**），OpenAI 兼容端点
`https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions`，
Bearer `access_token` 鉴权。

该 provider 与腾讯系**协议完全不同**，因此实现是独立一套
（`src/lobsterai*.ts`），只共用架构模式（产品配置驱动、账号池、限流切换、
模型黑名单）。关键差异：

| 项 | 腾讯系（CodeBuddy / WorkBuddy） | LobsterAI |
|---|---|---|
| 登录方式 | 轮询后端 API（无本地服务器） | **本地回调服务器**收 `authCode` 后换 token |
| 登录/API 域名 | 同一个 `endpoint` | **两个域名**（portal 与 apiBase） |
| 请求头 | `X-Domain` / `X-Product` / `X-Product-Code` / `X-IDE-*` | 仅 `X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version` |
| 续期请求体 | 只带 `refreshToken`（走 `X-Refresh-Token` 头） | 还要带 `firstKeyfrom` / `latestKeyfrom` / `uuid` |
| `clientVersion` | 编译期常量 | **运行时从第三方接口动态拉取** |
| 每日签到 | 两步（状态 + 领取） | **三步**（slot + context + check_in） |
| 图片输入 | 支持 | **不支持**（`inputModalities` 仅 `text`） |
| 思考等级 | 支持（按模型声明档位） | **不声明**（是否支持未实测） |

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
  失败时回退 `src/lobsterai-product.ts` 的 19 个内置模型。
- 续期：启动后每 30 分钟对可续期账号静默刷新（与其他 provider 同一调度器）。
  **终态判定比参考实现更精确**：只有 HTTP 401/403 或业务码 40100/40101
  才判为 `refresh_token` 失效；网络抖动走可重试路径，不会误让用户重新登录。

> **已知待实测项**（见 `docs/lobsterai-integration-plan.md` §7.2）：
> 是否支持 `reasoning_effort`、各模型真实上下文窗口（内置表统一填 131072，
> 是桥接层的估计值）、图片输入、`prompt_cache_key`。这些在实现里都取了
> **保守默认**（不声明 / 不发送），不会因未知而失败。

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
`device_id` 是 **16 位纯十进制**（**不能用 hex32/UUID** —— 形态不符会触发 9074 风控）。
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

**端点**：`POST https://trae-api-cn.mchost.guru/api/ide/v1/chat`，请求头
`Cloud-IDE-JWT <access>` + 同值 `X-Ide-Token` / `X-Cloudide-Token` +
**IDE 网关全套头**（见下），`Accept: text/event-stream`；请求体是标准
OpenAI chat-completions 消息数组（`model` / `messages` / `stream: true`），
**不发**任何腾讯系或 LobsterAI 归属头。

> ✅ **T6 已真机校准（2026-09-18）：路径本来就对，错的是 host。**
> `/api/ide/*` **不在** `api.trae.cn` 上 —— 实测 `/api/ide/v1/ping` 在该 host
> 回 **404**，在 IDE 网关 `trae-api-cn.mchost.guru` 回 **200**（该 host 由官方
> product.json 的 `bootConfig.agent.trae.normal` 指定）。原实现把正确路径拼在
> 错误的 base 后面，症状是 404 而病因在 host —— 若当初照候选表逐个试路径，
> 四条会全部 404，反而把正确的那个排除掉。候选表
> `TRAE_CN_CHAT_PATH_CANDIDATES` 因此已无运行时意义，仅作历史留痕。
> 实测该网关上 chat 返回**正常 SSE**，业务错误在 HTTP 200 的 `event:error`
> 帧里（实测 `code:4001`），与 `src/trae-cn-errors.ts` 的设计假设一致。

**IDE 网关必须带齐的请求头**（实测缺了直接 500 / 401，带齐才是 200 ——
它们不是遥测字段，而是请求能否成立的一部分）：

```
x-app-id:            6eefa01c-1036-4c7e-9ca5-d891f63bfcd8
x-ide-version-code:  107            ← 必须纯数字；"3.3.100" 会 400
x-app-version-code:  107
x-ide-version:       1.107.1        ← 与登录用的 3.3.100 不是一个号
x-ide-version-type:  stable
request-traffic-type: normal
x-device-id:         <凭据的 device_id>   ← 与签到头同源
x-device-type:       windows
x-os-version:        Windows 10.0.22631
User-Agent:          TraeClient/TTNet     ← 官方客户端 UA，不是浏览器 UA
```

注意 `x-ide-version-code` 与登录 URL 的 `x_app_version`（`3.3.100`）**同名不同物、
形态要求还不同**：一个进网关头且必须纯数字，一个进 URL/请求体。三个版本号
（`107` / `1.107.1` / `3.3.100`）在 `src/trae-cn-product.ts` 里是三个独立常量。

**SSE 不是 OpenAI 协议**。上游返回**具名事件**流，帧解析在 `src/trae-cn-sse.ts`：

```
event:metadata      data:{"conversation_id":…}      ← 忽略（`meta` 亦识别）
event:timing_cost   data:{…}                        ← 忽略
event:output        data:{"response":"片段"}         ← 正文增量
event:token_usage   data:{prompt_tokens,…}          ← usage
event:done          data:{…}                        ← 流结束
event:error         data:{"code":4008,"message":…}  ← 失败（HTTP 仍为 200）
```

事件名同样取自本机客户端字符串池：Rust 侧
`…/adapter/llm/event.rs` 有一份权威事件类型清单，每个变体都带一条
`Failed to deserialize <name> event` 诊断串（实测提取到 22 条）。

**错误分类按业务码，不按 HTTP 状态码**（`src/trae-cn-errors.ts`，纯函数）：

| 动作 | 业务码 | 说明 |
|---|---|---|
| **换号** | `4008` `4021` `5003` `977`（限流）、`4200`–`4203`（额度）、`1001` `1002` `4010` `4014`（账号失效）、`4011` `4013` `4015`（风控） | 对齐官方 `isSecurityError` 语义：账号失效与风控同样换号 |
| **退避不换号** | `4007` `3004` `9074`（软限流）、`4000005` `4050`–`4052`（排队） | 排队是**全局**状态，换号只会把同一个问题再问一遍并多烧一个账号的额度 |
| **直接报错** | `4001`（参数）、`4006`（超长）、`4023`（模型不存在） | 确定性失败，换号与退避都是浪费往返 |
| **直报（带原始码）** | 其它未知码 | 保守默认：未知码可能是终态（积分耗尽的真实码 T3 尚未实测到），直报能让真机第一次遇到就把码暴露在文案里，一步校准 |

非 200 的 HTTP 失败（网络层/网关）走兜底：`401`/`403` → 换号，`429`/`408`/`5xx` → 退避，
其余直报。`4006` 映射为 `CONTEXT_WINDOW_EXCEEDED`（触发 DSH 上下文自动压缩），
换号与退避都映射为可重试的 `RATE_LIMIT`。

**结构上与 LobsterAI 的根本差异**：Trae 的业务失败发生在 **HTTP 200 的
`event:error` 帧**里，所以换号循环必须能接住**流内**失败 —— LobsterAI 的错误
全在 `!response.ok` 分支，流一旦开始就没有换号的余地。换号上限同 LobsterAI
（3 个账号，含首次）。若流已经开始产出正文才报错，则**不再换号**（换号会让用户
看到「半截回答 + 完整回答」两段内容，比直接报错更糟），改为直报。

**模型目录 = 真机 16 项静态表**（`TRAE_CN_FALLBACK_MODELS`，2026-09-18）。

| id | 展示名 | 多模态 | max_tokens | 上下文（dev/max） |
|---|---|---|---|---|
| `Doubao-Seed-Evolving` | `Seed-Evolving` | ✓ | 64000 | 262144/1048576 |
| `Doubao-Seed-2.1-Pro` | `Seed-2.1-Pro-0915` | ✓ | 64000 | 262144/1048576 |
| `Doubao-Seed-2.1-Turbo` | `Seed-2.1-Turbo` | ✓ | 32000 | 262144 |
| `Doubao-Seed-Code` | `Seed-Code` | ✓ | 32000 | 262144 |
| `glm-5.3-flash` | `GLM-5.3-Flash` | ✓ | 64000 | 119040/1048576 |
| `glm-5.3` | `GLM-5.3` | ✗ | 64000 | 119040/1048576 |
| `glm-5.2` | `GLM-5.2` | ✗ | 64000 | 119040/1048576 |
| `deepseek-v4.1-flash` | `DeepSeek-V4.1-Flash` | ✓ | 64000 | 119040/1048576 |
| `DeepSeek-V4-Flash-Official` | `DeepSeek-V4-Flash 正式版` | ✗ | 64000 | 119040/1048576 |
| `DeepSeek-V4-Pro-Official` | `DeepSeek-V4-Pro 正式版` | ✗ | 64000 | 119040/1048576 |
| `kimi-k3` | `Kimi-K3` | ✓ | 64000 | 204800/1048576 |
| `kimi-k2.8-preview` | `Kimi-K2.8-Preview` | ✓ | 64000 | 204800/1048576 |
| `minimax-m3` | `MiniMax-M3` | ✓ | 64000 | 119040/1048576 |
| `qwen3.8-flash` | `Qwen3.8-Flash` | ✓ | 64000 | 204800/1048576 |
| `qwen3.8-max` | `Qwen3.8-Max` | ✓ | 64000 | 204800/1048576 |
| `qwen-3.7-plus` | `Qwen3.7-Plus` | ✓ | 64000 | 204800/1048576 |

来源：真机 `chat_v3` 模型目录（2026-09-18），由 Trae 客户端 **vscdb 缓存**与
**160 处日志事件**互证；id / 展示名 / 多模态标记 / max_tokens / 窗口**逐字符**照抄。
id 形态极不规则（`qwen3.8-flash` 无连字符、`qwen-3.7-plus` 有、
`deepseek-v4.1-flash` 是点号、`minimax-m3` 全小写）——**任何规整化都会让请求打到
不存在的模型上**，故原样保留。

- 上下文窗口取 **dev 档**（如 `262144/1048576` → 262144）：它是客户端默认实际
  使用的窗口。max 档（多数 1048576）是理论上限，按它声明会让 DSH 的上下文压缩
  迟迟不触发；
- `inputModalities` **按模型给**：多模态项（**12/16**）输出 `['text','image']`，
  其余 `['text']`。`listModels` 与 `resolveModel` 读的是同一个 `supportsImages`
  字段，两处口径强制同源（不一致会让选择器与请求路径自相矛盾）；
- `maxTokens` **只记录不 materialize**：DSH 的 `defaultMaxTokens` 会在调用方未给
  上限时自动填进请求体，而本仓库另外四个 provider 一个都没设该字段 ——
  由适配器替用户决定输出上限是行为变更，不在本次范围内。

**思考档位（reasoning effort）已接线**：13/16 项声明档位，另 3 项
（`minimax-m3` / `qwen-3.7-plus` / `Doubao-Seed-Evolving`）刻意不声明。

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
- 默认档照抄真机 `default_level`：多数为 `high`，**`kimi-k3` 与
  `kimi-k2.8-preview` 是 `extra_high`**；
- 不声明 `reasoning` 的模型在 DSH 模型选择器里显示「当前模型未提供推理等级」
  ——那是**唯一**数据源（`resolveModel().reasoning`），不声明时该行根本不渲染。

**下发字段名是 `reasoning_effort_level`，不是 `reasoning_effort`**（2026-09-18 定案）。
官方客户端的 `ai-modules-chat` bundle 里，`resolveReasoningEffortRequestField`
默认产出 `reasoning_effort_level`，只有**字节内网账号**（`scope===BYTEDANCE`）
才走 `reasoning_effort`；本插件用的是普通国内账号，故取前者。`ai_agent.dll` 的
serde 字段块里两者**并列存在**，印证这是「两套账号体系各用一个」而非猜测。

> ⚠️ **已知未验证项**：上游是否**真的按档位改变思考**尚未做对比实验。真机
> A/B **无法**用「是否报错」区分两个字段名 —— 测试账号在带与不带档位时都回
> `code:4008`（配额），字段校验阶段被 4008 掩盖（该账号在
> `pay/web_user_ent_usage` 上仍显示通用池 2650 积分，故 4008 不是「余额为 0」，
> 但也不是可用来判定字段名的信号）。字段名本身由上述静态证据三方互证定案；
> 「档位是否生效」需一次能跑通的对话来对比 `reasoning_content` 长度。

**为何不接远端模型目录**（三端点实测结论，2026-09-18）：

| 端点 | 实测结果 |
|---|---|
| `model_list`（`{"type":"chat"}` + 完整网关头） | 只回 **6 项旧池**（Doubao-1.5 代） |
| `batch_get_detail_param` | 只回 **4 个 seed 配置** |
| 其余约 200 种形状组合 | 18 项新池**一个都不出现** |

官方客户端能看到新池，靠的是 `harness.dll` **内嵌静态映射** + 本地缓存（vscdb），
不是任何可调用的 HTTP 接口。故 `fetchRemoteModels` **刻意不接线**，静态表即正解
（`TRAE_CN_MODELS_PATH` 保留常量并注明不可用）。

> ⚠️ **待办**：解析器 `parseTraeCnModels` 因此**当前无调用方**（远端不接就没有
> 响应可解）。刻意保留而非删除 —— 真接线时它仍是入口，且它的候选字段表是从客户端
> 响应形态推出来的。接线时需一并校准该表。
>
> 4 个旧死 id 的下落：`qwen3.7-max` **已下线**；`deepseek-v4-flash` /
> `doubao-seed-2-1-pro` / `MiniMax-M3` 是拼写或大小写错误的**近似形态**
> （真机分别是 `deepseek-v4.1-flash` / `Doubao-Seed-2.1-Pro` / `minimax-m3`）。
> 真机目录里**没有** `deepseek//deepseek-chat` 与 `deepseek//deepseek-reasoner`
> —— 那是账号自定义的 BYOK 条目，不属云端目录，已排除。

消耗倍率（`display_contact_config.consumption_rate.data.rate`）会被解析出来，
但**不塞进** `LlmModelInfo` —— DSH 该接口只有
`provider`/`id`/`name`/`description`/`inputModalities` 五个字段，唯一的落点是
`description`，而那会污染模型选择器的展示文案。

**与其它 provider 一致的约定**：`stream()` 把 `options.model` 传给
`resolveCredential` 与 `refresh`（硬约定，见「账号池与多账号」）；
`listModels()` 实时读 `pool.disabledModelsFor('trae-cn')` 应用黑名单；
**声明** reasoning 档位（13/16 项，真机 vscdb；下发字段 `reasoning_effort_level`，
仅透传调用方显式传的值、不主动补档 —— 补档由 DSH 按 `defaultEffort` 完成）。

> ⚠️ **图片输入有意不一致**：目录照实报 `['text','image']`（那是**模型**的能力），
> 而 `stream()` 仍对图片块抛 `UNSUPPORTED_CONTENT`（那是**本适配器**的能力 ——
> `serializeTraeCnMessages` 只展平文本块，没有把 image 块编码成上游要的形态）。
> 正常调用到不了那道抛错：DSH 会按 `inputModalities` 在路由层把图片投影成文本
> 占位（`projectImagesForTextModel`）；抛错是防「绕过路由层直接调 `stream()`」
> 的最后一道防线。两处**不要「顺手」改成一致**。

### 签到与积分余额

实现是独立一套 `src/trae-cn-credits.ts`（协议与 CodeBuddy 系三步都不同），
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
x-os-version:  Windows 10.0.22631
x-app-version: 3.3.100
```

- 设备四件套是 **claim 的硬要求**，缺失时服务端回 `code:9004`。
  `x-device-id` **取自凭据**（`device_id` 字段），不是登录 URL 里那个随机生成的
  16 位号 —— 后者只参与登录握手与风控形态校验，不是设备身份。
  ✅ **T9 已校准（2026-09-18）**：设备**号形态**不被校验（16 位十进制号 /
  `BoundDeviceID` / 空串全回 `code:0`），只有**完全不带设备头**才 `did_checked_in:false`；
- `Origin` / `Referer` 取编译期常量 `product.portalBase`，**不从凭据推断**
  （与 `X-Domain` 那条约定同因）；
- `req_source:1` 照抄**唯一次实测成功**的组合。✅ **T1 已校准**：带与不带服务端返回
  **逐字节相同**，它不是 9004 的成因；保留它只因为成本是零。

**幂等判据是 `checked_in`（账号级当日）**，`did_checked_in` 是**设备级**语义
（换设备仍为 false），**不要用**。领取流程自身先查状态、已领则短路，
故 RPC 分发处传 `precheckStatus: false`（对齐 LobsterAI 的多步流程）。

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

**判定一律以 body `code` 为准，不看 HTTP 状态**（对齐 CodeBuddy 既有约定）：
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
