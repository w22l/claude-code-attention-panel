import { expect, mock, test } from 'claude-code/testing'

// The test's `on`, as the harness types it (the type itself is not exported).
type On = Parameters<typeof mock.clock>[0]

const PANE = {
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

const ATTENTION = {
  command: 'attention',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 160 },
} as const

const ADD = 'mcp__attention-panel__attention_add'
const RESOLVE = 'mcp__attention-panel__attention_resolve'
const FILE = '/proj/.claude/action-items.json'

type Entry = Record<string, unknown>
type Tooling = { call: (input: Record<string, unknown>) => Promise<{ result?: unknown; isError?: boolean }> }

// A session in memory: one list file (undefined while it does not exist), and
// a record of what the mod showed the person and sent to Claude.
function session(on: On, initial?: string) {
  const world = {
    text: initial,
    writes: [] as string[],
    prompts: [] as string[],
    toasts: [] as string[],
    statuses: [] as Array<string | undefined>,
    tools: [] as Array<{ name: string; isDeferred?: unknown }>,
    clock: mock.clock(on),
  }
  on('command.register', () => ({ value: { command: 'attention' } }))
  on('tool.register', (_, e) => {
    world.tools.push({ name: e.name, isDeferred: e.isDeferred })

    return { value: { tool: `mcp__attention-panel__${e.name}` } }
  })
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
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_, e) => {
    if (world.text === undefined || e.path !== FILE) throw new Error('ENOENT')

    return { value: world.text }
  })
  on('fs.write', (_, e) => {
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

const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const
const saved = (world: { text?: string }): Entry[] => JSON.parse(world.text ?? '[]') as Entry[]

async function turn($: any, answer: string, during?: () => void | Promise<void>, text = 'do the work') {
  await $.turn.start({ text, turnId: 't1' })
  await during?.()
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('Claude is told about the list in the system prompt and gets two tools that are not deferred', async ($, on) => {
  const world = session(on)
  await $.session.start(START)

  const { sections } = await $.prompt.compose({
    model: 'claude-test',
    promptModel: 'claude-test',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(sections.map(s => s.id)).toEqual(['intro', 'attention-panel:keep-current'])
  const added = sections[1] ?? { scope: '', text: '' }
  expect(added.scope).toBe('session')
  expect(added.text).toContain('.claude/action-items.json')
  expect(added.text).toContain('in the same turn in which you ask')
  expect(added.text).toContain('attention_add')

  expect(world.tools).toEqual([
    { name: 'attention_add', isDeferred: false },
    { name: 'attention_resolve', isDeferred: false },
  ])
})

test('attention_add creates the list, then updates an item in place instead of duplicating it', async ($, on) => {
  const world = session(on)
  await $.session.start(START)
  const tool = $.tool as unknown as Tooling

  const first = await tool.call({ tool: ADD, id: 'region', kind: 'decision', title: 'Choose the hosting region', path: '/proj/deploy.md' })
  expect(first.isError).toBeUndefined()
  expect(String(first.result)).toContain('Added "region"')
  expect(world.writes).toEqual([FILE])
  expect(saved(world)).toEqual([
    {
      id: 'region',
      kind: 'decision',
      title: 'Choose the hosting region',
      path: '/proj/deploy.md',
      since: new Date().toISOString().slice(0, 10),
      done: false,
    },
  ])

  await tool.call({ tool: ADD, id: 'notes', kind: 'sign-off', title: 'Approve the release notes' })
  const again = await tool.call({ tool: ADD, id: 'region', kind: 'blocked', title: 'Choose the hosting region today' })
  expect(String(again.result)).toContain('Updated "region"')
  expect(String(again.result)).toContain('2 items are open')
  expect(saved(world).map(one => [one.id, one.kind, one.title])).toEqual([
    ['region', 'blocked', 'Choose the hosting region today'],
    ['notes', 'sign-off', 'Approve the release notes'],
  ])
  // What the update did not name is kept.
  expect(saved(world)[0]?.path).toBe('/proj/deploy.md')

  // The pane shows it without waiting for the five-second poll.
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /hosting region today/ }))?.text).toBe('Choose the hosting region today')
  await ui.unmount()
})

test('attention_add refuses a bad kind or a missing title, and never rewrites a file it cannot parse', async ($, on) => {
  const world = session(on, '[{"id": "a", "kind": "review", "title": "A"},')
  await $.session.start(START)
  const tool = $.tool as unknown as Tooling

  const badKind = await tool.call({ tool: ADD, id: 'x', kind: 'urgent', title: 'X' })
  expect(badKind.isError).toBe(true)
  expect(String(badKind.result)).toContain('blocked, decision, sign-off, review')
  expect((await tool.call({ tool: ADD, id: 'x', kind: 'review', title: '  ' })).isError).toBe(true)

  const broken = await tool.call({ tool: ADD, id: 'x', kind: 'review', title: 'X' })
  expect(broken.isError).toBe(true)
  expect(String(broken.result)).toContain('not a valid JSON array')
  expect(world.writes).toEqual([])
  expect(world.text).toBe('[{"id": "a", "kind": "review", "title": "A"},')
})

test('attention_add keeps entries and fields it does not know, and reopens a done item', async ($, on) => {
  const world = session(
    on,
    JSON.stringify([
      { note: 'not an item' },
      { id: 'old', kind: 'review', title: 'Old', done: true, owner: 'sam', recommendation: 'Do A', response: 'accepted', respondedAt: 't' },
    ]),
  )
  await $.session.start(START)
  const tool = $.tool as unknown as Tooling

  await tool.call({ tool: ADD, id: 'old', kind: 'review', title: 'Old, again', recommendation: 'Do B' })
  const list = saved(world)
  expect(list[0]).toEqual({ note: 'not an item' })
  expect(list[1]?.done).toBe(false)
  expect(list[1]?.owner).toBe('sam')
  // A new recommendation is a new question: the old answer does not carry over.
  expect(list[1]?.recommendation).toBe('Do B')
  expect(list[1]?.response).toBeUndefined()
})

test('attention_resolve marks an item done and names the ids when it is given a wrong one', async ($, on) => {
  const world = session(
    on,
    JSON.stringify([
      { id: 'region', kind: 'decision', title: 'Choose the hosting region' },
      { id: 'notes', kind: 'sign-off', title: 'Approve the release notes' },
    ]),
  )
  await $.session.start(START)
  const tool = $.tool as unknown as Tooling

  const wrong = await tool.call({ tool: RESOLVE, id: 'regoin' })
  expect(wrong.isError).toBe(true)
  expect(String(wrong.result)).toContain('region, notes')
  expect(world.writes).toEqual([])

  const done = await tool.call({ tool: RESOLVE, id: 'region' })
  expect(String(done.result)).toBe('Marked "region" done.')
  expect(saved(world).map(one => one.done)).toEqual([true, undefined])
})

test('nothing vanishes: an unknown kind is shown under Other and an entry that is not an item is counted', async ($, on) => {
  session(
    on,
    JSON.stringify([
      { id: 'a', kind: 'urgent', title: 'Renew the certificate' },
      { id: 'b', kind: 'decision', title: 'Pick a logo' },
      { id: 'c', kind: 'review' },
      'a stray string',
    ]),
  )
  await $.session.start(START)
  const said = await $.command.run(ATTENTION)
  expect(said.text).toContain('2 open items')
  expect(said.text).toContain('2 entries could not be shown')

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^Other/ }))?.text).toBe('Other (1)')
  expect((await ui.find({ type: 'Text', text: /certificate/ }))?.text).toBe('Renew the certificate')
  expect((await ui.find({ type: 'Text', text: /could not be shown/ }))?.text).toBe(
    '2 entries could not be shown: each needs an id and a title.',
  )
  await ui.unmount()
})

