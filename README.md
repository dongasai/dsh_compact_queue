# @dongasai/dsh-compact-queue

给每个 DSH 会话一条**能排队**的压缩命令：`/compact_queue`。

核心 `/compact` 只认「严格 idle 的 agent」—— `compactNow` 底下的 `runMaintenance` 在非 idle 时
直接 throw，外层包成 `ManualCompactionError('busy')`，命令层把它原样转成一句报错就完事。
会话正忙（上一轮还没收尾、maintenance 还没跑完）时想压一下历史，只能等、只能反复敲。

本插件**不改核心**，另注册一条 **agent 作用域**命令：空闲时立刻压缩；忙时把请求排进**本会话**
队列，等这个会话下一次 idle 自动补跑；排队中随时能撤销。

| 文档 | 只写 | 不写 |
| --- | --- | --- |
| **本文件** | 怎么用：装、用法、回执、排错、验证、边界 | 设计取舍、给 agent 的约束 |
| [index.js](index.js) 文件头「一 ~ 四」 | 为什么：三条官方接缝、双通道触发、失败口径的来龙去脉 | 装法与操作步骤 |
| [AGENTS.md](AGENTS.md) | 给 agent 的约束：硬规则、改动连带项、模块地图 | 用户用法 |

## 功能

| 能力 | 说明 |
| --- | --- |
| `/compact_queue` | 空闲 → 立即压缩；忙 → 排队并回执「已排队，最长等 30 分钟」 |
| `/compact_queue cancel` | 排队中 → 撤销；执行中 → abort 其 signal |
| 自动补跑 | 本会话下一次 idle 触发；`agent/status` 翻转与 2 秒兜底 tick 双通道，不漏触发、不重叠执行 |
| 回执不吵人 | 后台完成/失败以折叠 notice 注入，不唤醒模型、不额外烧 token |
| 失败不重试 | `ManualCompactionError` 除 `busy` 外一律终态，避免坏循环反复烧摘要请求 |
| 仅本会话可见 | 命令注册在 `agent.ctx`，随 agent scope 销毁自动卸载，不会出现在别人的会话里 |

不提供：跨会话全局队列、持久化队列、UI 面板、HTTP 路由。本包**没有浏览器半边**，只有 Host 半边。

## 安装

三种装法，按场景选。**都走同一条 pnpm 路径**（`@deepseek-ai/dsh-plugin-manager/operations`，
共用一把 profile 写锁），装完都会出现在侧栏「插件」页的**已安装**列表里。

**都不需要手写注册行**：本包在 `package.json` 里声明了 `dsh.bundle.patch`，只要这个 bundle 被选中，
生效的那一行就来自本包自带的 [cordis.patch.yml](cordis.patch.yml)。命令行（方式二、三）安装会顺带把它
选进 `dsh.profile.bundles`；Web 上（方式一）是装完点 **立即启用** 才选中 —— 不点就只是「装着但没启用」。

本包 `private: true`、未发布到 npm，所以没有「按包名从 registry 装」这条路：spec 要么是本地路径，
要么是 git 地址。

### 方式一：Web 界面（推荐）

DSH Web → 左侧栏 **插件** → **添加插件** → 填入本仓库绝对路径（或下面的 git 地址）→ **安装** →
装完点 **立即启用**。

仓库地址：https://github.com/dongasai/dsh_compact_queue

- 「添加插件」接受：包名（可带版本）、Git 地址、压缩包、**本地绝对路径**。
- 装完不点**立即启用**，就只是「装着但没启用」。
- 侧栏这个「插件」页才能装和开关；**设置 → 内置插件** 里的清单是只读的。

### 方式二：命令行 · git 源（分发）

```bash
dsh plugin --profile web add github:dongasai/dsh_compact_queue
# 或
dsh plugin --profile web add git+https://github.com/dongasai/dsh_compact_queue.git
# 钉版本（URL 后加 #<tag>，锁到某个发布版本来复现问题 / 稳定使用）
dsh plugin --profile web add github:dongasai/dsh_compact_queue#0.1
```

