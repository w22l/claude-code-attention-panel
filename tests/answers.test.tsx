import { expect, test } from 'claude-code/testing'

import { ADD, ATTENTION, PANE, START, list, saved, session } from './world'
import type { Entry, Tooling } from './world'

const CHECKS = { id: 'checks', kind: 'decision', title: 'Which checks should block a merge?' }
const tool = ($: unknown): Tooling => ($ as { tool: Tooling }).tool

test('attention_add stores the answer an item needs, cleaned up', async ($, on) => {
  const world = session(on)
  await $.session.start(START)

  const added = await tool($).call({
    tool: ADD,
    ...CHECKS,
    answer_type: 'multi',
    options: [' Lint ', 'Unit tests', 'Type check'],
    recommended: ['Lint', 'Nope'],
  })
  expect(added.isError).toBeUndefined()
  expect(saved(world)[0]?.answer).toEqual({ type: 'multi', options: ['Lint', 'Unit tests', 'Type check'], recommended: ['Lint'] })

  // A choice has one recommended option at most; confirm and text carry no options.
  await tool($).call({ tool: ADD, id: 'region', kind: 'decision', title: 'Region', answer_type: 'choice', options: ['A', 'B'], recommended: ['B', 'A'] })
  expect(saved(world)[1]?.answer).toEqual({ type: 'choice', options: ['A', 'B'], recommended: ['B'] })
  await tool($).call({ tool: ADD, id: 'url', kind: 'blocked', title: 'Base URL', answer_type: 'text', options: ['A', 'B'] })
  expect(saved(world)[2]?.answer).toEqual({ type: 'text' })
})

test('attention_add refuses options the pane could not draw, and writes nothing', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)
  const add = (extra: Entry) => tool($).call({ tool: ADD, ...CHECKS, ...extra })

  const bad: Entry[] = [
    { answer_type: 'rank', options: ['A', 'B'] },
    { answer_type: 'choice' },
    { answer_type: 'choice', options: ['A'] },
    { answer_type: 'multi', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] },
    { answer_type: 'multi', options: ['A', 'x'.repeat(61)] },
    { answer_type: 'multi', options: ['A', ' A '] },
    { answer_type: 'multi', options: ['A', '  '] },
    { answer_type: 'multi', options: ['A', 7] },
    { options: ['A', 'B'] },
  ]
  for (const extra of bad) {
    const answer = await add(extra)
    expect(answer.isError).toBe(true)
  }
  expect(world.writes.length).toBe(0)
  expect(String((await add({ answer_type: 'choice', options: ['A'] })).result)).toContain('2 to 8 options')

  // The limits themselves are fine: eight options, sixty characters.
  const fine = await add({ answer_type: 'multi', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'x'.repeat(60)] })
  expect(fine.isError).toBeUndefined()
})

test('attention_add refuses an id that could not be named in a prompt', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)

  const answer = await tool($).call({ tool: ADD, id: 'bad id!', kind: 'review', title: 'X' })
  expect(answer.isError).toBe(true)
  expect(String(answer.result)).toContain('letters, digits')
  expect((await tool($).call({ tool: ADD, id: 'x'.repeat(65), kind: 'review', title: 'X' })).isError).toBe(true)
  expect(world.writes.length).toBe(0)
})

test('a changed question clears the answer to the old one; the same question keeps it', async ($, on) => {
  const answered = { ...CHECKS, answer: { type: 'choice', options: ['A', 'B'] }, response: 'answered', selected: ['A'], note: 'n', respondedAt: 't' }
  const world = session(on, list(answered))
  await $.session.start(START)

  await tool($).call({ tool: ADD, ...CHECKS, title: 'Reworded', answer_type: 'choice', options: ['A', 'B'] })
  expect(saved(world)[0]?.response).toBe('answered')
  expect(saved(world)[0]?.selected).toEqual(['A'])

  await tool($).call({ tool: ADD, ...CHECKS, answer_type: 'choice', options: ['A', 'C'] })
  const after = saved(world)[0] ?? {}
  expect(after.response).toBeUndefined()
  expect(after.selected).toBeUndefined()
  expect(after.note).toBeUndefined()
  expect(after.respondedAt).toBeUndefined()
})

