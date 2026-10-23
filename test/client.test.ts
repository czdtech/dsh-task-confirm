import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

interface RegisteredCard {
  meta: {
    name: string
    id: string
    order: number
    label: () => string
    inject: () => Record<string, any>
  }
  component: unknown
}

interface SchedulerOptions {
  refresh: () => Promise<unknown>
  isActive: () => boolean
  isVisible: () => boolean
  schedule: (fn: () => void, ms: number) => number
  cancel: (id: number) => void
}

interface Scheduler {
  start(): void
  stop(): void
  wake(): void
}

function loadClient(): {
  id: string
  module: {
    inject: string[]
    apply: (ctx: unknown) => void
    StatusRefreshScheduler: new (options: SchedulerOptions) => Scheduler
  }
  registered: RegisteredCard[]
} {
  const registered: RegisteredCard[] = []

  function createSnapshotStore(initial: unknown) {
    let current = initial
    return {
      getSnapshot: () => current,
      subscribe: () => () => undefined,
      set: (next: unknown) => {
        current = next
      },
    }
  }

  class SettingsFormModel {
    constructor(_form: unknown, _specs: unknown) {}
    bind(_select: () => unknown) {
      return { subscribe: () => () => undefined }
    }
    shell() {
      return {
        available: true,
        writable: true,
        dirty: false,
        invalid: false,
        saving: false,
        failed: false,
      }
    }
    field() {
      return { text: '', overridden: false, invalid: false }
    }
    actions() {
      return { edit: () => undefined, resetField: () => undefined, discard: () => undefined }
    }
    save() {
      return Promise.resolve(true)
    }
    dispose() {}
  }

  const primitives = {
    SettingsFormModel,
    settingsTextField: (field: string) => ({
      field,
      format: (value: unknown) => (typeof value === 'string' ? value : ''),
      parse: (text: string) => ({ kind: 'set', value: text }),
    }),
    SettingsValueField: () => null,
    SettingsForm: () => null,
    Switch: () => null,
  }

  const requireFn = (name: string): any => {
    if (name === 'react/jsx-runtime') {
      return {
        jsx: (type: unknown, props: unknown) => ({ type, props }),
        jsxs: (type: unknown, props: unknown) => ({ type, props }),
      }
    }
    if (name === 'react') return { useEffect: () => undefined }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore }
    throw new Error(`unexpected client import: ${name}`)
  }

  let entry:
    | {
        id: string
        module: {
          inject: string[]
          apply: (ctx: unknown) => void
          StatusRefreshScheduler: new (options: SchedulerOptions) => Scheduler
        }
      }
    | undefined
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (definition: {
          id: string
          factory: (require: (name: string) => any) => {
            inject: string[]
            apply: (ctx: unknown) => void
            StatusRefreshScheduler: new (options: SchedulerOptions) => Scheduler
          }
        }) => {
          entry = { id: definition.id, module: definition.factory(requireFn) }
        },
      },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setInterval,
    clearInterval,
    console,
  }
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)

  assert.ok(entry, 'client bundle must register itself with the module loader')
  const loaded = entry!
  const ctx = {
    configForms: {
      get: () => ({
        getSnapshot: () => ({
          status: 'ready',
          writable: true,
          value: {},
          base: {},
          user: {},
          revision: 1,
        }),
        subscribe: () => () => undefined,
      }),
      whileServed: (_namespaces: string[], register: (served: Set<string>) => () => void) => {
        register(new Set(['dsh-task-confirm']))
        return () => undefined
      },
    },
    slots: {
      inject: (_name: string, setup: () => () => void) => {
        setup()
        return () => undefined
      },
      register: (meta: RegisteredCard['meta'], component: unknown) => {
        registered.push({ meta, component })
        return () => undefined
      },
    },
    effect: (execute: () => unknown) => {
      execute()
      return async () => undefined
    },
  }
  loaded.module.apply(ctx)
  return { id: loaded.id, module: loaded.module, registered }
}