`dsh plugin --profile <name> <pnpm args>` 把参数交给
`@deepseek-ai/dsh-plugin-manager/operations`（底层仍是该 profile 目录里的 pnpm）。装进来的是
**副本**：之后改本仓库代码不影响已装的副本（想边改边用就走方式三）。

- `--profile` **必填**（不写直接报 `required option '--profile <name> not specified'`）。
- **必须带 `git+` 或 `github:` 前缀**。`git@github.com:owner/repo.git` 这种 scp 写法不会被认成
  git spec，pnpm 会把它当路径，装出一条指向不存在目录的 `link:` 死链。
- **钉版本**：URL 后加 `#`（上面第三条命令就是钉 `0.1`），tag / 分支 / commit 都行；
  本仓库当前 tag 是 `0.1`，对应 `package.json` 的 `0.1.0` —— 不带 `#` 则跟 `main` 走，
  每次装到的都可能是新代码。
- pnpm 默认会拦 `prepare` 等依赖构建脚本；本包**没有任何构建步骤**（纯 ESM 源码 + 一个 cordis
  补丁，没有编译产物），不会遇到。

### 方式三：命令行 · 本地目录（link，开发）

```bash
dsh plugin --profile web add link:<本仓库绝对路径>
```

装成 `link:` 依赖，代码改动立刻是「已装的那份」—— 适合边改插件边用。

- 改 [index.js](index.js) 或 [cordis.patch.yml](cordis.patch.yml)：**要重启 Harness** 才生效。
- 本包**只有 Host 半边**（没有 `client.js`、没有浏览器 bundle），刷新页面不解决任何问题。

### 装完确认

命令行可以直接看合成后的 profile 树（不启动服务）：

```bash
dsh --profile web --dump-config | grep -A1 dsh-compact-queue
```

期望看到（本机实测，2026-10-20）：

```yaml
# == @dongasai/dsh-compact-queue
- id: dsh-compact-queue
  name: '@dongasai/dsh-compact-queue'
```

**运行中的实例要重启才会加载它**（插件行是启动时合成的）：

```bash
systemctl --user restart dsh.service     # 按你的部署方式替换
```

重启后在会话里敲 `/compact_queue`：出现任意一句回执即注册成功。报「未知命令」= 没重启，或装进了
别的 profile（命令作用域跟着 agent 走，别的 profile 里看不到）。

### 卸

```bash
dsh plugin --profile web remove @dongasai/dsh-compact-queue
```

卸载时插件管理会把它从 `dsh.profile.bundles` 里一并摘掉；重启后命令消失。

## 用法

| 输入 | 行为 |
| --- | --- |
| `/compact_queue` | 立即尝试；会话忙则排队（回执写明「已排队，最长等 30 分钟」与撤销方式） |
| `/compact_queue cancel` | 排队中 → 撤销；执行中 → abort；都没有 → 报「当前没有排队的压缩」 |
| `/compact_queue <其它>` | 回用法提示，不执行任何压缩 |

一次典型交互（忙时）：

```
你  ▸ /compact_queue
dsh ▸ 会话正忙，压缩已排队：将在本会话下一次空闲时自动执行（最长等待 30 分钟）。/compact_queue cancel 可撤销。

    …本轮结束、会话回到 idle…

dsh ▸ 排队压缩完成：压缩了 42 条历史（约 18304 tokens）。     ← 折叠 notice
```

空闲时打这条命令不排队，直接回 `压缩完成：42 条历史（约 18304 tokens）。`，并带
`sourceEventSeq` 指向摘要事件（与核心 `/compact` 同规格）。没有可压缩范围时回
`当前没有可压缩的历史。`

### 回执原文对照

排错时按文案直接查表：