test('an item whose answer a hand edit broke is still shown', async ($, on) => {
  const broken = [{ type: 'rank' }, { type: 'choice', options: 'A' }, { type: 'multi', options: ['A'] }, { type: 'choice', options: [1, 2] }, 'multi', null]
  const world = session(on, '[]')
  await $.session.start(START)

  for (const answer of broken) {
    world.text = list({ id: 'notes', kind: 'sign-off', title: 'Approve the release notes', answer })
    await $.command.run(ATTENTION)
    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ type: 'Text', text: /release notes/ }))?.text).toBe('Approve the release notes')
    await ui.unmount()
  }
})

test('Claude is told which answers it can ask for and where to read them', async ($, on) => {
  session(on)
  await $.session.start(START)

  const { sections } = await $.prompt.compose({
    model: 'claude-test',
    promptModel: 'claude-test',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  const told = sections.at(-1)?.text ?? ''
  for (const word of ['answer_type', 'confirm', 'choice', 'multi', 'text', 'selected', 'note']) expect(told).toContain(word)
})

const NOTES = { id: 'notes', kind: 'sign-off', title: 'Approve the release notes' }
const KEY = { id: 'key', kind: 'blocked', title: 'Add the API key to .env' }
const PLAN = { id: 'plan', kind: 'review', title: 'Read the migration plan' }
const REGION = { id: 'region', kind: 'decision', title: 'Choose the hosting region', recommendation: 'Use the nearer region.' }

test('a sign-off without a recommendation can be approved or rejected in the pane', async ($, on) => {
  const world = session(on, list(NOTES))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'yes:notes' }))?.text).toBe('Approve')
  expect((await ui.find({ key: 'no:notes' }))?.text).toBe('Reject')
  // The old keys stay with items that carry a recommendation.
  expect(await ui.find({ key: 'accept:notes' })).toBeUndefined()

  await ui.press({ key: 'yes:notes' })
  expect(saved(world)[0]?.response).toBe('accepted')
  expect(saved(world)[0]?.done).toBeUndefined()
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('"notes"')
  expect(world.prompts[0]).toContain('accepted')
  expect(world.prompts[0]).not.toContain('release notes')
  expect((await ui.find({ type: 'Text', text: /^You answered/ }))?.text).toBe('You answered: Approve')
  expect(await ui.find({ key: 'yes:notes' })).toBeUndefined()
  await ui.unmount()
})

test('Done on a blocked item and Reviewed on a review item close it, and Claude is told', async ($, on) => {
  const world = session(on, list(KEY, PLAN))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'yes:key' }))?.text).toBe('Done')
  expect(await ui.find({ key: 'no:key' })).toBeUndefined()
  expect((await ui.find({ key: 'yes:plan' }))?.text).toBe('Reviewed')
  expect(await ui.find({ key: 'no:plan' })).toBeUndefined()

  await ui.press({ key: 'yes:key' })
  expect(saved(world)[0]?.response).toBe('accepted')
  expect(saved(world)[0]?.done).toBe(true)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).toContain('"key"')
  // A closed item leaves the pane.
  expect(await ui.find({ type: 'Text', text: /API key/ })).toBeUndefined()

  await ui.press({ key: 'yes:plan' })
  expect(saved(world)[1]?.done).toBe(true)
  await ui.unmount()
})

