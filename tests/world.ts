import { mock } from 'claude-code/testing'

// The test's `on`, as the harness types it (the type itself is not exported).
export type On = Parameters<typeof mock.clock>[0]

export const PANE = {
  plugin: 'attention-panel',
  component: 'Pane',
  requestId: 'attention',
  props: {
    title: 'Needs your attention',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  surface: 'terminal',
} as const

export const ATTENTION = {
  command: 'attention',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 160 },
} as const

export const ADD = 'mcp__attention-panel__attention_add'
export const RESOLVE = 'mcp__attention-panel__attention_resolve'
export const FILE = '/proj/.claude/action-items.json'
export const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const

export type Entry = Record<string, unknown>
export type Tooling = { call: (input: Record<string, unknown>) => Promise<{ result?: unknown; isError?: boolean }> }

// A session in memory: one list file (undefined while it does not exist), and
// a record of what the mod showed the person and sent to Claude.
// `now` sets the clock the mod reads, for what depends on the date.
export function session(on: On, initial?: string, now?: number) {
  const world = {
    text: initial,
    writes: [] as string[],
    prompts: [] as string[],
    toasts: [] as string[],
    statuses: [] as Array<string | undefined>,
    // How often git was run, and switches that make the file fail.
    runs: 0,
    isUnreadable: false,
    isUnwritable: false,
    // A read waits for this: a test holds it open to stand for a slow disk.
    gate: Promise.resolve() as Promise<void>,
    clock: now === undefined ? mock.clock(on) : mock.clock(on, { now }),
  }
  on('command.register', () => ({ value: { command: 'attention' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__attention-panel__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/proj' }))
  on('process.run', () => {
    world.runs += 1

    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', async (_, e) => {
    await world.gate
    if (world.isUnreadable || world.text === undefined || e.path !== FILE) throw new Error('ENOENT')

    return { value: world.text }
  })
  on('fs.write', (_, e) => {
    if (world.isUnwritable) throw new Error('EACCES')
    world.text = e.text
    world.writes.push(e.path)

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    world.prompts.push(e.text)

    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  return world
}

export const saved = (world: { text?: string }): Entry[] => JSON.parse(world.text ?? '[]') as Entry[]
export const list = (...items: Entry[]): string => JSON.stringify(items)