test('client bundle: registers the task-confirm settings card', () => {
  const client = loadClient()
  assert.equal(client.id, 'dsh-task-confirm')
  assert.deepEqual([...client.module.inject], ['slots', 'configForms'])
  assert.equal(client.registered.length, 1)

  const card = client.registered[0]!
  assert.equal(card.meta.name, 'plugins.item')
  assert.equal(card.meta.id, 'dsh-task-confirm')
  assert.equal(card.meta.order, 31)
  assert.equal(card.meta.label(), '任务确认')
  assert.equal(typeof card.component, 'function')

  const face = card.meta.inject()
  assert.ok(face.hooks.taskConfirm, 'the card must receive a snapshot store')
  assert.equal(typeof face.edit, 'function')
  assert.equal(typeof face.save, 'function')
  assert.equal(typeof face.refreshStatus, 'function')
  assert.equal(typeof face.cancelSession, 'function')
  assert.equal(typeof face.setEnabled, 'function')
})

test('client bundle: reads the same authenticated API paths as the host', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\/api\/task-confirm\/status/)
  assert.match(source, /\/api\/task-confirm\/cancel/)
})

function createClock() {
  let nextId = 1
  const timers = new Map<number, { fn: () => void; ms: number }>()
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    cancel: (id: number) => {
      timers.delete(id)
    },
    delays: () => Array.from(timers.values()).map((timer) => timer.ms),
    async fire() {
      const due = Array.from(timers.values())
      timers.clear()
      for (const timer of due) timer.fn()
      await flush()
    },
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function createScheduler(overrides: Partial<SchedulerOptions> = {}) {
  const client = loadClient()
  const clock = createClock()
  let refreshes = 0
  const options: SchedulerOptions = {
    refresh: async () => {
      refreshes += 1
    },
    isActive: () => false,
    isVisible: () => true,
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...overrides,
  }
  const scheduler = new client.module.StatusRefreshScheduler(options)
  return { scheduler, clock, refreshCount: () => refreshes }
}

test('client bundle: an idle page keeps a slow floor instead of polling fast', async () => {
  const { scheduler, clock, refreshCount } = createScheduler()
  scheduler.start()
  await flush()
  assert.equal(refreshCount(), 1)
  assert.deepEqual(clock.delays(), [60000])

  await clock.fire()
  assert.equal(refreshCount(), 2)
  assert.deepEqual(clock.delays(), [60000])
})

test('client bundle: a running session switches the page to fast polling', async () => {
  const { scheduler, clock, refreshCount } = createScheduler({ isActive: () => true })
  scheduler.start()
  await flush()
  assert.equal(refreshCount(), 1)
  assert.deepEqual(clock.delays(), [4000])
})

test('client bundle: a hidden page reads once and then stops asking', async () => {
  let visible = false
  const { scheduler, clock, refreshCount } = createScheduler({ isVisible: () => visible })
  scheduler.start()
  await flush()
  assert.equal(refreshCount(), 1)
  assert.deepEqual(clock.delays(), [])

  visible = true
  scheduler.wake()
  await flush()
  assert.equal(refreshCount(), 2)
  assert.deepEqual(clock.delays(), [60000])
})

test('client bundle: an event wakes the page before the next tick', async () => {
  const { scheduler, clock, refreshCount } = createScheduler()
  scheduler.start()
  await flush()
  assert.equal(refreshCount(), 1)

  scheduler.wake()
  await flush()
  assert.equal(refreshCount(), 2)
  assert.deepEqual(clock.delays(), [60000])
})

test('client bundle: leaving the page cancels the pending read', async () => {
  const { scheduler, clock, refreshCount } = createScheduler()
  scheduler.start()
  await flush()
  assert.deepEqual(clock.delays(), [60000])

  scheduler.stop()
  assert.deepEqual(clock.delays(), [])
  await clock.fire()
  assert.equal(refreshCount(), 1)
})