test('an explicit confirm takes its buttons from the kind; a broken answer falls back to them', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)

  for (const answer of [{ type: 'confirm' }, { type: 'rank' }, { type: 'multi', options: ['A'] }, { type: 'choice', options: [1, 2] }]) {
    world.text = list({ ...NOTES, answer })
    await $.command.run(ATTENTION)
    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ key: 'yes:notes' }))?.text).toBe('Approve')
    await ui.unmount()
  }

  // A decision asked as a confirm, with nothing recommended, is Accept or Reject.
  world.text = list({ id: 'go', kind: 'decision', title: 'Ship it today?', answer: { type: 'confirm' } })
  await $.command.run(ATTENTION)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'yes:go' }))?.text).toBe('Accept')
  expect((await ui.find({ key: 'no:go' }))?.text).toBe('Reject')
  await ui.unmount()
})

test('an answer to a question that changed since the pane drew it is refused', async ($, on) => {
  const world = session(on, list(NOTES, REGION))
  await $.session.start(START)
  const ui = await $.ui.mount(PANE)

  // Resolved elsewhere.
  world.text = list({ ...NOTES, done: true }, REGION)
  await ui.press({ key: 'yes:notes' })
  expect(saved(world)[0]?.response).toBeUndefined()
  expect(world.toasts.at(-1)).toBe('That item is no longer waiting for an answer.')

  // Answered elsewhere, and the pane has not read the file since: the first answer stands.
  world.text = list({ ...NOTES, done: true }, { ...REGION, response: 'rejected' })
  await ui.press({ key: 'accept:region' })
  expect(saved(world)[1]?.response).toBe('rejected')
  expect(world.prompts.length).toBe(0)
  expect(world.writes.length).toBe(0)
  await ui.unmount()
})

test('Change takes an answer back without telling Claude', async ($, on) => {
  const world = session(on, list(REGION))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'change:region' })).toBeUndefined()
  await ui.press({ key: 'reject:region' })
  expect(world.prompts.length).toBe(1)
  expect((await ui.find({ key: 'change:region' }))?.text).toBe('Change')

  await ui.press({ key: 'change:region' })
  expect(saved(world)[0]?.response).toBeUndefined()
  expect(saved(world)[0]?.respondedAt).toBeUndefined()
  expect(world.prompts.length).toBe(1)
  expect((await ui.find({ key: 'accept:region' }))?.text).toBe('Accept')
  await ui.unmount()
})

test('with Tell Claude when you answer off, an answer is saved and no prompt is sent', { options: { tellClaude: false } }, async ($, on) => {
  const world = session(on, list(NOTES, KEY))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'yes:notes' })
  await ui.press({ key: 'yes:key' })
  await ui.unmount()

  expect(saved(world)[0]?.response).toBe('accepted')
  expect(saved(world)[1]?.done).toBe(true)
  expect(world.prompts.length).toBe(0)
})

const HOSTING = {
  id: 'hosting',
  kind: 'decision',
  title: 'Choose the hosting region',
  answer: { type: 'choice', options: ['Tokyo', 'Singapore', 'Frankfurt'], recommended: ['Tokyo'] },
}
const GATES = {
  ...CHECKS,
  answer: { type: 'multi', options: ['Lint', 'Unit tests', 'Type check', 'E2E'], recommended: ['Lint', 'Type check'] },
}

test('a choice is answered with one press, and the prompt names the item only', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    world.text = list(HOSTING)
    await $.command.run(ATTENTION)
    world.prompts.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'pick:hosting:0' }))?.text).toBe('Tokyo (recommended)')
    expect((await ui.find({ key: 'pick:hosting:1' }))?.text).toBe('Singapore')
    expect((await ui.find({ key: 'pick:hosting:2' }))?.text).toBe('Frankfurt')
    expect(await ui.find({ key: 'submit:hosting' })).toBeUndefined()

    await ui.press({ key: 'pick:hosting:1' })

    const item = saved(world)[0] ?? {}
    expect(item.response).toBe('answered')
    expect(item.selected).toEqual(['Singapore'])
    expect(typeof item.respondedAt).toBe('string')
    expect(world.prompts.length).toBe(1)
    expect(world.prompts[0]).toContain('"hosting"')
    for (const label of ['Tokyo', 'Singapore', 'Frankfurt', 'region']) expect(world.prompts[0]).not.toContain(label)
    expect((await ui.find({ type: 'Text', text: /^You chose/ }))?.text).toBe('You chose: Singapore')
    expect(await ui.find({ key: 'pick:hosting:0' })).toBeUndefined()
    await ui.unmount()
  }
})

