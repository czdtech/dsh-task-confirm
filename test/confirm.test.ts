import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import { ConfirmState, isSubagentSession, type ConfirmStateOptions } from '../src/state.ts'

const OPTIONS: ConfirmStateOptions = {
  marker: '【任务理解】',
  readOnlyTools: ['read', 'grep', 'ask_user_question'],
  cancelWords: ['取消', '算了'],
  confirmWords: ['继续', '确认'],
  denyReason: (toolName) => `denied:${toolName}`,
  understandingSentReason: 'understanding-sent',
  pendingTtlMs: 60_000,
  now: () => 0,
}

function newState(): ConfirmState {
  return new ConfirmState(OPTIONS)
}

const humanMessage = (text: string): unknown => ({
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

test('confirm: a denied tool alone never arms a pending confirmation', () => {
  const state = newState()
  state.onTurnStart('s1')
  assert.deepEqual(state.decide('s1', 'write'), { allow: false, reason: 'denied:write' })
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')
  assert.equal(state.phase('s1'), 'gate')
  assert.equal(state.onUserMessages('s1', ['继续']), null)
  assert.equal(state.decide('s1', 'write').allow, false)
})

test('confirm: write is denied until a human reply confirms the understanding', () => {
  const state = newState()
  assert.equal(state.onTurnStart('s1'), 'gate')
  assert.deepEqual(state.decide('s1', 'read'), { allow: true })
  assert.deepEqual(state.decide('s1', 'write'), { allow: false, reason: 'denied:write' })
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')
  assert.equal(state.phase('s1'), 'pending')

  assert.equal(state.onTurnStart('s1'), 'pending')
  assert.deepEqual(state.decide('s1', 'write'), { allow: false, reason: 'denied:write' })
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
  assert.deepEqual(state.decide('s1', 'write'), { allow: true })
  assert.deepEqual(state.decide('s1', 'bash'), { allow: true })
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')

  assert.equal(state.onTurnStart('s1'), 'gate')
  assert.equal(state.decide('s1', 'write').allow, false)
})

test('confirm: understanding blocks every tool until the turn ends', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  assert.deepEqual(state.decide('s1', 'read'), { allow: false, reason: 'understanding-sent' })
  assert.deepEqual(state.decide('s1', 'write'), { allow: false, reason: 'understanding-sent' })
  state.onTurnEnd('s1', 'completed')
  assert.equal(state.phase('s1'), 'pending')
})

test('confirm: marker and tool call in one message still denies the tool', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】目标：整理目录')
  assert.equal(state.decide('s1', 'bash').allow, false)
  state.onTurnEnd('s1', 'completed')
  assert.equal(state.phase('s1'), 'pending')
})

test('confirm: marker with list prefix is recognised', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '- 【任务理解】整理目录')
  assert.deepEqual(state.decide('s1', 'write'), { allow: false, reason: 'understanding-sent' })
})

test('confirm: a marker quoted inside a fenced block does not arm the gate', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '```md\n【任务理解】示例文本\n```')
  assert.deepEqual(state.decide('s1', 'read'), { allow: true })
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')
  assert.equal(state.phase('s1'), 'gate')
})

test('confirm: a marker after a fenced block is still recognised', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '```sh\nls\n```\n【任务理解】整理目录')
  assert.deepEqual(state.decide('s1', 'read'), { allow: false, reason: 'understanding-sent' })
})

test('confirm: aborted turns never leave a pending confirmation', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  assert.equal(state.onTurnEnd('s1', 'error'), 'gate')
  assert.equal(state.onTurnStart('s1'), 'gate')
  assert.equal(state.decide('s1', 'write').allow, false)
})

test('confirm: a turn ending without a reason kind does not arm the gate', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  assert.equal(state.onTurnEnd('s1', 'unknown'), 'gate')
  assert.equal(state.phase('s1'), 'gate')
})

test('confirm: a pending confirmation can be cancelled', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')
  assert.equal(state.phase('s1'), 'pending')
  assert.equal(state.cancel('s1'), true)
  assert.equal(state.phase('s1'), 'gate')
  assert.equal(state.cancel('s1'), false)
  assert.equal(state.onTurnStart('s1'), 'gate')
})

test('confirm: an auto-started turn does not consume the pending confirmation', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.onTurnStart('s1')
  state.onTurnEnd('s1', 'completed')
  assert.equal(state.phase('s1'), 'pending')

  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
  assert.equal(state.decide('s1', 'write').allow, true)
})

