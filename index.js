/**
 * @module @dongasai/dsh-compact-queue
 *
 * **命令族 `/compact_queue*`：压缩排队。**
 *
 * 核心 `/compact`（@deepseek-ai/dsh-command-compact）在会话忙时只回一句
 * busy 错误就丢弃请求。本插件不改核心，另注册四条**无参数**命令：
 *
 * - `/compact_queue`：空闲时立即压缩；忙时排进**本会话**队列，最长等 24 小时；
 * - `/compact_queue_unlimited`：同上，但不设超时，一直等到本会话空闲；
 * - `/compact_queue_auto`：切换本会话每次空闲自动压缩（见「五」）；
 * - `/compact_queue_cancel`：撤销排队 / abort 执行中的压缩，并顺手关掉 auto。
 *
 * 不用参数是有原因的：DSH 的斜杠命令输入 UX 只认命令名，带空格的
 * `/compact_queue auto` 会被整段当成普通消息发给模型（命令解析器的
 * `rawInput` 虽在，但前端不会把参数送进来）。所以每种动作各占一个命令名。
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
 * 最长等待（MAX_WAIT_MS）超时判定；`/compact_queue_unlimited` 排入的请求 unlimited=true，
 * 跳过超时判定，一直等到本会话空闲（或被 `/compact_queue_cancel` / 会话销毁）。tick 用 `unref()`，不拖进程退出；两条
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
 * 成功。取消命令 `/compact_queue_cancel`：排队中 → 撤销；执行中 → abort 其 signal；auto
 * 开着时一并关掉，免得撤销完下一轮 idle 又自动排上。
 *
 * ## 五、auto：每次空闲自动压一次，且不递归
 *
 * `/compact_queue_auto` 切换**本会话**的自动压缩。它只挂在 `agent/status` 的
 * idle 翻转上（见上「二」），**不启动 tick、不排队**：
 *
 * - 一轮 AI 结束：idle → running → idle，最后一次翻转发 idle 事件 → 压一次；
 * - 压缩自身的 maintenance：agent-loop 的 `status` getter 把 `maintenance` 也算
 *   `idle`，`setPhase` 不翻转就不发事件 → **压缩不会触发下一次压缩**；
 * - 完成回执走 `agent.inject`（`send(..., wakeup=false)` + `form:'notice'`），
 *   不唤醒模型、不产生新的 running→idle 翻转。
 *
 * 三条合起来就是「不递归压缩」的保证：只有**新一轮 AI 结束**才会再压一次。
 * 若压完没有新消息，auto 会安静停在那里，不会因为自己的回执或 maintenance
 * 反复压。busy 只跳过本次（不排队重试），等下一次 idle 再来。
 *
 * ## 六、最少历史消息数门槛
 *
 * 核心 `compactNow` 只要 2 条 surface 节点就肯压（`selectCompactableRange` 传
 * `retainTokens=0`，首条是 system 消息时要 3 条）。太短的会话压一次只烧摘要
 * 请求、换不回多少上下文，所以三条触发路径（手动命令、排队补跑、auto）统一
 * 在调用 `compactNow` 之前检查 `agent.session.surface.nodes.length`：不足
 * MIN_MESSAGES 就跳过，连摘要请求都不发。门槛只在插件侧，核心没改。
 */

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand';
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'compact-queue';
export const inject = ['commands', 'agents', 'agentPresets'];