test('several options are ticked and sent together', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    world.text = list(GATES)
    await $.command.run(ATTENTION)
    world.prompts.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    // What Claude recommends starts ticked.
    expect((await ui.find({ key: 'pick:checks:0' }))?.text).toBe('[x] Lint')
    expect((await ui.find({ key: 'pick:checks:1' }))?.text).toBe('[ ] Unit tests')
    expect((await ui.find({ key: 'pick:checks:2' }))?.text).toBe('[x] Type check')
    expect((await ui.find({ key: 'pick:checks:3' }))?.text).toBe('[ ] E2E')
    expect((await ui.find({ key: 'submit:checks' }))?.text).toBe('Submit 2 selected')

    // A tick is not an answer: nothing is written until Submit.
    await ui.press({ key: 'pick:checks:3' })
    await ui.press({ key: 'pick:checks:1' })
    expect((await ui.find({ key: 'submit:checks' }))?.text).toBe('Submit 4 selected')
    await ui.press({ key: 'pick:checks:0' })
    expect((await ui.find({ key: 'pick:checks:0' }))?.text).toBe('[ ] Lint')
    expect((await ui.find({ key: 'submit:checks' }))?.text).toBe('Submit 3 selected')
    expect(saved(world)[0]?.response).toBeUndefined()
    expect(world.prompts.length).toBe(0)

    await ui.press({ key: 'submit:checks' })
    const item = saved(world)[0] ?? {}
    expect(item.response).toBe('answered')
    // In the order the options are listed, not the order they were ticked in.
    expect(item.selected).toEqual(['Unit tests', 'Type check', 'E2E'])
    expect(world.prompts.length).toBe(1)
    expect(world.prompts[0]).not.toContain('E2E')
    expect((await ui.find({ type: 'Text', text: /^You chose/ }))?.text).toBe('You chose: Unit tests, Type check, E2E')

    // Change brings the question back with what Claude recommends, not the old ticks.
    await ui.press({ key: 'change:checks' })
    expect((await ui.find({ key: 'submit:checks' }))?.text).toBe('Submit 2 selected')
    await ui.unmount()
  }
})

test('with nothing ticked there is nothing to submit', async ($, on) => {
  session(on, list(GATES))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'pick:checks:0' })
  await ui.press({ key: 'pick:checks:2' })
  expect(await ui.find({ key: 'submit:checks' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Tick/ }))?.text).toBe('Tick at least one.')
  await ui.unmount()
})

test('ticks outlive a re-read of the same list, and go when the options change', async ($, on) => {
  const world = session(on, list(GATES))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'pick:checks:3' })
  await world.clock.advance(5000)
  await $.command.run(ATTENTION)
  expect((await ui.find({ key: 'pick:checks:3' }))?.text).toBe('[x] E2E')

  // Claude rewrites the question: E2E is gone, a new option arrives unticked.
  world.text = list({ ...GATES, answer: { type: 'multi', options: ['Lint', 'Unit tests', 'Type check', 'Smoke'], recommended: ['Lint'] } })
  await world.clock.advance(5000)
  expect((await ui.find({ key: 'pick:checks:3' }))?.text).toBe('[ ] Smoke')
  expect((await ui.find({ key: 'submit:checks' }))?.text).toBe('Submit 2 selected')
  await ui.unmount()
})