test('confirm: cancel words abort a confirmed turn', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.onTurnStart('s1')
  state.onUserMessages('s1', ['继续'])
  assert.equal(state.onUserMessages('s1', ['取消！']), 'cancel')
  assert.equal(state.phase('s1'), 'gate')
  assert.equal(state.decide('s1', 'write').allow, false)
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')
})

test('confirm: cancel reply to a pending confirmation abandons it', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['算了']), 'cancel')
  assert.equal(state.phase('s1'), 'gate')
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')
})

test('confirm: steering confirmation during the understanding turn unlocks tools', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
  assert.deepEqual(state.decide('s1', 'write'), { allow: true })
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')
})

test('confirm: steering cancel during the understanding turn stays gated', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  assert.equal(state.onUserMessages('s1', ['算了']), 'cancel')
  assert.equal(state.decide('s1', 'write').allow, false)
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')
})

test('confirm: a plain message inside a gated turn does not confirm', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  assert.equal(state.onUserMessages('s1', ['补充一下：只整理下载目录']), null)
  assert.equal(state.decide('s1', 'write').allow, false)
})

test('confirm: a sentence containing a cancel word is not a cancel', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  assert.equal(state.onUserMessages('s1', ['先取消测试环境那步吧']), null)
  assert.equal(state.decide('s1', 'write').allow, false)

  state.onTurnEnd('s1', 'completed')
  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
  assert.equal(state.onUserMessages('s1', ['先取消测试环境那步吧']), null)
  assert.equal(state.decide('s1', 'write').allow, true)
})

test('confirm: cancel wins when one batch carries both words', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['继续', '取消']), 'cancel')
  assert.equal(state.phase('s1'), 'gate')
})

test('confirm: an armed confirmation expires after its ttl', () => {
  let clock = 0
  const state = new ConfirmState({ ...OPTIONS, pendingTtlMs: 1_000, now: () => clock })
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  clock = 999
  assert.equal(state.phase('s1'), 'pending')
  clock = 1_001
  assert.equal(state.phase('s1'), 'gate')
  assert.equal(state.decide('s1', 'write').allow, false)
  assert.equal(state.onUserMessages('s1', ['继续']), null)
})

test('confirm: a zero ttl keeps the confirmation until it is consumed', () => {
  let clock = 0
  const state = new ConfirmState({ ...OPTIONS, pendingTtlMs: 0, now: () => clock })
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  clock = 10 * 24 * 60 * 60 * 1000
  assert.equal(state.phase('s1'), 'pending')
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
})

test('confirm: an unattended turn is not gated and never arms a pending', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onTurnMessage('s1', false)
  assert.deepEqual(state.decide('s1', 'write'), { allow: true })
  state.onAssistantMessage('s1', '【任务理解】巡检')
  assert.equal(state.onTurnEnd('s1', 'completed'), 'gate')
  assert.equal(state.phase('s1'), 'gate')
})

test('confirm: a human message upgrades an unattended turn', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onTurnMessage('s1', false)
  assert.equal(state.decide('s1', 'write').allow, true)
  state.onHumanMessage('s1')
  assert.equal(state.decide('s1', 'write').allow, false)
})

test('confirm: an attachment-only human message still classifies the turn', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onHumanMessage('s1')
  assert.equal(state.decide('s1', 'write').allow, false)
})

test('confirm: an unrelated human reply does not approve a pending task', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['今天天气怎么样']), null)
  assert.equal(state.phase('s1'), 'pending')
  assert.equal(state.decide('s1', 'write').allow, false)
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
})

test('confirm: a negated confirm word does not approve', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['不要继续']), null)
  assert.equal(state.phase('s1'), 'pending')
})

test('confirm: a correction keeps the pending until an explicit confirmation', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['只整理 Downloads']), null)
  assert.equal(state.phase('s1'), 'pending')
  state.onAssistantMessage('s1', '【任务理解】只整理 Downloads')
  state.onTurnEnd('s1', 'completed')
  assert.equal(state.phase('s1'), 'pending')

  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
})