test('a list that stops parsing keeps the last good list on screen, marked as stale', async ($, on) => {
  const world = session(on, JSON.stringify([{ id: 'b', kind: 'decision', title: 'Pick a logo' }]))
  await $.session.start(START)

  world.text = '[{"id": "b", "kind": "decision", "title": "Pick a lo'
  await world.clock.advance(5000)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /not a valid JSON/ }))?.text).toBe('The action list is not a valid JSON array.')
  expect((await ui.find({ type: 'Text', text: /last list/ }))?.text).toBe('Showing the last list that could be read.')
  expect((await ui.find({ type: 'Text', text: /Pick a logo/ }))?.text).toBe('Pick a logo')
  await ui.unmount()

  // Repaired: the warning goes.
  world.text = JSON.stringify([{ id: 'b', kind: 'decision', title: 'Pick a logo' }])
  await world.clock.advance(5000)
  const repaired = await $.ui.mount(PANE)
  expect(await repaired.find({ type: 'Text', text: /not a valid JSON/ })).toBeUndefined()
  await repaired.unmount()
})

test('a missing list is not an error: the pane says nothing is waiting and where the list will be', async ($, on) => {
  session(on)
  await $.session.start(START)
  const said = await $.command.run(ATTENTION)
  expect(said.text).toContain('Nothing is listed yet')
  expect(said.text).toContain(FILE)
  expect(said.text).not.toContain('could not be read')

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Nothing is waiting/ }))?.text).toBe('Nothing is waiting on you.')
  await ui.unmount()
})