test('a pick from options that changed since the pane drew them is refused', async ($, on) => {
  const world = session(on, list(HOSTING, GATES))
  await $.session.start(START)
  const ui = await $.ui.mount(PANE)

  world.text = list({ ...HOSTING, answer: { type: 'choice', options: ['Tokyo', 'Sydney'] } }, { ...GATES, answer: { type: 'multi', options: ['Lint', 'Smoke'] } })
  await ui.press({ key: 'pick:hosting:1' })
  expect(world.toasts.at(-1)).toBe('The question changed; look again.')
  // The pane has read the list again by now: the same press picks what is drawn.
  expect((await ui.find({ key: 'pick:hosting:1' }))?.text).toBe('Sydney')

  expect(world.writes.length).toBe(0)
  expect(world.prompts.length).toBe(0)
  await ui.unmount()
})

test('labels are matched as written: brackets, case and length do not confuse a pick', async ($, on) => {
  const long = 'x'.repeat(60)
  const world = session(on, list({ id: 'tag', kind: 'decision', title: 'Which tag?', answer: { type: 'choice', options: ['[beta]', 'Beta', 'beta ', long] } }))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'pick:tag:0' }))?.text).toBe('[beta]')
  expect((await ui.find({ key: 'pick:tag:3' }))?.text).toBe(long)
  await ui.press({ key: 'pick:tag:2' })
  expect(saved(world)[0]?.selected).toEqual(['beta'])
  await ui.unmount()
})

test('a yes to wording the person never saw is refused: the item is compared with what was drawn', async ($, on) => {
  const world = session(on, list(REGION, NOTES))
  await $.session.start(START)
  const ui = await $.ui.mount(PANE)

  // The recommendation is rewritten after the pane drew it, and before the press.
  world.text = list({ ...REGION, recommendation: 'Use the cheapest region, and delete the old one.' }, NOTES)
  await ui.press({ key: 'accept:region' })
  expect(world.toasts.at(-1)).toBe('The question changed; look again.')
  expect(world.writes.length).toBe(0)
  expect(world.prompts.length).toBe(0)
  // The pane now shows the new wording, and a press on that is an answer to it.
  expect((await ui.find({ type: 'Text', text: /Claude recommends/ }))?.text).toBe(
    'Claude recommends: Use the cheapest region, and delete the old one.',
  )

  // The same for a title, a detail or a path.
  for (const edit of [{ title: 'Approve the deletion' }, { detail: 'Now includes the database.' }, { path: '/proj/other.md' }]) {
    world.text = list(REGION, NOTES)
    await $.command.run(ATTENTION)
    world.text = list(REGION, { ...NOTES, ...edit })
    await ui.press({ key: 'yes:notes' })
    expect(world.toasts.at(-1)).toBe('The question changed; look again.')
  }
  expect(world.writes.length).toBe(0)

  // A change to another item, or to a field the pane does not draw, is no change to this one.
  world.text = list(REGION, NOTES)
  await $.command.run(ATTENTION)
  world.text = list({ ...REGION, title: 'Reworded' }, { ...NOTES, since: '2026-01-01', extra: 1 })
  await ui.press({ key: 'yes:notes' })
  expect(saved(world)[1]?.response).toBe('accepted')
  await ui.unmount()
})

const URL = { id: 'url', kind: 'blocked', title: 'What should the API base URL be?', answer: { type: 'text' } }
const LOGO = { id: 'logo', kind: 'decision', title: 'Pick a logo' }

test('a text item is answered by typing, and what was typed stays out of the prompt', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    world.text = list(URL)
    await $.command.run(ATTENTION)
    world.prompts.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    // The field is the control: no buttons beside it, though the item is "blocked".
    expect(await ui.find({ key: 'yes:url' })).toBeUndefined()
    expect(await ui.find({ key: 'reply:url' })).toBeUndefined()

    await ui.input({ key: 'text:url', text: 'https://api.example.com' })

    const item = saved(world)[0] ?? {}
    expect(item.response).toBe('answered')
    expect(item.note).toBe('https://api.example.com')
    expect(item.selected).toBeUndefined()
    expect(item.done).toBeUndefined()
    expect(world.prompts.length).toBe(1)
    expect(world.prompts[0]).toContain('"url"')
    expect(world.prompts[0]).not.toContain('example.com')
    expect((await ui.find({ type: 'Text', text: /^You replied/ }))?.text).toBe('You replied: https://api.example.com')
    await ui.unmount()
  }
})

