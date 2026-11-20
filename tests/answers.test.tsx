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