const USAGE = '可用命令：/compact_queue（排队或立即压缩）· /compact_queue_unlimited（无限等待）· /compact_queue_auto（切换本会话自动压缩）· /compact_queue_cancel（撤销）';
const AUTO_ON_TEXT = '已开启本会话自动压缩：每次会话回到空闲时压缩一次（历史不足 10 条会跳过，压缩自身不会触发再次压缩）。/compact_queue_auto 可关闭。';
const AUTO_OFF_TEXT = '已关闭本会话自动压缩。';
/** 历史消息数低于此值不压缩：核心 2 条就肯压，太短的会话只烧摘要请求、换不回上下文。 */
const MIN_MESSAGES = 10;
const QUEUE_TICK_MS = 2000;
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
/** 回执展示用的最长等待时长（与 MAX_WAIT_MS 联动，改成小时后不再误显示成分钟数）。 */
const MAX_WAIT_TEXT = `${MAX_WAIT_MS / (60 * 60 * 1000)} 小时`;

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
	/** `/compact_queue_unlimited` 置位：跳过 MAX_WAIT_MS 超时，无限等待本会话空闲。 */
	let unlimited = false;
	/** `/compact_queue_auto` 置位：本会话每次 idle 翻转自动压一次，默认关闭。 */
	let autoEnabled = false;
	let watcher;
	let activeAbort;

	const isLive = () => {
		try {
			return ctx.agents.get(agent.id) === agent;
		} catch {
			return false;
		}
	};

	/** 当前会话 surface 节点数；拿不到返回 null（不拦截，交给核心判断）。 */
	const messageCount = () => {
		try {
			const count = agent.session?.surface?.nodes?.length;
			return typeof count === 'number' ? count : null;
		} catch {
			return null;
		}
	};
	const belowMin = (count) => count !== null && count < MIN_MESSAGES;

	const stopQueue = () => {
		state = 'none';
		enqueuedAt = 0;
		unlimited = false;
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
		if (!unlimited && Date.now() - enqueuedAt > MAX_WAIT_MS) {
			stopQueue();
			if (fromQueue !== false) {
				notify(
					`/compact_queue 排队超时（等待超过 ${MAX_WAIT_TEXT}，会话一直未空闲），本次压缩已取消。`,
					'compact_queue 排队超时，已取消',
				);
			}
			return;
		}
		const count = messageCount();
		if (belowMin(count)) {
			stopQueue();
			notify(
				`排队压缩跳过：当前历史消息 ${count} 条，不足 ${MIN_MESSAGES} 条，本次未执行。`,
				`排队压缩跳过：${count}/${MIN_MESSAGES} 条`,
			);
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

	/**
	 * auto 通道：只在 agent/status 的 idle 翻转里调用一次，不排队、不启动 tick。
	 * 压缩自身的 maintenance 全程 idle、不发事件，notice 也不唤醒模型，
	 * 所以压完不会再触发自己（见文件头「五」）——只有新一轮 AI 结束才再压。
	 */
	async function autoCompact() {
		if (!autoEnabled || running || state !== 'none' || !isLive()) return;
		const count = messageCount();
		if (belowMin(count)) {
			notify(
				`自动压缩跳过：当前历史消息 ${count} 条，不足 ${MIN_MESSAGES} 条，未执行压缩。`,
				`自动压缩跳过：${count}/${MIN_MESSAGES} 条`,
			);
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
		if (ac.signal.aborted) return; // cancel 已撤销：静默收尾，不再回执
		if (outcome.kind === 'busy') return; // 会话被占用：跳过本次，不排队重试，等下一次 idle
		if (outcome.kind === 'done') {
			const { shadowedSeqs, shadowedTokenCount } = outcome.result;
			notify(
				`自动压缩完成：压缩了 ${shadowedSeqs.length} 条历史（约 ${shadowedTokenCount} tokens）。`,
				`自动压缩完成：${shadowedSeqs.length} 条 ~${shadowedTokenCount} tokens`,
			);
			return;
		}
		if (outcome.kind === 'empty') {
			notify('自动压缩检查：当前没有可压缩的历史。', '自动压缩：没有可压缩的历史');
			return;
		}
		notify(`自动压缩失败：${outcome.text}`, '自动压缩失败');
	}

	// idle 事件 + tick 双保险（见文件头「二」）；auto 只吃 idle 翻转（见「五」）。
	agent.ctx.on('agent/status', ({ status }) => {
		if (status !== 'idle') return;
		if (state === 'queued') void attempt(true);
		else if (autoEnabled) void autoCompact();
	});
	agent.ctx.effect(() => () => {
		if (watcher !== undefined) clearInterval(watcher);
		watcher = undefined;
	}, 'compact-queue watch');

	// agent 离场即收摊（timer/status 随 scope 卸载，这里只兜住执行中的 abort 与状态）。
	const dispose = () => {
		autoEnabled = false;
		if (activeAbort !== undefined) activeAbort.abort();
		stopQueue();
	};
	agent.ctx.effect(dispose, 'compact-queue teardown');

	/**
	 * 该 agent 的命令入口。宿主层注册的四条命令共用此 handler，用 mode 区分动作，
	 * 再按 invocation.agent 落到各自状态机。若某客户端真能把 rawInput 送进来，
	 * 旧写法 `/compact_queue auto|~|cancel` 仍然兼容，只是不再依赖它。
	 */
	return async function runCommand(mode, invocation) {
		if (mode === 'normal') {
			const input = invocation.rawInput.trim();
			if (input === 'auto') mode = 'auto';
			else if (input === 'cancel') mode = 'cancel';
			else if (input === '~') mode = 'unlimited';
			else if (input !== '') return { kind: 'error', text: USAGE };
		}
		if (mode === 'auto') {
			autoEnabled = !autoEnabled;
			return { kind: 'success', text: autoEnabled ? AUTO_ON_TEXT : AUTO_OFF_TEXT };
		}
		if (mode === 'cancel') {
			const wasAuto = autoEnabled;
			autoEnabled = false; // 连带关掉，免得撤销完下一轮 idle 又自动排上
			if (state === 'queued') {
				stopQueue();
				return { kind: 'success', text: wasAuto ? '已撤销排队的压缩，并关闭自动压缩。' : '已撤销排队的压缩。' };
			}
			if (running && activeAbort !== undefined) {
				activeAbort.abort();
				return { kind: 'success', text: wasAuto ? '正在取消执行中的压缩，并关闭自动压缩。' : '正在取消执行中的压缩。' };
			}
			return { kind: 'success', text: wasAuto ? '已关闭自动压缩（当前没有排队的压缩）。' : '当前没有排队的压缩。' };
		}
		const wantUnlimited = mode === 'unlimited';
		if (running || state === 'running') return { kind: 'error', text: '压缩正在执行中。' };
		if (state === 'queued') {
			const waitedMin = Math.max(1, Math.round((Date.now() - enqueuedAt) / 60000));
			return { kind: 'error', text: `压缩已在队列中（已排队约 ${waitedMin} 分钟）。/compact_queue_cancel 可撤销。` };
		}
		const count = messageCount();
		if (belowMin(count)) {
			return { kind: 'success', text: `当前历史消息 ${count} 条，不足 ${MIN_MESSAGES} 条，未压缩。` };
		}
		// 乐观排队后立刻试一次：busy 时队列已经就位，省去二次竞态判定。
		state = 'queued';
		enqueuedAt = Date.now();
		unlimited = wantUnlimited;
		startWatch();
		running = true;
		let outcome;
		try {
			outcome = await performCompact(invocation.signal);
		} finally {
			running = false;
		}
		if (outcome.kind === 'busy') {
			const waitDesc = wantUnlimited ? '无限等待，不设超时' : `最长等待 ${MAX_WAIT_TEXT}`;
			return {
				kind: 'success',
				text: `会话正忙，压缩已排队：将在本会话下一次空闲时自动执行（${waitDesc}）。/compact_queue_cancel 可撤销。`,
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

	// 宿主层全局注册（见文件头「一」）。四条无参命令共用同一状态机，按 mode 分派。
	const COMMANDS = [
		{ name: 'compact_queue', mode: 'normal', description: 'Compact now, or queue until next idle (max 24h)' },
		{ name: 'compact_queue_unlimited', mode: 'unlimited', description: 'Compact now, or queue until next idle with no timeout' },
		{ name: 'compact_queue_auto', mode: 'auto', description: 'Toggle per-session auto compaction on every idle' },
		{ name: 'compact_queue_cancel', mode: 'cancel', description: 'Cancel queued/running compaction and turn auto off' },
	];
	for (const def of COMMANDS) {
		ctx.commands.register({
			definitionId: CommandDefinitionId('@dongasai/dsh-compact-queue'),
			name: def.name,
			description: def.description,
			handler: (invocation) => {
				const run = machines.get(invocation.agent) ?? maybeAttach(invocation.agent);
				if (run === undefined) {
					return { kind: 'error', text: '本会话的压缩排队状态机尚未就绪，请重新发送一次。' };
				}
				return run(def.mode, invocation);
			},
		});
	}
}

function isLive(ctx, agent) {
	try {
		return ctx.agents.get(agent.id) === agent;
	} catch {
		return false;
	}
}