test('confirm: snapshot lists pending rows with their title and expires them', () => {
  let clock = 1_000
  const state = new ConfirmState({ ...OPTIONS, pendingTtlMs: 60_000, now: () => clock })
  state.onTurnStart('s1')
  state.onTitle('s1', '整理下载目录')
  state.onAssistantMessage('s1', '【任务理解】整理下载目录')
  state.onTurnEnd('s1', 'completed')
  state.onTurnStart('s2')
  assert.equal(state.tracked, 2)

  assert.deepEqual(state.snapshot(), [
    {
      id: 's1',
      title: '整理下载目录',
      phase: 'pending',
      awaitingSince: 1_000,
      humanTurn: true,
    },
  ])

  clock = 61_001
  assert.deepEqual(state.snapshot(), [])
})

test('confirm: snapshot exposes a confirmed turn until it ends', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')
  state.onTurnStart('s1')
  assert.equal(state.onUserMessages('s1', ['继续']), 'confirm')
  assert.equal(state.snapshot()[0]?.phase, 'confirmed')
  state.onTurnEnd('s1', 'completed')
  assert.deepEqual(state.snapshot(), [])
})

test('confirm: updateSettings rebuilds the marker, word sets and ttl', () => {
  let clock = 0
  const state = new ConfirmState({ ...OPTIONS, pendingTtlMs: 60_000, now: () => clock })
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')

  state.updateSettings({
    marker: '【新】',
    readOnlyTools: ['grep'],
    cancelWords: ['停止'],
    confirmWords: ['好的'],
    pendingTtlMs: 1_000,
  })
  assert.equal(state.marker, '【新】')
  clock = 1_001
  assert.equal(state.phase('s1'), 'gate')

  state.onTurnStart('s2')
  assert.deepEqual(state.decide('s2', 'grep'), { allow: true })
  assert.equal(state.decide('s2', 'read').allow, false)
  state.onAssistantMessage('s2', '【新】整理目录')
  assert.equal(state.decide('s2', 'grep').allow, false)
  state.onTurnEnd('s2', 'completed')

  state.onTurnStart('s2')
  assert.equal(state.onUserMessages('s2', ['继续']), null)
  assert.equal(state.onUserMessages('s2', ['好的']), 'confirm')

  state.onTurnStart('s3')
  state.onAssistantMessage('s3', '【新】整理目录')
  state.onTurnEnd('s3', 'completed')
  state.onTurnStart('s3')
  assert.equal(state.onUserMessages('s3', ['停止']), 'cancel')
})

test('confirm: reset clears every session record', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')
  state.onTurnStart('s2')
  assert.equal(state.tracked, 2)
  state.reset()
  assert.equal(state.tracked, 0)
  assert.equal(state.phase('s1'), undefined)
  assert.equal(state.phase('s2'), undefined)
})

test('confirm: forgetting a session removes its snapshot row', () => {
  const state = newState()
  state.onTurnStart('s1')
  state.onAssistantMessage('s1', '【任务理解】整理目录')
  state.onTurnEnd('s1', 'completed')
  assert.equal(state.snapshot().length, 1)
  state.forget('s1')
  assert.deepEqual(state.snapshot(), [])
  assert.equal(state.tracked, 0)
})

test('confirm: subagent sessions are detected from the header', () => {
  assert.equal(isSubagentSession(undefined), false)
  assert.equal(isSubagentSession({}), false)
  assert.equal(isSubagentSession({ origin: 'subagent' }), true)
  assert.equal(isSubagentSession({ delegationDepth: 2 }), true)
  assert.equal(isSubagentSession({ delegationDepth: 0, origin: 'subagent' }), true)
})

