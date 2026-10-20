/**
 * @module @dongasai/dsh-compact-queue
 *
 * **命令 `/compact_queue`：压缩排队。**
 *
 * 核心 `/compact`（@deepseek-ai/dsh-command-compact）在会话忙时只回一句
 * busy 错误就丢弃请求。本插件不改核心，另注册一条命令：空闲时立即压缩，
 * 忙时把请求排在**本会话**队列里，等下一次 idle 自动补跑。
 *
 * ## 一、命令在宿主层全局注册，状态机按 agent 分流
 *
 * 曾经想用 `agent.ctx.commands.register()` 让命令只对单个 agent 可见，
 * 实测行不通：宿主层插件拿到的 `agent.ctx` 是
 * `createScope(loopCtx, agent)` 产出的 scope context（dsh-agent-loop 构造函数
 * `this.scope = createScope(loopCtx, this)`），它的 backing fiber 是一个
 * 没有任何 `inject` 的占位插件。Cordis 的服务解析从该 fiber 沿父链逐级查
 * `fiber.store[prop]`（cordis `ReflectService.handler.get`），而 `commands`
 * 服务注册在宿主另一条分支上，不在这条链里——于是取属性直接抛
 * `cannot get property "commands" without inject`。dsh-commands 里那句
 * 「per-agent variant 请 mount 到 agent.ctx」对**宿主层**插件是空头支票：
 * 要能解析服务，得先能拿到服务。
 *
 * 所以命令走宿主 ctx 的**全局注册**，与核心 `/compact`、`/permission`、
 * `/plan-mode` 同一形制；agent 维度不靠注册作用域，靠 handler 的
 * `invocation.agent`（dsh-commands 构造 invocation 时必带 agent）落到该
 * agent 自己的状态机。排队语义因此仍然严格按会话隔离。
 *
 * **跨 realm 取压缩服务**：compaction 实现挂在 preset 的 isolate realm 里，
 * 宿主层 `inject` 不到（注入发生在任何会话存在之前，没有 agent 可作键）。
 * 宿主侧「已经持有 agent」的调用方用
 * `ctx.agentPresets.serviceFor(agent, 'compaction')` 寻址——registry 源码注释
 * （serviceForAgent）明确这就是它的用途。拿不到就如实报错，不猜。
 *
 * `agent/status` 监听与 timer 仍然挂在 `agent.ctx` 上：`on` / `effect` 是
 * Context 自身的成员，不触发服务解析，可用，且随 agent scope 销毁自动卸载。
 *
 * ## 二、排队怎么触发（事件 + tick 双保险）
 *
 * `agent/status` 只在 `idle ⇄ running` **字符串翻转**时发射；`compactNow`
 * 内部的 maintenance（idle→maintenance→idle）全程都是 idle，不发事件。所以
 * 除 status 监听外再挂一个低频 tick（QUEUE_TICK_MS）兜底，并在 tick 里做
 * 最长等待（MAX_WAIT_MS）超时判定。tick 用 `unref()`，不拖进程退出；两条
 * 通道都进同一个 `attempt()`，`running` 布尔 + state 机保证不重叠执行。
 *
 * ## 三、回执不伪装成用户消息
 *
 * 排队执行的完成/失败用 `agent.inject(createUserMessage({ …, source: {
 * kind: 'compact-queue', form: 'notice', summary } }))` 注入：notice 形制是
 * 宿主给 UI 的结构化回执（折叠一行 summary），inject 不唤醒模型、不额外烧
 * token；命令的**即时**返回走 CommandResult 文本（成功时带 sourceEventSeq
 * 指向摘要事件，与核心 /compact 同规格）。绝不把系统回执标成 `kind:'user'`。
 *
 * ## 四、失败口径
 *
 * ManualCompactionError 的 code 逐一映射（busy 之外都是终态，不再重试，
 * 避免坏循环烧摘要请求）；compactNow 返回 null（没有可压缩范围）视为终态
 * 成功。取消词 `cancel`：排队中 → 撤销；执行中 → abort 其 signal。
 */

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'compact-queue';
export const inject = ['commands', 'agents', 'agentPresets'];

const USAGE = 'Usage: /compact_queue（排队或立即压缩）或 /compact_queue cancel（撤销）';
const QUEUE_TICK_MS = 2000;
const MAX_WAIT_MS = 30 * 60 * 1000;

