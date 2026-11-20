import { expect, test } from 'claude-code/testing'

import { ADD, ATTENTION, PANE, START, list, saved, session } from './world'
import type { Tooling } from './world'

const REGION = { id: 'region', kind: 'decision', title: 'Choose the hosting region', recommendation: 'Use the nearer region.' }

test('git is asked for the project root once in a session', async ($, on) => {
  const world = session(on, list(REGION))
  await $.session.start(START)
  await $.command.run(ATTENTION)
  await $.command.run(ATTENTION)
  await $.command.run(ATTENTION)
  await world.clock.advance(15000)

  expect(world.runs).toBe(1)
})

test('a file that did not change is not announced again', async ($, on) => {
  const world = session(on, list(REGION))
  await $.session.start(START)
  await $.command.run(ATTENTION)
  const told = world.statuses.length
  expect(told > 0).toBe(true)

  await world.clock.advance(15000)
  expect(world.statuses.length).toBe(told)

  // A change is still picked up on the next tick.
  world.text = list(REGION, { id: 'notes', kind: 'sign-off', title: 'Approve the release notes' })
  await world.clock.advance(5000)
  expect(world.statuses.at(-1)).toBe('2 waiting on you')
})

test('a write that fails is reported, to the person and to Claude, and nothing is thrown', async ($, on) => {
  const world = session(on, list(REGION))
  await $.session.start(START)
  world.isUnwritable = true

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'accept:region' })
  expect(world.toasts.at(-1)).toBe('The action list could not be updated.')
  expect(saved(world)[0]?.response).toBeUndefined()
  // The pane keeps the list it had.
  expect((await ui.find({ type: 'Text', text: /hosting region/ }))?.text).toBe('Choose the hosting region')
  await ui.unmount()

  const added = await ($.tool as unknown as Tooling).call({ tool: ADD, id: 'x', kind: 'review', title: 'X' })
  expect(added.isError).toBe(true)
  expect(String(added.result)).toContain('/proj/.claude/action-items.json')
  expect(String(added.result)).toContain('could not be written')
})

test('an entry that is not an object does not break an answer, and is kept', async ($, on) => {
  const world = session(on, JSON.stringify([42, null, REGION]))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'accept:region' })
  await ui.unmount()

  const after = saved(world) as unknown[]
  expect(after[0]).toBe(42)
  expect(after[1]).toBe(null)
  expect((after[2] as Record<string, unknown>).response).toBe('accepted')
})

test('two items with one id are flagged, and a press answers the first', async ($, on) => {
  const world = session(on, list(REGION, { ...REGION, title: 'Choose the region again' }))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /More than one item/ }))?.text).toBe(
    'More than one item has the id "region"; a press answers the first.',
  )
  await ui.press({ key: 'accept:region' })
  await ui.unmount()

  expect(saved(world)[0]?.response).toBe('accepted')
  expect(saved(world)[1]?.response).toBeUndefined()
})

test('the list vanishing before a press raises a toast, not an error', async ($, on) => {
  const world = session(on, list(REGION))
  await $.session.start(START)

  const ui = await $.ui.mount(PANE)
  world.isUnreadable = true
  await ui.press({ key: 'accept:region' })
  await ui.unmount()

  expect(world.toasts.at(-1)).toBe('That item is no longer waiting for an answer.')
  expect(world.writes.length).toBe(0)
})

test('a slow first read holds the start up for a second at most, and the pane waits for it', async ($, on) => {
  const world = session(on, list(REGION))
  let open = (): void => undefined
  world.gate = new Promise<void>(done => {
    open = done
  })

  let isStarted = false
  const start = $.session.start(START).then(() => {
    isStarted = true
  })
  await world.clock.advance(999)
  expect(isStarted).toBe(false)
  await world.clock.advance(1)
  await start
  expect(isStarted).toBe(true)

  open()
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /hosting region/ }))?.text).toBe('Choose the hosting region')
  await ui.unmount()
})