test('Reply… answers any item in words, and Cancel puts the field away', async ($, on) => {
  const world = session(on, list(HOSTING, LOGO, NOTES))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  // Every item that is not itself a text field has the button, one with no other control included.
  for (const id of ['hosting', 'logo', 'notes']) expect((await ui.find({ key: `reply:${id}` }))?.text).toBe('Reply…')
  expect(await ui.find({ key: 'note:hosting' })).toBeUndefined()

  await ui.press({ key: 'reply:logo' })
  expect(await ui.find({ key: 'note:logo' })).toBeDefined()
  expect(await ui.find({ key: 'reply:logo' })).toBeUndefined()
  await ui.press({ key: 'cancel:logo' })
  expect(await ui.find({ key: 'note:logo' })).toBeUndefined()
  expect(world.writes.length).toBe(0)

  await ui.press({ key: 'reply:hosting' })
  await ui.input({ key: 'note:hosting', text: 'Neither, use Sydney' })
  const item = saved(world)[0] ?? {}
  expect(item.response).toBe('answered')
  expect(item.note).toBe('Neither, use Sydney')
  expect(item.selected).toBeUndefined()
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]).not.toContain('Sydney')
  expect((await ui.find({ type: 'Text', text: /^You replied/ }))?.text).toBe('You replied: Neither, use Sydney')

  // Taken back, the question returns with its buttons and the field closed.
  await ui.press({ key: 'change:hosting' })
  expect((await ui.find({ key: 'pick:hosting:1' }))?.text).toBe('Singapore')
  expect(await ui.find({ key: 'note:hosting' })).toBeUndefined()
  await ui.unmount()
})

test('an empty reply is ignored; a long or many-lined one is kept whole', async ($, on) => {
  const world = session(on, list(URL, LOGO))
  await $.session.start(START)
  const ui = await $.ui.mount(PANE)

  await ui.input({ key: 'text:url', text: '   ' })
  await ui.input({ key: 'text:url', text: '' })
  expect(world.writes.length).toBe(0)
  expect(world.prompts.length).toBe(0)

  const long = 'a'.repeat(10000)
  await ui.input({ key: 'text:url', text: long })
  expect(saved(world)[0]?.note).toBe(long)
  expect((world.prompts[0] ?? '').length < 300).toBe(true)

  await ui.press({ key: 'reply:logo' })
  await ui.input({ key: 'note:logo', text: 'The blue one.\nBut smaller,\nand without the tagline.' })
  expect(saved(world)[1]?.note).toBe('The blue one.\nBut smaller,\nand without the tagline.')
  await ui.unmount()
})

test('on mobile, where there is no field, buttons still answer and typed answers go to the chat', async ($, on) => {
  const world = session(on, list(URL, HOSTING, NOTES, GATES))
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /in the chat/ }))?.text).toBe('Answer this one in the chat.')
  expect(await ui.find({ key: 'text:url' })).toBeUndefined()
  for (const id of ['url', 'hosting', 'notes', 'checks']) expect(await ui.find({ key: `reply:${id}` })).toBeUndefined()

  await ui.press({ key: 'pick:hosting:2' })
  await ui.press({ key: 'yes:notes' })
  await ui.press({ key: 'pick:checks:1' })
  await ui.press({ key: 'submit:checks' })
  expect(saved(world)[1]?.selected).toEqual(['Frankfurt'])
  expect(saved(world)[2]?.response).toBe('accepted')
  expect(saved(world)[3]?.selected).toEqual(['Lint', 'Unit tests', 'Type check'])
  await ui.unmount()
})