test('the status line counts what is open, and a new item is announced once', async ($, on) => {
  const world = session(on, JSON.stringify([{ id: 'b', kind: 'decision', title: 'Pick a logo' }]))
  await $.session.start(START)
  expect(world.statuses.at(-1)).toBe('1 waiting on you')
  // What was already there when the session began is not announced.
  expect(world.toasts).toEqual([])

  world.text = JSON.stringify([
    { id: 'b', kind: 'decision', title: 'Pick a logo' },
    { id: 'n', kind: 'blocked', title: 'Grant access to the staging server' },
  ])
  await world.clock.advance(5000)
  expect(world.statuses.at(-1)).toBe('2 waiting on you')
  expect(world.toasts).toEqual(['Waiting on you: Grant access to the staging server'])
  await world.clock.advance(5000)
  expect(world.toasts.length).toBe(1)

  world.text = JSON.stringify([
    { id: 'b', kind: 'decision', title: 'Pick a logo', done: true },
    { id: 'n', kind: 'blocked', title: 'Grant access to the staging server', done: true },
  ])
  await world.clock.advance(5000)
  expect(world.statuses.at(-1)).toBeUndefined()
})

test('an answer that asks for something while the list stayed the same is flagged, and one press asks Claude to list it', async ($, on) => {
  const world = session(on, JSON.stringify([{ id: 'b', kind: 'decision', title: 'Pick a logo' }]))
  await $.session.start(START)

  await turn($, 'The migration is ready. Should I run it against production, or do you want a dry run first?')
  expect(world.toasts).toEqual(['Claude asked you for something that is not in the attention list.'])
  expect(world.prompts).toEqual([])

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /not in this list/ }))?.text).toBe(
    'Claude’s last answer asked you for something that is not in this list.',
  )
  await ui.press({ key: 'capture' })
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('.claude/action-items.json')
  expect(world.prompts[0]).toContain('attention_add')
  // Nothing Claude wrote travels back to it as the person's words.
  expect(world.prompts[0]).not.toContain('migration')
  expect(await ui.find({ type: 'Text', text: /not in this list/ })).toBeUndefined()
  await ui.unmount()

  // The turn that request starts is never flagged itself, whatever it answers.
  await turn($, 'Listed. Anything else?', undefined, world.prompts[0])
  const after = await $.ui.mount(PANE)
  expect(await after.find({ type: 'Text', text: /not in this list/ })).toBeUndefined()
  await after.unmount()
})

test('no flag when Claude updated the list in the turn, when the answer asks nothing, or in a subagent', async ($, on) => {
  const world = session(on, JSON.stringify([{ id: 'b', kind: 'decision', title: 'Pick a logo' }]))
  await $.session.start(START)
  const flagged = async () => {
    const ui = await $.ui.mount(PANE)
    const line = await ui.find({ type: 'Text', text: /not in this list/ })
    await ui.unmount()

    return line !== undefined
  }

  await turn($, 'Which region do you want?', async () => {
    await ($.tool as unknown as Tooling).call({ tool: ADD, id: 'region', kind: 'decision', title: 'Choose the hosting region' })
  })
  expect(await flagged()).toBe(false)

  await turn($, 'Done. All 12 tests pass and the branch is pushed.')
  expect(await flagged()).toBe(false)

  await $.turn.start({ text: 'look', turnId: 's1', agentId: 'a1' })
  await $.turn.complete({ answer: 'Should I continue?', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'a1' })
  expect(await flagged()).toBe(false)

  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete({ answer: 'Should I continue?', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(await flagged()).toBe(false)
  expect(world.toasts).toEqual(['Waiting on you: Choose the hosting region'])
})

test('a flag clears by itself once the list changes, and can be dismissed', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)
  const flagged = async () => {
    const ui = await $.ui.mount(PANE)
    const line = await ui.find({ type: 'Text', text: /not in this list/ })
    await ui.unmount()

    return line !== undefined
  }

  await turn($, 'I need your approval before I delete the old tables.')
  expect(await flagged()).toBe(true)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  expect(await flagged()).toBe(false)
  expect(world.prompts).toEqual([])

  await turn($, '請確認是否要刪除舊資料表。')
  expect(await flagged()).toBe(true)
  await turn($, 'Added it.', async () => {
    world.text = JSON.stringify([{ id: 'drop', kind: 'sign-off', title: 'Approve deleting the old tables' }])
  })
  expect(await flagged()).toBe(false)
})

test('other tools pass through the mod untouched', async ($, on) => {
  session(on, '[]')
  on('tool.call', (_, e) => ({ result: `ran ${String(e.tool)}` }))
  await $.session.start(START)
  const ran = await ($.tool as unknown as Tooling).call({ tool: 'Bash', command: 'ls' })
  expect(ran.result).toBe('ran Bash')
})
