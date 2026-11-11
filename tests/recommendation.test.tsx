import { expect, mock, test } from 'claude-code/testing'

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
} as const

const ATTENTION = {
  command: 'attention',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 160 },
} as const

const LIST = [
  { id: 'region', kind: 'decision', title: 'Choose the hosting region', recommendation: 'Use the nearer region.' },
  { id: 'notes', kind: 'sign-off', title: 'Approve the release notes' },
  { id: 'logo', kind: 'decision', title: 'Pick a logo', done: true },
]

test('accepting a recommendation writes the answer and tells Claude by id only', async ($, on) => {
  mock.clock(on)
  let text = JSON.stringify(LIST)
  const prompts: string[] = []
  on('command.register', () => ({ value: { command: 'attention' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/proj' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: text }))
  on('fs.write', (_, e) => {
    text = e.text

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    text = JSON.stringify(LIST)
    // The pane draws what the mod last read: /attention reads the list again.
    await $.command.run(ATTENTION)
    prompts.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Claude recommends/ }))?.text).toBe(
      'Claude recommends: Use the nearer region.',
    )
    // Only the item with a recommendation gets buttons; done items are not drawn.
    expect(await ui.find({ key: 'accept:notes' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Pick a logo/ })).toBeUndefined()

    await ui.press({ key: 'accept:region' })

    const saved = JSON.parse(text) as Array<Record<string, unknown>>
    expect(saved[0]?.response).toBe('accepted')
    expect(typeof saved[0]?.respondedAt).toBe('string')
    expect(saved[1]?.response).toBeUndefined()
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('"region"')
    expect(prompts[0]).toContain('accepted')
    // The item's own words never travel in the prompt.
    expect(prompts[0]).not.toContain('nearer region')

    expect((await ui.find({ type: 'Text', text: /You accepted/ }))?.text).toBe('You accepted: Use the nearer region.')
    expect(await ui.find({ key: 'accept:region' })).toBeUndefined()
    await ui.unmount()
  }
})

test('rejecting writes rejected; a missing list is reported, not drawn as empty', async ($, on) => {
  mock.clock(on)
  let text = JSON.stringify(LIST)
  let isMissing = false
  on('command.register', () => ({ value: { command: 'attention' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/proj' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => {
    if (isMissing) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', (_, e) => {
    text = e.text

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reject:region' })
  expect((JSON.parse(text) as Array<Record<string, unknown>>)[0]?.response).toBe('rejected')
  await ui.unmount()

  isMissing = true
  await $.command.run(ATTENTION)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await again.find({ type: 'Text', text: /No action list/ }))?.text).toBe('No action list for this project yet.')
  await again.unmount()
})