test('each open item shows how long it has waited', async ($, on) => {
  const at = (since: unknown, id: string): Entry => ({ id, kind: 'review', title: `Item ${id}`, since })
  session(
    on,
    list(at('2026-11-20', 'a'), at('2026-11-18', 'b'), at('2026-11-07', 'c'), at('2026-11-06', 'd'), at('2026-10-30', 'e'), at('soon', 'f'), at('2026-12-01', 'g'), at(undefined, 'h'), at(20261120, 'i')),
    Date.parse('2026-11-20T15:00:00Z'),
  )
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  const ages = (await ui.findAll({ type: 'Text', text: /^(today|\d+[dw])$/ })).map(one => one.text)
  // Days up to thirteen, then whole weeks; nothing for a date that is missing, unreadable or ahead.
  expect(ages).toEqual(['today', '2d', '13d', '2w', '3w'])
  await ui.unmount()
})

test('an item written for 0.4.0 with a recommendation keeps Accept and Reject, whatever its kind', async ($, on) => {
  const world = session(on, '[]')
  await $.session.start(START)

  for (const kind of ['review', 'blocked', 'sign-off', 'decision']) {
    world.text = list({ id: 'old', kind, title: 'An old item', recommendation: 'Ship as is.' })
    await $.command.run(ATTENTION)
    world.prompts.length = 0
    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ key: 'accept:old' }))?.text).toBe('Accept')
    expect((await ui.find({ key: 'reject:old' }))?.text).toBe('Reject')

    await ui.press({ key: 'reject:old' })
    expect(saved(world)[0]?.response).toBe('rejected')
    // Accepting or rejecting a recommendation never closes the item: Claude acts on it first.
    expect(saved(world)[0]?.done).toBeUndefined()
    expect(world.prompts[0]).toContain('rejected your recommendation')
    await ui.unmount()
  }
})

test('fields of the wrong type in a hand-edited item do not blank the pane', async ($, on) => {
  const odd = [
    { ...GATES, response: 'answered', selected: 'Lint' },
    { ...HOSTING, response: 'answered', selected: null },
    { ...URL, response: 'answered', note: 5 },
    { ...NOTES, detail: { a: 1 }, path: ['x'], recommendation: { b: 2 } },
    { ...LOGO, response: 7, since: {} },
  ]
  const world = session(on, list(...odd))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  for (const title of [/checks should block/, /hosting region/, /API base URL/, /release notes/, /Pick a logo/]) {
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
  }
  // What cannot be read as an answer is not one: the sign-off can still be approved.
  await ui.press({ key: 'yes:notes' })
  expect(saved(world)[3]?.response).toBe('accepted')
  // The odd fields are written back as they were.
  expect(saved(world)[3]?.detail).toEqual({ a: 1 })
  await ui.unmount()
})

test('two ticks pressed before the pane redraws both count', async ($, on) => {
  session(on, list(GATES))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  await Promise.all([ui.press({ key: 'pick:checks:1' }), ui.press({ key: 'pick:checks:3' })])
  expect((await ui.find({ key: 'submit:checks' }))?.text).toBe('Submit 4 selected')
  await ui.unmount()
})

test('an item Claude raises again after it was closed asks again, without the old answer', async ($, on) => {
  const world = session(on, list(KEY))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'yes:key' })
  expect(saved(world)[0]?.done).toBe(true)

  await tool($).call({ tool: ADD, ...KEY })
  const item = saved(world)[0] ?? {}
  expect(item.done).toBe(false)
  expect(item.response).toBeUndefined()
  expect(item.respondedAt).toBeUndefined()
  expect((await ui.find({ key: 'yes:key' }))?.text).toBe('Done')
  await ui.unmount()
})
