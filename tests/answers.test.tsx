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
