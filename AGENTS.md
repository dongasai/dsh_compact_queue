[根目录](./AGENTS.md) > **dsh_compact_queue**

# AGENTS.md

给在这个仓库里干活的 agent 看的：架构地图、硬约束、改动连带项。面向用户的用法、装法坑、回执原文
对照、排错与已知边界在 [README.md](README.md)，本文件不重复那些内容。与代码冲突时以代码为准。

**单模块仓**：源码只有一个文件 [index.js](index.js)，没有子目录模块，因此没有下级 `AGENTS.md`；
下文「模块索引」只是把文件级职责摊开，不构成可独立拆分的模块。

## 项目愿景

给每个 DSH 会话一条**能排队**的压缩命令 `/compact_queue`：

- 会话空闲 → 立刻压缩，回执规格与核心 `/compact` 一致（成功时带 `sourceEventSeq` 指向摘要事件）；
- 会话正忙 → 把请求排进**本会话**内存队列，等这个会话下一次 idle 自动补跑（最长等 30 分钟）；
- `/compact_queue cancel` → 排队中撤销、执行中 `abort()`。

三条设计红线：

1. **不改核心**。核心 `/compact`（`@deepseek-ai/dsh-command-compact`）在非严格 idle 时只回一句
   busy 就丢请求，这是它的口径；本插件另注册一条命令，不碰它。
2. **作用域必须落在 agent**。`compactNow` 要求严格 idle 的 agent，排队要盯的是**这一个 agent**
   的状态翻转，不是全局某个会话。
3. **回执不伪装成用户消息，也不唤醒模型**。后台完成后用 `form: 'notice'` 注入，UI 折叠成一行
   summary，不额外烧 token。

## 架构总览

```
cordis.patch.yml  (宿主层 insert 一行)
        │
        ▼
apply(ctx)                            ← 宿主 ctx，拿得到 agents / agentPresets / commands
  ├─ ctx.agents.list()  ──┐
  └─ on('agent/created') ─┴─► maybeAttach(agent)   (WeakSet 去重 + isLive 复核)
                                 │
                                 ▼
                        attach(ctx, agent)          ← 每个 agent 一份，所有注册挂在 agent.ctx
                          ├─ 状态机 state: none | queued | running（+ running 布尔锁）
                          ├─ agent.ctx.commands.register({ name: 'compact_queue' })   ← scoped 命令
                          ├─ agent.ctx.on('agent/status') → idle 翻转时 attempt(true)
                          ├─ setInterval(2s).unref()      → attempt(false)   ← 兜底 tick
                          ├─ performCompact() → ctx.agentPresets.serviceFor(agent,'compaction')
                          │                     .compactNow(agent, signal)   ← 跨 realm 取服务
                          └─ notify() → agent.inject(createUserMessage({ source: { form:'notice' } }))
```

三条官方接缝（对应 `index.js` 文件头注释的「一」）：

| 接缝 | 用法 | 为什么 |
|---|---|---|
| scoped 命令注册 | `agent.ctx.commands.register()` | 走 Cordis service tracing，注册进该 agent 的 scoped layer，只对它可见，随 agent scope 销毁自动卸载。在根 `ctx` 注册会全局可见 |
| 跨 realm 取服务 | `ctx.agentPresets.serviceFor(agent, 'compaction')` | compaction 挂在 preset 的 isolate realm，宿主层 `inject` 不到（注入发生在任何会话存在之前）。取不到就如实报错，不猜 |
| notice 注入 | `agent.inject(createUserMessage({ source: { kind:'compact-queue', form:'notice' } }))` | 与 `dsh-tool-jobs` 的完成通知同形制；不冒充 `kind:'user'`，不唤醒模型 |

**双通道触发**（缺一不可）：`agent/status` 只在 `idle ⇄ running` 字符串翻转时发射，而
`compactNow` 内部的 maintenance（idle→maintenance→idle）全程都是 idle、**不发事件**，所以除了
status 监听还要挂一个 2s 的 `unref()` tick 兜底；tick 同时承担 30 分钟超时判定。两条通道都汇进
同一个 `attempt()`，靠 `running` 布尔 + state 机保证不重叠。

## 模块结构图