/** ManualCompactionError.code（busy 除外）到人类文案，口径对齐核心 /compact。 */
const FAILURE_TEXT = {
	cancelled: '压缩已取消。',
	changed: '选定的历史在替换前发生了变化，本次未执行。详情见会话日志。',
	summary: '未能生成有效摘要。详情见会话日志。',
	commit: '压缩未正常结束，部分历史可能已变动；请先检查会话状态再重试。',
	persistence: '压缩已完成，但会话未能保存。',
};

/**
 * 一个 agent 的完整状态机。
 * 返回该 agent 的命令执行入口；监听器/timer 挂在 agent.ctx 上，随 scope 卸载。
 */
function attach(ctx, agent) {
	/** 'none' | 'queued' | 'running'（running 只在 attempt 的 await 窗口内设置） */
	let state = 'none';
	let enqueuedAt = 0;
	let running = false;
	let watcher;
	let activeAbort;

	const isLive = () => {
		try {
			return ctx.agents.get(agent.id) === agent;
		} catch {
			return false;
		}
	};

	const stopQueue = () => {
		state = 'none';
		enqueuedAt = 0;
		if (watcher !== undefined) {
			clearInterval(watcher);
			watcher = undefined;
		}
	};

	const startWatch = () => {
		if (watcher !== undefined) return;
		watcher = setInterval(() => {
			void attempt(false);
		}, QUEUE_TICK_MS);
		if (typeof watcher.unref === 'function') watcher.unref();
	};

	/** 后台完成/失败 → notice 注入（不唤醒模型）。 */
	const notify = (text, summary) => {
		if (!isLive()) return;
		try {
			agent.inject(createUserMessage({
				content: [{ type: 'text', text }],
				source: {
					kind: 'compact-queue',
					form: 'notice',
					summary: boundContextSummary(summary ?? text),
				},
			}));
		} catch (error) {
			ctx.logger.warn('compact-queue: notice inject failed for %s: %o', agent.id, error);
		}
	};

	/** 执行一次压缩。返回 outcome；busy 时不改 state（由调用方决定排队或报错）。 */
	async function performCompact(signal) {
		let compaction;
		try {
			compaction = ctx.agentPresets.serviceFor(agent, 'compaction');
		} catch (error) {
			ctx.logger.warn('compact-queue: serviceFor failed: %o', error);
			compaction = undefined;
		}
		if (compaction === undefined) {
			return { kind: 'fatal', text: '本会话挂载的 agent preset 没有提供 compaction 服务，无法压缩。' };
		}
		try {
			const result = await compaction.compactNow(agent, signal);
			if (result === null) return { kind: 'empty' };
			return { kind: 'done', result };
		} catch (error) {
			if (error instanceof ManualCompactionError) {
				if (error.code === 'busy') return { kind: 'busy' };
				return { kind: 'fatal', text: FAILURE_TEXT[error.code] ?? `压缩失败（${String(error.code)}）。` };
			}
			if (signal?.aborted) return { kind: 'fatal', text: '压缩已取消。' };
			return { kind: 'fatal', text: `压缩失败：${String(error instanceof Error ? error.message : error)}` };
		}
	}

	/** 排队通道的一次尝试。handler 首次乐观尝试不经此函数（不走 notify）。 */
	async function attempt(fromQueue) {
		if (state !== 'queued' || running || !isLive()) return;
		if (!isLive()) {
			stopQueue();
			return;
		}
		if (Date.now() - enqueuedAt > MAX_WAIT_MS) {
			stopQueue();
			if (fromQueue !== false) {
				notify(
					`/compact_queue 排队超时（等待超过 ${Math.round(MAX_WAIT_MS / 60000)} 分钟，会话一直未空闲），本次压缩已取消。`,
					'compact_queue 排队超时，已取消',
				);
			}
			return;
		}
		running = true;
		const ac = new AbortController();
		activeAbort = ac;
		let outcome;
		try {
			outcome = await performCompact(ac.signal);
		} finally {
			running = false;
			activeAbort = undefined;
		}
		if (state !== 'queued') return; // 排队已被命令取消/接管
		if (outcome.kind === 'busy') return; // 会话仍忙，继续等下一个 idle
		stopQueue();
		if (outcome.kind === 'done') {
			const { shadowedSeqs, shadowedTokenCount } = outcome.result;
			notify(
				`排队压缩完成：压缩了 ${shadowedSeqs.length} 条历史（约 ${shadowedTokenCount} tokens）。`,
				`排队压缩完成：${shadowedSeqs.length} 条 ~${shadowedTokenCount} tokens`,
			);
			return;
		}
		if (outcome.kind === 'empty') {
			notify('排队压缩完成前检查：当前没有可压缩的历史。', '排队压缩：没有可压缩的历史');
			return;
		}
		notify(`排队压缩失败：${outcome.text}`, '排队压缩失败');
	}

	// idle 事件 + tick 双保险（见文件头「二」）。
	agent.ctx.on('agent/status', ({ status }) => {
		if (status === 'idle' && state === 'queued') void attempt(true);
	});
	agent.ctx.effect(() => () => {
		if (watcher !== undefined) clearInterval(watcher);
		watcher = undefined;
	}, 'compact-queue watch');

	// agent 离场即收摊（timer/status 随 scope 卸载，这里只兜住执行中的 abort 与状态）。
	const dispose = () => {
		if (activeAbort !== undefined) activeAbort.abort();
		stopQueue();
	};
	agent.ctx.effect(dispose, 'compact-queue teardown');

	/** 该 agent 的命令入口（由宿主层唯一的全局命令按 invocation.agent 分派进来）。 */
	return async function runCommand(invocation) {
		const input = invocation.rawInput.trim();
		if (input === 'cancel') {
			if (state === 'queued') {
				stopQueue();
				return { kind: 'success', text: '已撤销排队的压缩。' };
			}
			if (running && activeAbort !== undefined) {
				activeAbort.abort();
				return { kind: 'success', text: '正在取消执行中的压缩。' };
			}
			return { kind: 'error', text: '当前没有排队的压缩。' };
		}
		if (input !== '') return { kind: 'error', text: USAGE };
		if (running || state === 'running') return { kind: 'error', text: '压缩正在执行中。' };
		if (state === 'queued') {
			const waitedMin = Math.max(1, Math.round((Date.now() - enqueuedAt) / 60000));
			return { kind: 'error', text: `压缩已在队列中（已排队约 ${waitedMin} 分钟）。/compact_queue cancel 可撤销。` };
		}
		// 乐观排队后立刻试一次：busy 时队列已经就位，省去二次竞态判定。
		state = 'queued';
		enqueuedAt = Date.now();
		startWatch();
		running = true;
		let outcome;
		try {
			outcome = await performCompact(invocation.signal);
		} finally {
			running = false;
		}
		if (outcome.kind === 'busy') {
			return {
				kind: 'success',
				text: `会话正忙，压缩已排队：将在本会话下一次空闲时自动执行（最长等待 ${Math.round(MAX_WAIT_MS / 60000)} 分钟）。/compact_queue cancel 可撤销。`,
			};
		}
		stopQueue();
		if (outcome.kind === 'done') {
			const { shadowedSeqs, shadowedTokenCount, summarySeq } = outcome.result;
			return {
				kind: 'success',
				text: `压缩完成：${shadowedSeqs.length} 条历史（约 ${shadowedTokenCount} tokens）。`,
				sourceEventSeq: summarySeq,
			};
		}
		if (outcome.kind === 'empty') return { kind: 'success', text: '当前没有可压缩的历史。' };
		return { kind: 'error', text: outcome.text };
	};
}