interface RouteView {
  path: string
  methods: readonly string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

interface Harness {
  listeners: Map<string, (...args: any[]) => unknown>
  sections: Array<{ name: string; order: number; text: (context: unknown) => string }>
  services: Map<string, unknown>
  routes: RouteView[]
  effects: unknown[]
  logs: string[]
}

function harness(options: { connection?: boolean } = {}): { ctx: Context; h: Harness } {
  const h: Harness = {
    listeners: new Map(),
    sections: [],
    services: new Map(),
    routes: [],
    effects: [],
    logs: [],
  }
  const logger = {
    info: (message: string) => h.logs.push(message),
    warn: (message: string) => h.logs.push(message),
    error: (message: string) => h.logs.push(message),
    debug: (message: string) => h.logs.push(message),
    success: (message: string) => h.logs.push(message),
  }
  const ctx = {
    logger: () => logger,
    on: (event: string, listener: (...args: any[]) => unknown) => {
      h.listeners.set(event, listener)
      return () => undefined
    },
    provide: (name: string, value: unknown) => {
      h.services.set(name, value)
      return () => undefined
    },
    effect: (execute: () => unknown) => {
      h.effects.push(execute())
      return async () => undefined
    },
    inject: (deps: string[], callback: (child: unknown) => void) => {
      if (!options.connection || !deps.includes('connection')) return undefined
      const connection = {
        fetch: {
          register: (route: RouteView) => {
            h.routes.push(route)
            return async () => {
              const index = h.routes.indexOf(route)
              if (index >= 0) h.routes.splice(index, 1)
            }
          },
        },
      }
      ;(ctx as unknown as { connection: unknown }).connection = connection
      callback(ctx)
      return undefined
    },
    systemPrompt: {
      section: (section: { name: string; order: number; text: (context: unknown) => string }) => {
        h.sections.push(section)
        return () => undefined
      },
    },
  } as unknown as Context
  return { ctx, h }
}

const config = (): ReturnType<typeof Config> => Config({})

const agent = (id: string, header: Record<string, unknown> = {}, sessionId = id): unknown => ({
  id,
  session: { id: sessionId, header },
})

const allow = async (): Promise<{ kind: 'allow' }> => ({ kind: 'allow' })
const enter = async (): Promise<{ kind: 'enter'; messages: unknown[] }> => ({ kind: 'enter', messages: [] })

function understandingEvent(): { type: string; data: unknown } {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '【任务理解】整理目录' }] } },
  }
}

test('confirm plugin: never loads another runtime copy of the host toolchain', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const runtime = [...source.matchAll(/^import(?!\s*type)[^;\n]*from '([^']+)'$/gm)]
    .map((match) => match[1]!)
  const hostRuntime = runtime.filter(
    (spec) => spec.startsWith('@deepseek-ai/') && spec !== '@deepseek-ai/schemastery',
  )
  assert.deepEqual(hostRuntime, [], 'linked bundles resolve their own node_modules; only the config schema package may load at runtime')
})

test('confirm plugin: registers the protocol section for top-level agents only', () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  assert.equal(h.sections.length, 1)
  const section = h.sections[0]!
  assert.equal(section.name, 'task-confirm')
  assert.equal(section.order, 700)
  assert.match(section.text({ agent: agent('s1') }), /任务确认协议/)
  assert.equal(section.text({ agent: agent('s2', { origin: 'subagent' }) }), '')
  assert.equal(section.text({}), '')
})

test('confirm plugin: disabled config contributes no protocol text and no gate', async () => {
  const { ctx, h } = harness()
  apply(ctx, Config({ enabled: false }))
  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0]!.text({ agent: agent('s1') }), '')
  const service = h.services.get('taskConfirm') as {
    marker: string
    phase(id: string): string | undefined
    cancel(id: string): boolean
  }
  assert.equal(service.marker, '【任务理解】')
  assert.equal(service.phase('s1'), undefined)
  assert.equal(service.cancel('s1'), false)
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'allow')
})

test('confirm plugin: an empty marker falls back to the default', () => {
  const { ctx, h } = harness()
  apply(ctx, Config({ marker: '' }))
  const section = h.sections[0]!
  assert.match(section.text({ agent: agent('s1') }), /【任务理解】/)
})