```mermaid
graph TD
    A["(根) dsh_compact_queue<br/>@dongasai/dsh-compact-queue 0.1.0"] --> B["index.js<br/>宿主插件（唯一源码）"]
    A --> C["cordis.patch.yml<br/>bundle 补丁：宿主层一行 insert"]
    A --> D["package.json<br/>exports / files / dsh.bundle"]
    A --> E["README.md<br/>用法·状态机·失败映射"]
    A --> F["AGENTS.md<br/>本文件（架构与约束）"]
    B --> B1["apply(ctx)<br/>遍历已有 agent + 监听新建"]
    B --> B2["attach(ctx, agent)<br/>每个 agent 一份状态机"]
    B2 --> B3["命令 handler<br/>/compact_queue [cancel]"]
    B2 --> B4["attempt()<br/>status 事件 + 2s tick 双通道"]
    B2 --> B5["notify()<br/>notice 注入回执"]
    B4 --> B6["performCompact()<br/>serviceFor(agent,'compaction')"]

    click A "./AGENTS.md" "架构与约束"
    click B "./index.js" "唯一源码"
    click C "./cordis.patch.yml" "bundle 补丁"
    click D "./package.json" "包元数据"
    click E "./README.md" "用户文档"
```

## 模块索引

| 模块 | 路径 | 职责 | 入口 | 生命周期 |
|---|---|---|---|---|
| 宿主插件 | [index.js](index.js) | 遍历/监听 agent，为每个 agent 注册 scoped 命令 `/compact_queue` 并维护排队状态机，压缩完成/失败以 notice 回执 | `apply(ctx)` → `attach(ctx, agent)` | 宿主层加载；attach 出的监听器/定时器随 agent scope 卸载 |
| bundle 补丁 | [cordis.patch.yml](cordis.patch.yml) | `- insert:` 一行 `id: dsh-compact-queue`，把插件挂到宿主层 | — | profile 装载时读取 |
| 包元数据 | [package.json](package.json) | `name` / `exports` / `files` / `dsh.bundle.patch`；`private: true`，不进 npm 公共源 | — | — |
| 用户文档 | [README.md](README.md) | 安装（Web / git 源 / `link:` 三种装法 + 装完确认 + 卸）、命令与回执原文对照表、结构/扩展点占用、排错、两层验证、已知边界 | — | — |

`locale/` 是空目录（git 不跟踪），当前没有 i18n 资源。

## 运行与开发

| 目的 | 做法 |
|---|---|
| 装进 profile | 三条通路：Web 插件页「添加插件」→ 点「立即启用」；`dsh plugin --profile web add github:dongasai/dsh_compact_queue#0.1`；`link:<仓库绝对路径>`。`dsh plugin` 现在走 `@deepseek-ai/dsh-plugin-manager/operations`，装完由 `reconcile()` 把声明了 `dsh.bundle` 的包自动选进 `dsh.profile.bundles`，**不需要手写注册行**；当前 web profile 是 `"@dongasai/dsh-compact-queue": "github:dongasai/dsh_compact_queue#0.1"`（2026-10-20 10:30 从 `link:` 切到 git 源，解析到 tag `0.1` 的提交 `79bc3f9`），本仓改动**不再**自动生效 |
| 卸载 | `dsh plugin --profile web remove @dongasai/dsh-compact-queue`；`reconcile()` 会把它从 `dsh.profile.bundles` 一并摘掉，重启后命令消失 |
| 让改动生效 | **重启 `dsh web`**。宿主层插件，命令注册发生在 agent 创建时，热改不会给已有会话补注册；没有浏览器半边，不需要 `pnpm run dev:web` 之类的重建 |
| 手工冒烟 | 在 dsh web 会话里敲 `/compact_queue` 看回执；忙时再敲一次应回「已排队」并在下一次 idle 自动补跑（摘要以折叠 notice 出现） |
| 依赖安装 | **不要 `npm install`**，也**不要在本目录建 `node_modules`**：源码是原始 ESM、裸导入 `@deepseek-ai/*`，由 DSH profile resolver 路由到安装内副本。直接 `node index.js` 跑不起来是预期行为 |

## 测试策略

本仓库**没有自动化测试**（无 `test/`、无测试脚本、无 lint/格式化配置），验收靠人工冒烟。改状态机或
timer 逻辑时至少覆盖这五条：

1. **空闲直压**：idle 时 `/compact_queue` → 立即完成回执，带 `sourceEventSeq`。
2. **忙时排队**：running 时 `/compact_queue` → 回「已排队，最长 30 分钟」；本轮结束后自动补跑，摘要以 notice 出现。
3. **撤销**：排队中 `cancel` → 「已撤销」且不再触发；执行中 `cancel` → abort 生效，回执「压缩已取消」。
4. **重复入队**：排队中再次 `/compact_queue` → 报「已在队列中（约 N 分钟）」，不产生第二份压缩。
5. **agent 离场**：会话销毁时定时器清掉、执行中的压缩被 abort、日志无 unhandled rejection。

无可用压缩范围时 `compactNow` 返回 `null`，按终态成功处理（「当前没有可压缩的历史」），不重试——
这是刻意口径，不是 bug。`ManualCompactionError` 除 `busy` 外全部终态，避免坏循环烧摘要请求。

## 编码规范

