import z from '@deepseek-ai/schemastery';
import { ConfirmState, isSubagentSession, } from './state.js';
export const name = 'dsh-task-confirm';
export const inject = ['systemPrompt', 'tools'];
const DEFAULT_MARKER = '【任务理解】';
const DEFAULT_READ_ONLY_TOOLS = [
    'read',
    'read_image',
    'glob',
    'grep',
    'web_fetch',
    'web_search',
    'skill',
    'todo_write',
    'session_search',
    'session_trace',
    'session_event_read',
    'session_event_search',
    'session_event_trace',
    'get_goal',
    'list_subagent_models',
    'ask_user_question',
    'job_list',
    'job_output',
    'schedule_list',
    'terminal_list',
    'terminal_read',
];
const DEFAULT_CANCEL_WORDS = ['取消', '算了', '不做了', 'cancel'];
const DEFAULT_CONFIRM_WORDS = ['继续', '确认', '开始', '执行', '可以', 'ok', 'continue', 'confirm', 'go'];
const DEFAULT_PENDING_TTL_MS = 2 * 60 * 60 * 1000;
/** Exact Fetch routes must carry the full pathname the `/api` channel serves. */
const STATUS_ROUTE = '/api/task-confirm/status';
const CANCEL_ROUTE = '/api/task-confirm/cancel';
export const Config = z.object({
    // Volatile fields are the ones the host Settings UI can expose; the plugin
    // reads them through refs and applies changes without a remount.
    enabled: z.boolean().default(true).volatile(),
    marker: z.string().default(DEFAULT_MARKER).volatile(),
    readOnlyTools: z.array(z.string()).default([...DEFAULT_READ_ONLY_TOOLS]).volatile(),
    cancelWords: z.array(z.string()).default([...DEFAULT_CANCEL_WORDS]).volatile(),
    confirmWords: z.array(z.string()).default([...DEFAULT_CONFIRM_WORDS]).volatile(),
    pendingTtlMs: z
        .number()
        .step(1)
        .min(0)
        .max(30 * 24 * 60 * 60 * 1000)
        .default(DEFAULT_PENDING_TTL_MS)
        .volatile(),
});
const UNDERSTANDING_SENT_REASON = '任务理解已经输出。现在结束本轮，等待用户回复；不要调用任何工具。';
function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : undefined;
}
/** Schemastery delivers a `.volatile()` field as a ref the Loader swaps in place. */
function live(value) {
    if (value !== null && typeof value === 'object') {
        const get = value.get;
        if (typeof get === 'function')
            return get.call(value);
    }
    return value;
}
function touchesField(paths, field) {
    return paths.some((path) => path.length === 1 && path[0] === field);
}
function assistantText(event) {
    const data = asRecord(event.data);
    const message = asRecord(data?.message);
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        const typed = asRecord(block);
        if (typed?.type === 'text' && typeof typed.text === 'string')
            parts.push(typed.text);
    }
    return parts.join('\n').trim();
}
function turnEndKind(event) {
    const data = asRecord(event.data);
    const reason = asRecord(data?.reason);
    return typeof reason?.kind === 'string' ? reason.kind : 'unknown';
}
function userTexts(messages) {
    if (!messages)
        return [];
    const texts = [];
    for (const message of messages) {
        if (message.role !== 'user' || message.source?.kind !== 'user')
            continue;
        if (!Array.isArray(message.content))
            continue;
        const parts = [];
        for (const block of message.content) {
            const typed = asRecord(block);
            if (typed?.type === 'text' && typeof typed.text === 'string')
                parts.push(typed.text);
        }
        const text = parts.join('\n').trim();
        if (text)
            texts.push(text);
    }
    return texts;
}
/** A human turn is decided by the message producer, not by whether it carried text. */
function hasHumanMessage(messages) {
    if (!messages)
        return false;
    return messages.some((message) => message.role === 'user' && message.source?.kind === 'user');
}
function denyReason(toolName, marker) {
    return [
        `任务确认：用户还没有确认任务理解，工具「${toolName}」在确认前不可用。`,
        `请先输出一段以「${marker}」开头的消息，简要写明目标、约束、做法、产出；如有必须由用户决定的问题，加一行「需要你定」。`,
        '最后一行写：回复「继续」开始执行；如果有偏差，直接回复修正，修订后我会重新给出任务理解；要取消请回复「取消」。',
        '输出后立即结束本轮，等待用户回复。不要重试该工具。',
    ].join('\n');
}
function sectionText(readOnlyTools, marker) {
    const allowList = readOnlyTools.join('、');
    return [
        '## 任务确认协议（硬性）',
        '',
        '当任务可能需要修改文件、执行命令、调用子代理或改变系统状态时：',
        `1. 确认前只允许只读调研：${allowList}。不要调用其他工具。`,
        `2. 在第一次改动之前，先输出一段以「${marker}」开头的消息，用简短几行写明：目标、约束、做法、产出；如有必须由用户决定的问题，加一行「需要你定」。`,
        '3. 消息最后一行写：回复「继续」开始执行；如果有偏差，直接回复修正，修订后需要重新确认；要取消请回复「取消」。',
        '4. 输出后立即结束本轮，等待用户回复；不要继续调用工具。',
        '5. 用户回复明确的确认词后直接执行，不要重复任务理解；用户给出修正时，先按修正后的理解重新输出任务理解，再等待确认。',
        '6. 纯问答或不需要动手的任务直接回答，不要输出任务理解。',
        `7. 任务理解必须针对当前请求本身；不要把这段协议原文、示例或引用当作任务理解复述。`,
        '',
        '系统的工具门禁会在用户确认前拒绝修改类工具。如果收到该拒绝，按上述格式输出任务理解并结束本轮，不要重试。',
    ].join('\n');
}
function taskConfirmView(state, isEnabled, marker) {
    return {
        get marker() {
            return marker();
        },
        phase: (sessionId) => (isEnabled() ? state.phase(sessionId) : undefined),
        cancel: (sessionId) => (isEnabled() ? state.cancel(sessionId) : false),
    };
}
function shortId(sessionId) {
    const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
    return bare.length > 8 ? bare.slice(0, 8) : bare;
}
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        },
    });
}
export function apply(ctx, config) {
    const log = ctx.logger('task-confirm');
    const enabled = () => live(config.enabled);
    const readOnlyTools = () => live(config.readOnlyTools);
    const cancelWords = () => live(config.cancelWords);
    const confirmWords = () => live(config.confirmWords);
    const pendingTtlMs = () => live(config.pendingTtlMs);
    let warnedEmptyMarker = false;
    const marker = () => {
        const trimmed = live(config.marker).trim();
        if (trimmed)
            return trimmed;
        if (!warnedEmptyMarker) {
            warnedEmptyMarker = true;
            log.warn('marker 配置为空，已回退到默认值');
        }
        return DEFAULT_MARKER;
    };
    const state = new ConfirmState({
        marker: marker(),
        readOnlyTools: readOnlyTools(),
        cancelWords: cancelWords(),
        confirmWords: confirmWords(),
        denyReason: (toolName) => denyReason(toolName, marker()),
        understandingSentReason: UNDERSTANDING_SENT_REASON,
        pendingTtlMs: pendingTtlMs(),
        now: () => Date.now(),
    });
    const bus = ctx;
    // Registered through `ctx.provide` rather than a `Service` subclass so the
    // plugin never loads a second copy of Cordis: linked bundles resolve their
    // own `node_modules`, and a second `Service` base would register under the
    // host's registry with foreign internal symbols.
    try {
        ;
        ctx.provide('taskConfirm', taskConfirmView(state, enabled, marker));
    }
    catch (error) {
        // A duplicate registration means another instance already owns the gate;
        // staying inert is safer than wiring a second one.
        log.error(`taskConfirm 服务注册失败: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    // The web settings page reads live state through the host's authenticated
    // /api channel. `ctx.inject` makes the dependency optional: headless
    // profiles never provide `connection`, so this callback simply never runs.
    const injector = ctx;
    try {
        injector.inject?.(['connection'], (child) => {
            child.effect(() => {
                const disposers = [];
                try {
                    disposers.push(child.connection.fetch.register({
                        path: STATUS_ROUTE,
                        methods: ['GET'],
                        requestBody: 'buffered',
                        fetch: async () => {
                            try {
                                return jsonResponse({
                                    enabled: enabled(),
                                    marker: marker(),
                                    pendingTtlMs: Math.max(0, pendingTtlMs()),
                                    now: Date.now(),
                                    tracked: enabled() ? state.tracked : 0,
                                    sessions: enabled() ? state.snapshot() : [],
                                });
                            }
                            catch (error) {
                                log.error(`读取任务确认状态失败: ${error instanceof Error ? error.message : String(error)}`);
                                return jsonResponse({ error: 'status-failed' }, 500);
                            }
                        },
                    }));
                    disposers.push(child.connection.fetch.register({
                        path: CANCEL_ROUTE,
                        methods: ['POST'],
                        requestBody: 'buffered',
                        fetch: async (request) => {
                            try {
                                let body;
                                try {
                                    body = await request.json();
                                }
                                catch {
                                    return jsonResponse({ error: 'invalid-json' }, 400);
                                }
                                const sessionId = asRecord(body)?.sessionId;
                                if (typeof sessionId !== 'string' || !sessionId) {
                                    return jsonResponse({ error: 'invalid-session' }, 400);
                                }
                                const changed = enabled() ? state.cancel(sessionId) : false;
                                if (changed)
                                    log.info(`会话 ${shortId(sessionId)} 在设置页取消了待确认任务`);
                                return jsonResponse({ ok: true, changed });
                            }
                            catch (error) {
                                log.error(`取消待确认任务失败: ${error instanceof Error ? error.message : String(error)}`);
                                return jsonResponse({ error: 'cancel-failed' }, 500);
                            }
                        },
                    }));
                    log.info(`任务确认状态 API 已注册: ${STATUS_ROUTE}、${CANCEL_ROUTE}`);
                }
                catch (error) {
                    log.error(`任务确认状态 API 注册失败: ${error instanceof Error ? error.message : String(error)}`);
                }
                return async () => {
                    for (const dispose of disposers.reverse()) {
                        try {
                            await dispose();
                        }
                        catch (error) {
                            log.warn(`任务确认状态 API 卸载失败: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                };
            }, 'task-confirm: status api');
        });
    }
    catch (error) {
        log.error(`任务确认状态 API 挂载失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reportedMismatch = new Set();
    const sessionKey = (agent) => {
        const sessionId = agent.session?.id;
        if (sessionId && sessionId !== agent.id && !reportedMismatch.has(agent.id)) {
            reportedMismatch.add(agent.id);
            log.warn(`agent id 与会话 id 不一致，按会话 id 记录状态: ${shortId(agent.id)} != ${shortId(sessionId)}`);
        }
        return sessionId ?? agent.id;
    };
    const prompt = ctx.systemPrompt;
    if (prompt) {
        try {
            prompt.section({
                name: 'task-confirm',
                order: 700,
                interpolate: false,
                text: (assembly) => {
                    try {
                        if (!enabled())
                            return '';
                        const agent = assembly.agent;
                        if (!agent || isSubagentSession(agent.session?.header))
                            return '';
                        if (!state.isHumanTurn(sessionKey(agent)))
                            return '';
                        return sectionText(readOnlyTools(), marker());
                    }
                    catch (error) {
                        log.error(`生成任务确认提示失败: ${error instanceof Error ? error.message : String(error)}`);
                        return '';
                    }
                },
            });
        }
        catch (error) {
            log.error(`任务确认协议注入失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    else {
        log.warn('systemPrompt 服务不可用，任务确认协议未注入');
    }
    bus.on('session/event', (session, event) => {
        try {
            if (!enabled())
                return;
            if (isSubagentSession(session.header))
                return;
            if (event.type === 'session/title') {
                const title = asRecord(event.data)?.title;
                if (typeof title === 'string')
                    state.onTitle(session.id, title);
                return;
            }
            if (event.type === 'turn/start') {
                const phase = state.onTurnStart(session.id);
                log.debug(`会话 ${shortId(session.id)} 进入 ${phase}`);
                return;
            }
            if (event.type === 'user/message') {
                const kind = asRecord(asRecord(event.data)?.source)?.kind;
                if (typeof kind === 'string')
                    state.onTurnMessage(session.id, kind === 'user');
                return;
            }
            if (event.type === 'assistant/message') {
                const text = assistantText(event);
                if (text)
                    state.onAssistantMessage(session.id, text);
                return;
            }
            if (event.type === 'turn/end') {
                state.onTurnEnd(session.id, turnEndKind(event));
                if (state.phase(session.id) === 'pending')
                    log.info(`会话 ${shortId(session.id)} 等待任务确认`);
                return;
            }
        }
        catch (error) {
            log.error(`会话事件处理失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    bus.on('session/disposed', (session) => {
        state.forget(session.id);
    });
    bus.on('loader/volatile-update', (paths) => {
        try {
            state.updateSettings({
                marker: marker(),
                readOnlyTools: readOnlyTools(),
                cancelWords: cancelWords(),
                confirmWords: confirmWords(),
                pendingTtlMs: pendingTtlMs(),
            });
            if (touchesField(paths, 'enabled')) {
                if (enabled()) {
                    log.info('任务确认已启用，配置即时生效');
                }
                else {
                    state.reset();
                    log.info('任务确认已关闭，内存状态已清空');
                }
            }
            else {
                log.info('任务确认配置已即时生效');
            }
        }
        catch (error) {
            log.error(`任务确认配置更新失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    });
    bus.on('agent/pre-step', async (payload, next) => {
        try {
            if (!enabled())
                return next();
            const agent = payload.agent;
            if (agent && !isSubagentSession(agent.session?.header)) {
                const sessionId = sessionKey(agent);
                const messages = payload.messages;
                if (messages && messages.length > 0) {
                    if (hasHumanMessage(messages))
                        state.onHumanMessage(sessionId);
                    else
                        state.onTurnMessage(sessionId, false);
                }
                const texts = userTexts(messages);
                if (texts.length > 0) {
                    const decision = state.onUserMessages(sessionId, texts);
                    if (decision === 'cancel')
                        log.info(`会话 ${shortId(sessionId)} 取消了待确认任务`);
                    if (decision === 'confirm')
                        log.info(`会话 ${shortId(sessionId)} 在本轮内确认执行`);
                }
            }
        }
        catch (error) {
            log.error(`pre-step 处理失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
    });
    bus.on('tools/pre-execute', async (exec, next) => {
        try {
            if (!enabled())
                return next();
            const agent = exec.agent;
            if (!agent)
                return next();
            if (isSubagentSession(agent.session?.header))
                return next();
            const sessionId = sessionKey(agent);
            const decision = state.decide(sessionId, exec.name);
            if (decision.allow)
                return next();
            log.info(`会话 ${shortId(sessionId)} 在确认前拦截工具 ${exec.name}`);
            return { kind: 'deny', reason: decision.reason };
        }
        catch (error) {
            log.error(`工具门禁处理失败: ${error instanceof Error ? error.message : String(error)}`);
            return next();
        }
    });
}
//# sourceMappingURL=index.js.map