| 场景 | 原文 |
| --- | --- |
| 忙、已排队 | `会话正忙，压缩已排队：将在本会话下一次空闲时自动执行（最长等待 30 分钟）。/compact_queue cancel 可撤销。` |
| 重复入队 | `压缩已在队列中（已排队约 N 分钟）。/compact_queue cancel 可撤销。` |
| 正在压缩 | `压缩正在执行中。` |
| 撤销排队 | `已撤销排队的压缩。` |
| 取消执行中 | `正在取消执行中的压缩。` |
| 撤销空操作 | `当前没有排队的压缩。` |
| 参数不对 | `Usage: /compact_queue（排队或立即压缩）或 /compact_queue cancel（撤销）` |
| 预设缺服务 | `本会话挂载的 agent preset 没有提供 compaction 服务，无法压缩。` |
| 排队补跑成功 | `排队压缩完成：压缩了 N 条历史（约 M tokens）。` |
| 排队补跑无历史 | `排队压缩完成前检查：当前没有可压缩的历史。` |
| 排队补跑失败 | `排队压缩失败：<原因>` |
| 排队超时 | `/compact_queue 排队超时（等待超过 30 分钟，会话一直未空闲），本次压缩已取消。` |

压缩本身的失败按 `ManualCompactionError.code` 逐条映射，原文如下（源码 `FAILURE_TEXT`）：

| code | 回执原文 |
| --- | --- |
| `cancelled` | `压缩已取消。` |
| `changed` | `选定的历史在替换前发生了变化，本次未执行。详情见会话日志。` |
| `summary` | `未能生成有效摘要。详情见会话日志。` |
| `commit` | `压缩未正常结束，部分历史可能已变动；请先检查会话状态再重试。` |
| `persistence` | `压缩已完成，但会话未能保存。` |

其余 code 回 `压缩失败（<code>）。`；非 `ManualCompactionError` 回 `压缩失败：<message>`。
`busy` 不会出现在回执里——它只表示「还没轮到」，继续排队等下一次 idle。

上面都是**命令回执**（完整一句话）。排队补跑的 notice 在 UI 里折叠成一行，文案是
`排队压缩完成：N 条 ~M tokens` / `排队压缩：没有可压缩的历史` / `排队压缩失败` /
`compact_queue 排队超时，已取消`，展开可见完整正文。

## 结构

| 文件 | 作用 |
| --- | --- |
| [index.js](index.js) | 唯一源码：`apply(ctx)` 遍历/监听 agent，`attach(ctx, agent)` 为每个 agent 挂状态机与命令 |
| [cordis.patch.yml](cordis.patch.yml) | bundle 补丁，`- insert:` 一行把插件挂到**宿主层** |
| [package.json](package.json) | `exports` / `files` / `dsh.bundle.patch`；`private: true` |
| [AGENTS.md](AGENTS.md) | 给 agent 的架构地图与硬约束 |

Host 半边 `inject: ['commands', 'agents', 'agentPresets']` —— 要宿主层的 agent 注册表、预设注册表
和命令服务；压缩服务是运行时跨 realm 取的（`ctx.agentPresets.serviceFor(agent, 'compaction')`），
不在 inject 里。

扩展点占用：

| 槽位 / 服务 | 占用 | 说明 |
| --- | --- | --- |
| `commands`（agent 作用域） | 命令名 `compact_queue` | 每 agent 一份，随 scope 卸载；**不在根 `ctx` 注册** |
| `agent/status` 事件 | 监听 `idle` 翻转 | 双通道之一，挂在 `agent.ctx` |
| 定时器 | 2 秒 `unref()` tick | 双通道之二，兼做 30 分钟超时判定 |
| HTTP 路由 / UI 槽位 / 其它服务 | 不占 | 本包没有浏览器半边 |

## 与 Agent 的关系

- 命令由**人**敲；agent 那边看到的是压缩之后的历史，不需要（也无法）自己触发排队。
- 排队完成的 notice 是**系统回执**（`source.kind: 'compact-queue'`、`form: 'notice'`），不唤醒模型、不计为你发的消息。
- 核心 `/compact` 行为一字未改；本插件失败也不影响那条命令。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 命令补全里没有 `/compact_queue` | 没重启；或 Web 上装了没点「立即启用」；或装到了别的 profile | 按「安装 → 装完确认」逐条核：`dsh --profile web --dump-config \| grep -A1 dsh-compact-queue` 有没有那三行 |
| 一直回「已排队」不下去 | 会话确实一直被占用（长任务、subagent、其它 maintenance 占着） | 等本轮结束；或 `/compact_queue cancel` 撤销 |
| 回「本会话挂载的 agent preset 没有提供 compaction 服务」 | 当前 preset 没挂 compaction 实现 | 换回带压缩的 preset；这不是排队逻辑的问题 |
| 排队到 30 分钟突然消失、没有任何提示 | tick 通道命中超时的已知静默缺陷 | 见「已知边界」第 3 条 |
| 装完报「找不到包」 | git 规格写成 `git@…` scp 写法，被当成本地路径 | 改成 `github:dongasai/dsh_compact_queue#0.1` |
| 报 tag 不存在 | 钉了未发布的版本 | `git ls-remote --tags origin` 选真实 tag（当前 `0.1`） |