- **ESM + tab 缩进 + 单引号**，与 `index.js` 现状一致；不引入第三方依赖（只用 `@deepseek-ai/dsh-*` 与 `node:` 内置）。
- 注释写**为什么**（哪个官方接缝、哪条源码注释支撑），不写「这里做了什么」的复述；文件头用编号小节承载设计决策。
- 用户可见文案一律中文，且与核心 `/compact` 的失败口径对齐（`FAILURE_TEXT` 逐条映射 `ManualCompactionError.code`）。
- 新增/修改回执必须保持 `form: 'notice'`；任何时候都不得把系统回执标成 `kind: 'user'`。
- 常量集中在文件头（`QUEUE_TICK_MS`、`MAX_WAIT_MS`），文案常量（`USAGE`、`FAILURE_TEXT`）放在函数之前。

## AI 使用指引

- **注册位置是硬约束**：命令只经 `agent.ctx.commands.register()` 注册，永远不要在根 `ctx` 上注册；监听器/定时器/teardown 一律走 `agent.ctx.effect(...)`，否则 agent 销毁后泄漏。
- **改队列逻辑前先读 `attempt()` 全文**：`state`、`running`、`activeAbort`、`watcher` 四个变量互相牵制，只改一条通道（status 或 tick）会破坏「不重叠」保证。
- **别顺手"优化"乐观排队**：handler 先置 `queued` 再立刻试一次是刻意设计——省掉二次竞态判定，代价只是忙时多一次无副作用调用。
- **两条已知问题在 README 末尾有账**：① tick 通道命中 30 分钟超时是静默取消（`attempt(false)` 不发 notice）；② `attempt()` 开头连续两次 `isLive()` 属死代码。修任一条要同步更新 README 的「已知边界」。
- **发版口径**：`package.json.version` 与 tag 同步（当前 `0.1.0` ↔ 附注 tag `0.1`，不带 `v`，与 `gitea_task_issues` 一致）；远端 `origin` = `git@github.com:dongasai/dsh_compact_queue.git`，发版＝本地提交 → `git tag -a 0.1 -m …` → `git push origin main` 与 `git push origin 0.1` 两条都推（只推分支会丢 tag）。
- 提交信息沿用 `类型(范围): 中文描述`（已落地的两条：`功能(压缩排队):`、`文档(接入):`）。

## 变更记录

- **2026-10-20T11:15+08:00** 安装章节按 gitea README 的写法重写：恢复「Web 界面装法」（插件页 → 添加插件 → 立即启用，第六版误判为不存在）、删掉「必须手写 `dsh.profile.bundles`」的错误步骤（`dsh plugin` 已走 `@deepseek-ai/dsh-plugin-manager/operations`，装完由 `reconcile()` 自动选中 bundle）、补齐「副本 vs `link:`」区别、无构建步骤说明、装完 `--dump-config | grep -A1` 的实测三行输出与 `systemctl --user restart dsh.service` 提示。
- **2026-10-20T11:05+08:00** 按插件 README 编写规范（`note/readme-spec.md` §2.3）重写 README 安装章节：改成「装 → 登记 bundles → 重启 → 确认」四步编号（每步带命令 + 期望输出），明说没有 registry 装法且插件市场搜不到，补「首次配置：没有」的「情况 → 显示 → 动作」表；`--dump-config` 期望输出改为本机实测三行；删掉重复的独立「确认它真的在工作」「生效条件」两节（并入第 3、4 步）。
- **2026-10-20T10:05+08:00** 按「dsh 插件 README 编写经验」重写 README：补三种装法与四条坑（`--profile` 必填、`bundles` 清单必须手加、`github:` 前缀、tag 必须真实）、回执原文对照表、扩展点占用表、两层验证、已知边界逐条带原因与代价；同时纠正旧 README 的装法——`plugin_manager` 是桌面端内置工具，本环境没有，登记 bundles 也不会由 `dsh plugin` 代劳。
- **2026-10-20T09:52+08:00** 远端落定：`origin` = `git@github.com:dongasai/dsh_compact_queue.git`（新建空仓，`git ls-remote` 无任何 ref）；附注 tag `0.1` 重挂到本提交后与 `main` 一并推送。
- **2026-10-19T20:46+08:00** 初始化架构文档：新增本文件与 `.agents/index.json`；扫描覆盖 4/4 个被跟踪文件（100%）。无子模块，故不生成下级 `AGENTS.md`。
- **2026-10-19T20:29+08:00** `29c6b52 文档(接入): 补 cordis.patch.yml 与 README，使包可按 bundle 装入 profile`
- **2026-10-19T20:20+08:00** `c8b85bf 功能(压缩排队): agent 作用域 /compact_queue 命令，busy 时排队、下次 idle 自动补跑`
