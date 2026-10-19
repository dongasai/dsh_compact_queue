# @dongasai/dsh-compact-queue

给每个会话一条 **能排队** 的压缩命令：`/compact_queue`。

核心 `/compact` 只认「严格 idle 的 agent」——`compactNow` 底下的 `runMaintenance` 在非 idle 时
直接 throw，外层包成 `ManualCompactionError('busy')`，命令层把它原样转成一句报错回执就完事。
会话正忙（上一轮还没收尾、maintenance 还没跑完）时想压一下历史，只能等、只能反复敲。

本插件**不改核心**，另注册一条 agent 作用域命令：

- 空闲时 → 立刻压缩，回执规格与核心 `/compact` 一致；
- 忙时 → 把请求排进**本会话**队列，等这个会话下一次 idle 自动补跑；
- `/compact_queue cancel` → 排队中撤销、执行中 abort。

## 用法

| 输入 | 行为 |
|---|---|
| `/compact_queue` | 立即尝试；会话忙则排队（回执写明「已排队，最长等 30 分钟」与撤销方式） |
| `/compact_queue cancel` | 排队中 → 撤销；执行中 → abort 其 signal；都没有 → 报错「当前没有排队的压缩」 |
| `/compact_queue <其它>` | 回用法提示，不执行 |

压缩完成的即时回执会带 `sourceEventSeq` 指向摘要事件（与核心 `/compact` 同规格）。

## 排队状态机

每个 agent 一份独立状态（`none` / `queued` / `running`），队列只存在于内存：

| 机制 | 说明 |
|---|---|
| 乐观排队 | handler 先把 state 置 `queued`、再立刻试一次 → 忙的话队列已经就位，省掉二次竞态判定 |
| 双通道触发 | `agent/status` 的 idle 翻转 + 每 2s 的兜底 tick。因为 maintenance 全程仍是 idle、不发事件，只等事件会漏触发 |
| 不重叠 | `running` 布尔锁 + 状态机，两条通道都汇进同一个 `attempt()` |
| 最长等待 | 30 分钟；超时清队列并回执 |
| 收摊 | 监听器/定时器/teardown 全挂在 `agent.ctx` 上，随 agent scope 销毁自动卸载；agent 离场时 abort 执行中的压缩 |

`unref()` 的 tick 不拖住进程退出；队列**不持久化**，dsh 重启即丢（这是有意的取舍：压缩请求本身就是一次性的）。

## 回执口径

后台完成/失败用 notice 注入，不唤醒模型、不额外烧 token：

```js
agent.inject(createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'compact-queue', form: 'notice', summary },
}))
```

形制与 `dsh-tool-jobs` 的完成通知一致（UI 折叠成一行 summary）。**不会**把系统回执标成 `kind: 'user'`。

## 失败映射

`ManualCompactionError.code` 逐项处理：只有 `busy` 继续排队等，其余都是终态、不再重试（避免坏循环烧摘要请求）。

| code | 回执 |
|---|---|
| `busy` | 不中断，继续等下一次 idle |
| `cancelled` | 压缩已取消 |
| `changed` | 选定历史在替换前发生变化，本次未执行 |
| `summary` | 未能生成有效摘要 |
| `commit` | 压缩未正常结束，部分历史可能已变动 |
| `persistence` | 压缩已完成，但会话未能保存 |

`compactNow` 返回 `null`（没有可压缩范围）按「没有可压缩历史」的终态成功处理，不重试。

## 装 / 卸

```bash
# 装
plugin_manager(action="install_bundle", target="/data/ai/dsh/dsh_compact_queue")

# 卸
plugin_manager(action="remove_bundle", target="@dongasai/dsh-compact-queue")
```

装完 `profiles/web/package.json` 里会多一条
`"@dongasai/dsh-compact-queue": "link:/data/ai/dsh/dsh_compact_queue"`，并把包名加进 `dsh.profile.bundles`。

**宿主层插件，改完必须重启 `dsh web`**（命令注册在 agent 创建时发生，热改不会补注册已有会话）。

## 依赖与边界

- `inject: ['commands', 'agents', 'agentPresets']`：需要宿主层的 agent 注册表与预设注册表
- 压缩服务跨 realm 取：`ctx.agentPresets.serviceFor(agent, 'compaction')`。取不到就如实报「本会话挂载的 preset 没有提供 compaction 服务」，不猜
- 命令注册只经 `agent.ctx.commands.register()`（绝不在根 ctx 注册，否则全局可见）
- 源码是原始 ESM、依赖 `@deepseek-ai/*` 裸导入：**不要在插件目录装 node_modules** ——
  DSH 的 profile resolver 会把 linked 插件的裸包名路由到安装内副本；独立 `node index.js` 跑不起来是预期

## 已知问题

- 排队超时可能静默取消：tick 通道调 `attempt(false)`，而超时分支只在 `fromQueue !== false` 时回执。
  会话一直忙到 30 分钟、期间没有 idle 事件时，只有 tick 会命中超时 → 队列清掉但用户收不到回执
- `attempt()` 开头已判过一次 `isLive()`，紧接着又重复一次，属死代码