test('confirm plugin: volatile config updates apply without a remount', async () => {
  let marker = '【任务理解】'
  let readOnlyTools = ['read']
  let cancelWords = ['取消']
  let confirmWords = ['继续']
  const pendingTtlMs = 60_000
  const config: Config = {
    enabled: { get: () => true },
    marker: { get: () => marker },
    readOnlyTools: { get: () => readOnlyTools },
    cancelWords: { get: () => cancelWords },
    confirmWords: { get: () => confirmWords },
    pendingTtlMs: { get: () => pendingTtlMs },
  }
  const { ctx, h } = harness()
  apply(ctx, config)
  const update = h.listeners.get('loader/volatile-update')!
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string; reason?: string }>

  marker = '【新理解】'
  readOnlyTools = ['read', 'grep']
  cancelWords = ['停止']
  confirmWords = ['好的']
  update([['marker'], ['readOnlyTools'], ['cancelWords'], ['confirmWords']])

  assert.match(h.sections[0]!.text({ agent: agent('s1') }), /【新理解】/)
  assert.match(h.sections[0]!.text({ agent: agent('s1') }), /read、grep/)
  assert.equal((await preExecute({ name: 'grep', agent: agent('s1') }, allow)).kind, 'allow')
  const denied = await preExecute({ name: 'write', agent: agent('s1') }, allow)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason ?? '', /【新理解】/)

  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const session = { id: 's1', header: {} }
  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '【新理解】整理目录' }] } },
  })
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  event(session, { type: 'turn/start', data: { turn: 2 } })
  await preStep({ agent: agent('s1'), messages: [humanMessage('继续')] }, enter)
  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }
  assert.equal(service.phase('s1'), 'pending')
  await preStep({ agent: agent('s1'), messages: [humanMessage('好的')] }, enter)
  assert.equal(service.phase('s1'), 'confirmed')

  await preStep({ agent: agent('s1'), messages: [humanMessage('停止')] }, enter)
  assert.equal(service.phase('s1'), 'gate')
})

test('confirm plugin: disabling clears state and re-enabling restores the gate live', async () => {
  let enabled = true
  const config: Config = {
    enabled: { get: () => enabled },
    marker: { get: () => '【任务理解】' },
    readOnlyTools: { get: () => ['read'] },
    cancelWords: { get: () => ['取消'] },
    confirmWords: { get: () => ['继续'] },
    pendingTtlMs: { get: () => 60_000 },
  }
  const { ctx, h } = harness()
  apply(ctx, config)
  const event = h.listeners.get('session/event')!
  const update = h.listeners.get('loader/volatile-update')!
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const service = h.services.get('taskConfirm') as {
    phase(id: string): string | undefined
    cancel(id: string): boolean
  }
  const session = { id: 's1', header: {} }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, understandingEvent())
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(service.phase('s1'), 'pending')

  enabled = false
  update([['enabled']])
  assert.equal(service.phase('s1'), undefined)
  assert.equal(service.cancel('s1'), false)
  assert.equal(h.sections[0]!.text({ agent: agent('s1') }), '')
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'allow')

  enabled = true
  update([['enabled']])
  assert.equal(service.phase('s1'), undefined)
  assert.match(h.sections[0]!.text({ agent: agent('s1') }), /任务确认协议/)
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'deny')
})

test('confirm plugin: session events gate a top-level tool call until confirmation', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (
    payload: unknown,
    next: () => Promise<{ kind: 'enter'; messages: unknown[] }>,
  ) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const session = { id: 's1', header: {} }
  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal((await preExecute({ name: 'read', agent: agent('s1') }, allow)).kind, 'allow')
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'deny')
  assert.equal(service.phase('s1'), 'gate')

  event(session, understandingEvent())
  assert.equal((await preExecute({ name: 'bash', agent: agent('s1') }, allow)).kind, 'deny')
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(service.phase('s1'), 'pending')

  event(session, { type: 'turn/start', data: { turn: 2 } })
  await preStep({ agent: agent('s1'), messages: [humanMessage('继续')] }, enter)
  assert.equal((await preExecute({ name: 'bash', agent: agent('s1') }, allow)).kind, 'allow')
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(service.phase('s1'), 'gate')
})

test('confirm plugin: a turn without a reason kind never arms the gate', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const session = { id: 's1', header: {} }
  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, understandingEvent())
  event(session, { type: 'turn/end', data: { turn: 1 } })
  assert.equal(service.phase('s1'), 'gate')

  event(session, { type: 'turn/start', data: { turn: 2 } })
  await preStep({ agent: agent('s1'), messages: [humanMessage('继续')] }, enter)
  assert.equal(service.phase('s1'), 'gate')
})

test('confirm plugin: gates by session id even when the agent id differs', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const session = { id: 's1', header: {} }
  const worker = agent('agent-x', {}, 's1')

  event(session, { type: 'turn/start', data: { turn: 1 } })
  assert.equal((await preExecute({ name: 'write', agent: worker }, allow)).kind, 'deny')
  event(session, understandingEvent())
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  event(session, { type: 'turn/start', data: { turn: 2 } })
  await preStep({ agent: worker, messages: [humanMessage('继续')] }, enter)
  assert.equal((await preExecute({ name: 'write', agent: worker }, allow)).kind, 'allow')
})