## 怎么验证

命令行能覆盖的：

```bash
node --check index.js                                        # 语法：无输出即通过
npm pack --dry-run                                           # 应恰好 4 个文件（index.js / cordis.patch.yml / package.json / README.md）
grep -n 'dsh-compact-queue' ~/.dsh/profiles/web/package.json  # 两行：dependencies + dsh.profile.bundles（安装时自动登记）
git ls-remote --tags origin                                  # 当前应看到 0.1 及其指向的提交
dsh --profile web --dump-config | grep -A1 dsh-compact-queue                 # 期望三行，见「装完确认」
```

只能在会话里打勾的（没有自动化测试，逐条手验）：

1. idle 时 `/compact_queue` → 立即 `压缩完成：N 条历史（约 M tokens）。`
2. 忙时 `/compact_queue` → 回「已排队」；本轮结束后收到 `排队压缩完成：…` notice
3. 排队中 `/compact_queue cancel` → `已撤销排队的压缩。`，之后不再触发
4. 排队中再敲 `/compact_queue` → `压缩已在队列中（已排队约 N 分钟）。`，不产生第二份压缩
5. 关掉该会话 → 后台无残留定时器、无 unhandled rejection（看宿主日志）

## 已知边界

1. **队列不持久化**。只存在内存，`dsh` 重启即丢。代价：重启前排队的那次压缩不会补跑。原因：压缩请求本身就是一次性的，落盘反而要处理「重启后该不该替你做」。
2. **最长等 30 分钟**。超过就清队列。代价：真忙超过半小时的会话会丢这次请求。
3. **tick 通道命中的超时是静默的**（未修）。`attempt(false)` 不发 notice，所以「一直忙到超时、期间没有 idle 翻转」时队列被清掉却没有任何提示；只有 idle 事件那条通道会回执。修法在 [AGENTS.md](AGENTS.md) 的连带项里记着。
4. **只对已有/新建 agent 生效**。晚创建的 agent 由 `agent/created` 补挂；但**重启前**已存在的会话不会补注册命令——必须重启。
5. **每个会话独立**。没有全局队列，也不会把 A 会话的压缩请求带进 B 会话。
6. **`attempt()` 开头重复调用 `isLive()`**，属无害死代码（AGENTS.md 的已知问题清单里也记着）。
7. **无自动化测试**。状态机与定时器只能手验，验证清单见上一节。

## 发版

- 当前版本：`package.json` 的 `0.1.0` ↔ 附注 tag `0.1`（**不带 `v`**，与本机其它插件仓的 `0.1` / `0.2` 命名一致）
- 远端：`origin` = `git@github.com:dongasai/dsh_compact_queue.git`
- 流程：改 `package.json.version` → `git tag -a 0.1 -m …` → **`git push origin main` 与 `git push origin 0.1` 两条都推**（只推分支会漏 tag，克隆方拉不到对应版本）

## 相关文件

| 文件 | 内容 |
| --- | --- |
| [index.js](index.js) | 命令注册、排队状态机、notice 回执、失败映射（含「为什么」文件头注释） |
| [cordis.patch.yml](cordis.patch.yml) | 宿主层 `insert` 一行 |
| [package.json](package.json) | 包元数据与 `dsh.bundle.patch` |
| [AGENTS.md](AGENTS.md) | agent 侧的架构地图、硬约束、改动连带项 |
| [.agents/index.json](.agents/index.json) | 架构扫描索引（模块快照、覆盖率、缺口） |