export function apply(ctx) {
	const attached = new WeakSet();
	/** agent → 该 agent 的命令入口；命令全局唯一，具体状态按 invocation.agent 取。 */
	const machines = new WeakMap();

	const maybeAttach = (agent) => {
		if (attached.has(agent) || !isLive(ctx, agent)) return undefined;
		attached.add(agent);
		try {
			const run = attach(ctx, agent);
			machines.set(agent, run);
			return run;
		} catch (error) {
			ctx.logger.warn('compact-queue: attach failed for %s: %o', agent?.id, error);
			return undefined;
		}
	};

	for (const agent of ctx.agents.list()) maybeAttach(agent);
	ctx.on('agent/created', ({ agent }) => {
		maybeAttach(agent);
	});

	// 宿主层全局注册（见文件头「一」）。disposer 由 Cordis 挂在插件 fiber 上。
	ctx.commands.register({
		definitionId: CommandDefinitionId('@dongasai/dsh-compact-queue'),
		name: 'compact_queue',
		description: 'Compact now, or queue the compaction until this session next goes idle',
		handler: (invocation) => {
			const run = machines.get(invocation.agent) ?? maybeAttach(invocation.agent);
			if (run === undefined) {
				return { kind: 'error', text: '本会话的压缩排队状态机尚未就绪，请重新发送一次。' };
			}
			return run(invocation);
		},
	});
}

function isLive(ctx, agent) {
	try {
		return ctx.agents.get(agent.id) === agent;
	} catch {
		return false;
	}
}