test('confirm plugin: sessions keep independent gates', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const s1 = { id: 's1', header: {} }
  const s2 = { id: 's2', header: {} }

  event(s1, { type: 'turn/start', data: { turn: 1 } })
  event(s1, understandingEvent())
  event(s1, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  event(s2, { type: 'turn/start', data: { turn: 1 } })
  await preStep({ agent: agent('s2'), messages: [humanMessage('继续')] }, enter)
  assert.equal((await preExecute({ name: 'write', agent: agent('s2') }, allow)).kind, 'deny')

  event(s2, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  event(s1, { type: 'turn/start', data: { turn: 2 } })
  await preStep({ agent: agent('s1'), messages: [humanMessage('继续')] }, enter)
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'allow')
})

test('confirm plugin: subagents and agent-less calls bypass the gate', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  assert.equal((await preExecute({ name: 'write' }, allow)).kind, 'allow')
  assert.equal(
    (await preExecute({ name: 'write', agent: agent('sub', { origin: 'subagent' }) }, allow)).kind,
    'allow',
  )
})

test('confirm plugin: a cancel reply resets a confirmed turn', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (
    payload: unknown,
    next: () => Promise<{ kind: 'enter'; messages: unknown[] }>,
  ) => Promise<unknown>
  const session = { id: 's1', header: {} }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, understandingEvent())
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  event(session, { type: 'turn/start', data: { turn: 2 } })
  await preStep({ agent: agent('s1'), messages: [humanMessage('继续')] }, enter)

  let nextCalls = 0
  await preStep(
    { agent: agent('s1'), messages: [humanMessage('取消')] },
    async () => {
      nextCalls += 1
      return { kind: 'enter', messages: [] }
    },
  )

  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }
  assert.equal(service.phase('s1'), 'gate')
  assert.equal(nextCalls, 1)
})

test('confirm plugin: synthetic messages do not consume a pending confirmation', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (
    payload: unknown,
    next: () => Promise<{ kind: 'enter'; messages: unknown[] }>,
  ) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const session = { id: 's1', header: {} }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, understandingEvent())
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  event(session, { type: 'turn/start', data: { turn: 2 } })
  await preStep(
    {
      agent: agent('s1'),
      messages: [{ role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: '继续' }] }],
    },
    enter,
  )

  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }
  assert.equal(service.phase('s1'), 'pending')
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'allow')
})

test('confirm plugin: an unattended turn runs ungated and without the protocol', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const session = { id: 's1', header: {} }
  const goalMessage = { role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: 'goal round' }] }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, { type: 'user/message', data: goalMessage })
  await preStep({ agent: agent('s1'), messages: [goalMessage] }, enter)

  assert.equal(h.sections[0]!.text({ agent: agent('s1') }), '')
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'allow')
})

test('confirm plugin: a human turn keeps the protocol and the gate', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const session = { id: 's1', header: {} }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '整理 Downloads' }] },
  })
  await preStep({ agent: agent('s1'), messages: [humanMessage('整理 Downloads')] }, enter)

  assert.match(h.sections[0]!.text({ agent: agent('s1') }), /任务确认协议/)
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'deny')
})

test('confirm plugin: an unrelated human reply leaves the pending armed', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const session = { id: 's1', header: {} }
  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '整理 Downloads' }] } })
  event(session, understandingEvent())
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  event(session, { type: 'turn/start', data: { turn: 2 } })
  await preStep({ agent: agent('s1'), messages: [humanMessage('今天天气怎么样')] }, enter)
  assert.equal(service.phase('s1'), 'pending')
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'deny')

  await preStep({ agent: agent('s1'), messages: [humanMessage('继续')] }, enter)
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'allow')
})

test('confirm plugin: an attachment-only human message is still gated', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preStep = h.listeners.get('agent/pre-step')! as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const session = { id: 's1', header: {} }

  event(session, { type: 'turn/start', data: { turn: 1 } })
  await preStep(
    {
      agent: agent('s1'),
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'x' }] }],
    },
    enter,
  )
  assert.equal((await preExecute({ name: 'write', agent: agent('s1') }, allow)).kind, 'deny')
})

test('confirm plugin: deny logs identify the session', async () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const preExecute = h.listeners.get('tools/pre-execute')! as (
    exec: unknown,
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const sessionId = 'session-cc18e148-5cbb-40d5-8e3e-75230092c617'

  event({ id: sessionId, header: {} }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal((await preExecute({ name: 'write', agent: agent(sessionId) }, allow)).kind, 'deny')
  assert.ok(h.logs.some((line) => line.includes('cc18e148')), 'log should carry the session suffix')
})

test('confirm plugin: disposed sessions forget their state', () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const disposed = h.listeners.get('session/disposed')!
  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }
  event({ id: 's1', header: {} }, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(service.phase('s1'), 'gate')
  disposed({ id: 's1', header: {} })
  assert.equal(service.phase('s1'), undefined)
})

test('confirm plugin: status and cancel routes expose live state', async () => {
  const { ctx, h } = harness({ connection: true })
  apply(ctx, config())
  const event = h.listeners.get('session/event')!
  const session = { id: 'session-cc18e148-5cbb-40d5-8e3e-75230092c617', header: {} }

  event(session, { type: 'session/title', data: { title: '整理下载目录' } })
  event(session, { type: 'turn/start', data: { turn: 1 } })
  event(session, understandingEvent())
  event(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  assert.equal(h.routes.length, 2)
  const status = h.routes.find((route) => route.path === '/api/task-confirm/status')!
  assert.deepEqual(status.methods, ['GET'])
  assert.equal(status.requestBody, 'buffered')
  const response = await status.fetch(new Request('http://localhost/api/task-confirm/status'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const payload = (await response.json()) as {
    enabled: boolean
    marker: string
    pendingTtlMs: number
    tracked: number
    sessions: Array<{ id: string; title: string; phase: string; awaitingSince: number }>
  }
  assert.equal(payload.enabled, true)
  assert.equal(payload.marker, '【任务理解】')
  assert.equal(payload.pendingTtlMs, 2 * 60 * 60 * 1000)
  assert.equal(payload.tracked, 1)
  assert.equal(payload.sessions.length, 1)
  assert.equal(payload.sessions[0]!.id, session.id)
  assert.equal(payload.sessions[0]!.title, '整理下载目录')
  assert.equal(payload.sessions[0]!.phase, 'pending')

  const cancel = h.routes.find((route) => route.path === '/api/task-confirm/cancel')!
  assert.deepEqual(cancel.methods, ['POST'])
  const cancelled = await cancel.fetch(
    new Request('http://localhost/api/task-confirm/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id }),
    }),
  )
  assert.equal(cancelled.status, 200)
  assert.deepEqual(await cancelled.json(), { ok: true, changed: true })
  const service = h.services.get('taskConfirm') as { phase(id: string): string | undefined }
  assert.equal(service.phase(session.id), 'gate')
})

test('confirm plugin: cancel route rejects malformed or unknown sessions', async () => {
  const { ctx, h } = harness({ connection: true })
  apply(ctx, config())
  const cancel = h.routes.find((route) => route.path === '/api/task-confirm/cancel')!
  const url = 'http://localhost/api/task-confirm/cancel'

  const malformed = await cancel.fetch(
    new Request(url, { method: 'POST', body: '{' }),
  )
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'invalid-json' })

  const invalid = await cancel.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 42 }),
    }),
  )
  assert.equal(invalid.status, 400)
  assert.deepEqual(await invalid.json(), { error: 'invalid-session' })

  const unknown = await cancel.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'missing' }),
    }),
  )
  assert.equal(unknown.status, 200)
  assert.deepEqual(await unknown.json(), { ok: true, changed: false })
})

test('confirm plugin: a disabled instance still answers status for the settings page', async () => {
  const { ctx, h } = harness({ connection: true })
  apply(ctx, Config({ enabled: false }))
  assert.ok(h.listeners.has('loader/volatile-update'))
  const status = h.routes.find((route) => route.path === '/api/task-confirm/status')!
  const payload = (await (await status.fetch(new Request('http://localhost/api/task-confirm/status'))).json()) as {
    enabled: boolean
    sessions: unknown[]
  }
  assert.equal(payload.enabled, false)
  assert.deepEqual(payload.sessions, [])
})

test('confirm plugin: no connection service leaves the gate working without an API', () => {
  const { ctx, h } = harness()
  apply(ctx, config())
  assert.equal(h.routes.length, 0)
  assert.equal(h.effects.length, 0)
  assert.equal(h.sections.length, 1)
})
