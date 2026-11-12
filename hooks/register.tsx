import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActionItem, Board } from '../types'

const PANE = 'attention'
const TITLE = 'Needs your attention'
const DEFAULT_FILE = '.claude/action-items.json'
const ADD_TOOL = 'attention_add'
const RESOLVE_TOOL = 'attention_resolve'
type Kind = ActionItem['kind']
type Group = Kind | 'other'
const KINDS: Kind[] = ['blocked', 'decision', 'sign-off', 'review']
const LABEL: Record<Group, string> = {
  decision: 'Decide',
  'sign-off': 'Sign off',
  blocked: 'Blocked on you',
  review: 'Review',
  other: 'Other',
}
// An item whose kind is not one of the four is still shown, last, under "Other".
const ORDER: Group[] = [...KINDS, 'other']
// Theme keys, so the headings follow the person's Claude Code theme.
const TINT: Record<Group, 'error' | 'warning' | 'success' | 'suggestion' | 'inactive'> = {
  blocked: 'error',
  decision: 'warning',
  'sign-off': 'success',
  review: 'suggestion',
  other: 'inactive',
}

// Words in Claude's answer that mean it is waiting on the person. Deliberately
// broad: a miss loses an item, a false alarm costs one dismissible line.
const ASKS =
  /\?\s*$|\b(need(s|ed)? (from you|you to|your)|waiting on you|blocked on you|let me know|your (decision|approval|sign-?off|call|answer|go-ahead)|(do|would) you (want|like|prefer)|should i\b|shall i\b|which (one |option )?(do|would|should) (you|i|we)|please (confirm|decide|approve|review|choose|sign))|需要你|需要您|請確認|請決定|請核准|請審閱/im

// What Claude is sent when asked to list what its last answer asked for. It
// names the file and nothing from the answer, so no text Claude or a document
// wrote arrives with the person's authority.
const captureRequest = (file: string): string =>
  `Your last message asked me for something that is not in the action list. Add each thing you are waiting on me for to ${file} (the ${ADD_TOOL} tool does it), mark anything already settled as done, then reply in one line.`

// Added to the system prompt, so the list is kept in every project without a
// line in its CLAUDE.md.
const instruction = (file: string): string =>
  [
    '# Action items for the project owner',
    `This project keeps a list of what is waiting on the person at ${file}; a pane beside the chat shows it.`,
    'Whenever you need something only they can give (a decision, a sign-off, a review, or a step only they can take), add it to the list in the same turn in which you ask, before you finish your reply. If a reply asks for three things, the list gains three items.',
    `Add an item with the ${ADD_TOOL} tool (id, kind, title, and where useful detail, path and recommendation); kind is one of blocked, decision, sign-off, review. Give path as a full path to the file to look at. When an item is settled, by them or by events, call ${RESOLVE_TOOL} with its id.`,
    'If you edit the file directly instead, keep it a JSON array and keep every other item as it is. Do not list work you can do yourself.',
  ].join('\n')

const board = atom({ plugin: 'attention-panel', key: 'board' } as const, { items: [] } as Board, {
  shape: 'board-5',
})

const groupOf = (item: ActionItem): Group => (KINDS.includes(item.kind) ? item.kind : 'other')
const isOpen = (item: ActionItem): boolean => !item.done
const today = (): string => new Date().toISOString().slice(0, 10)
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// The list belongs to the project the session is in. In a git worktree the
// session's root is the worktree, so the list is looked up in the main
// checkout: one list per project, whichever worktree the session moved to.
async function projectRoot($: EngineInterface): Promise<string> {
  const root = await $.session.root()
  try {
    const git = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })
    const common = git.stdout.trim()
    if (git.exitCode === 0 && common.endsWith('/.git')) return common.slice(0, -'/.git'.length)
  } catch {
    // not a git repository, or git is missing: the session's root stands
  }

  return root
}

const sourceOf = async ($: EngineInterface, file: string): Promise<string> =>
  file.startsWith('/') ? file : `${await projectRoot($)}/${file}`

// The list's text as it stands, or undefined when there is no file.
async function rawList($: EngineInterface, file: string): Promise<string | undefined> {
  try {
    return String(await $.fs.read(await sourceOf($, file)))
  } catch {
    return undefined
  }
}

// An entry is an item when it has an id and a title to show. Anything else in
// the array is counted, so the pane can say that something was left out.
function parse(text: string): { items: ActionItem[]; skipped: number } {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('not an array')
  const items = parsed.filter(
    (one): one is ActionItem =>
      typeof one === 'object' &&
      one !== null &&
      typeof (one as ActionItem).id === 'string' &&
      (one as ActionItem).id !== '' &&
      typeof (one as ActionItem).title === 'string' &&
      (one as ActionItem).title !== '',
  )

  return { items, skipped: parsed.length - items.length }
}

// Module memory of which open items the person has been told about. It starts
// over on a reload, when the first read fills it without a toast.
let known: Set<string> | undefined

function announce($: EngineInterface, state: Board): void {
  const open = state.items.filter(isOpen)
  $.ui.status(open.length > 0 ? `${open.length} waiting on you` : undefined)
  if (state.error) return
  const fresh = known === undefined ? [] : open.filter(item => !known?.has(item.id))
  known = new Set(open.map(item => item.id))
  if (fresh.length === 1) void $.ui.toast(`Waiting on you: ${fresh[0]?.title ?? ''}`)
  if (fresh.length > 1) void $.ui.toast(`${fresh.length} new items are waiting on you.`)
}

async function refresh($: EngineInterface, file: string): Promise<void> {
  const now = await read($, board)
  let next: Board
  let source = file
  try {
    source = await sourceOf($, file)
    const text = String(await $.fs.read(source))
    try {
      next = { ...parse(text), source, readAt: new Date().toISOString() }
    } catch {
      // A half-written or broken file must not blank the pane: the last list
      // that could be read stays up, marked as stale.
      const kept = now.source === source ? now.items : []
      next = { items: kept, source, error: 'invalid', isStale: kept.length > 0 }
    }
  } catch {
    next = { items: [], source, error: 'missing' }
  }
  next.isUncaptured = now.isUncaptured
  if (
    JSON.stringify(now.items) !== JSON.stringify(next.items) ||
    now.error !== next.error ||
    now.source !== next.source ||
    (now.skipped ?? 0) !== (next.skipped ?? 0)
  ) {
    await update($, board, () => next)
  }
  announce($, next)
}

async function setUncaptured($: EngineInterface, isUncaptured: boolean): Promise<void> {
  const now = await read($, board)
  if (Boolean(now.isUncaptured) !== isUncaptured) await update($, board, state => ({ ...state, isUncaptured }))
}

// A press on Accept or Reject: the answer is written onto the item in the list
// file, so it survives the session and Claude finds it there. The file is read
// again first, so an edit made since the pane last drew is kept.
async function respond(
  $: EngineInterface,
  file: string,
  id: string,
  response: 'accepted' | 'rejected',
  isTelling: boolean,
): Promise<void> {
  const source = await sourceOf($, file)
  try {
    const parsed: unknown = JSON.parse(String(await $.fs.read(source)))
    if (!Array.isArray(parsed)) throw new Error('not an array')
    const items = parsed as ActionItem[]
    const item = items.find(one => one.id === id)
    if (!item || item.done || !item.recommendation) {
      await $.ui.toast('That item is no longer waiting for an answer.')
    } else {
      item.response = response
      item.respondedAt = new Date().toISOString()
      await $.fs.write(source, `${JSON.stringify(items, null, 2)}\n`)
      await $.ui.toast(`Recommendation ${response}.`)
      // Only the item's id and the answer are sent as a prompt, never the
      // item's own text: what the file says must not arrive with the
      // person's authority. An id that is not a plain token is left out.
      if (isTelling) {
        const name = /^[A-Za-z0-9._-]{1,64}$/.test(id) ? `"${id}"` : 'one item'
        void $.prompt.submit({
          text: `In the attention panel I ${response} your recommendation for action item ${name}. Read the item in ${file} and act on that answer, then update the list.`,
        })
      }
    }
  } catch {
    await $.ui.toast('The action list could not be updated.')
  }
  await refresh($, file)
}

// The two tools read the whole array, change one entry and write it back, so
// entries the pane cannot show and fields it does not know are kept as they are.
async function loadForWrite($: EngineInterface, file: string): Promise<{ source: string; entries: unknown[] } | string> {
  const source = await sourceOf($, file)
  const text = await rawList($, file)
  if (text === undefined) return { source, entries: [] }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('not an array')

    return { source, entries: parsed }
  } catch {
    return `${source} is not a valid JSON array. Repair the file first (keep every item), then call this tool again.`
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

async function addItem($: EngineInterface, file: string, input: Record<string, unknown>): Promise<{ result: string; isError?: true }> {
  const id = text(input.id)
  const title = text(input.title)
  const kind = text(input.kind)
  if (!id || !title) return { result: 'An item needs an id and a title.', isError: true }
  if (!kind || !KINDS.includes(kind as Kind)) {
    return { result: `kind must be one of ${KINDS.join(', ')}.`, isError: true }
  }
  const loaded = await loadForWrite($, file)
  if (typeof loaded === 'string') return { result: loaded, isError: true }
  const fields = {
    kind: kind as Kind,
    title,
    ...(text(input.detail) ? { detail: text(input.detail) } : {}),
    ...(text(input.path) ? { path: text(input.path) } : {}),
    ...(text(input.recommendation) ? { recommendation: text(input.recommendation) } : {}),
  }
  const at = loaded.entries.findIndex(one => typeof one === 'object' && one !== null && (one as ActionItem).id === id)
  if (at === -1) {
    loaded.entries.push({ id, ...fields, since: today(), done: false })
  } else {
    const old = loaded.entries[at] as ActionItem
    const merged: ActionItem = { ...old, ...fields, done: false }
    // A new recommendation is a new question: the answer to the old one goes.
    if (fields.recommendation !== undefined && fields.recommendation !== old.recommendation) {
      delete merged.response
      delete merged.respondedAt
    }
    loaded.entries[at] = merged
  }
  await $.fs.write(loaded.source, `${JSON.stringify(loaded.entries, null, 2)}\n`)
  await refresh($, file)
  await setUncaptured($, false)
  const open = loaded.entries.filter(one => typeof one === 'object' && one !== null && !(one as ActionItem).done).length

  return { result: `${at === -1 ? 'Added' : 'Updated'} "${id}". ${plural(open, 'item is', 'items are')} open in ${loaded.source}.` }
}

async function resolveItem($: EngineInterface, file: string, input: Record<string, unknown>): Promise<{ result: string; isError?: true }> {
  const id = text(input.id)
  if (!id) return { result: 'Give the id of the item to mark done.', isError: true }
  const loaded = await loadForWrite($, file)
  if (typeof loaded === 'string') return { result: loaded, isError: true }
  const item = loaded.entries.find(one => typeof one === 'object' && one !== null && (one as ActionItem).id === id) as
    | ActionItem
    | undefined
  if (!item) {
    const ids = loaded.entries
      .map(one => (typeof one === 'object' && one !== null ? (one as ActionItem).id : undefined))
      .filter(Boolean)

    return { result: `No item "${id}". The list holds: ${ids.join(', ') || 'nothing'}.`, isError: true }
  }
  item.done = true
  await $.fs.write(loaded.source, `${JSON.stringify(loaded.entries, null, 2)}\n`)
  await refresh($, file)

  return { result: `Marked "${id}" done.` }
}

export const register: Register = (on, options) => {
  const file = typeof options.file === 'string' && options.file.trim() !== '' ? options.file.trim() : DEFAULT_FILE
  const isTelling = options.tellClaude !== false
  const isInstructing = options.instructClaude !== false
  const isAutoCapturing = options.autoCapture === true

  // The list as it stood when the turn began, and whether this turn is the
  // mod's own capture request (which must never raise another).
  let before: string | undefined
  let isCaptureTurn = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'attention',
      description: 'Show the action items in this project that need your attention',
    })
    if (isInstructing) {
      await $.tool.register({
        name: ADD_TOOL,
        description:
          'Add an item to the list of things waiting on the project owner (or update the item with that id). Call it in the same turn in which you ask them for a decision, a sign-off, a review, or a step only they can take.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short stable identifier, unique in the list, e.g. "choose-region"' },
            kind: { type: 'string', enum: KINDS, description: 'blocked: you cannot continue without it; decision; sign-off; review' },
            title: { type: 'string', description: 'One line saying what is needed from them' },
            detail: { type: 'string', description: 'One or two sentences of context' },
            path: { type: 'string', description: 'Full path of the file or folder to look at' },
            recommendation: { type: 'string', description: 'What you recommend; the pane shows it with Accept and Reject buttons' },
          },
          required: ['id', 'kind', 'title'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: RESOLVE_TOOL,
        description: 'Mark an item of the list of things waiting on the project owner as done, once it is settled.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The id of the item' } },
          required: ['id'],
        },
        isDeferred: false,
      })
    }
    await refresh($, file)
    $.clock.every(5000, () => refresh($, file))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  // The mod's two tools are answered here; every other tool call passes
  // straight through, and stays untouched if this hook ever fails.
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (tool === `mcp__attention-panel__${ADD_TOOL}`) return addItem($, file, e as Record<string, unknown>)
    if (tool === `mcp__attention-panel__${RESOLVE_TOOL}`) return resolveItem($, file, e as Record<string, unknown>)

    return next(e)
  }).catch(($, e, next) =>
    String(e.tool).startsWith('mcp__attention-panel__')
      ? { result: 'The action list could not be updated; edit the file directly.', isError: true }
      : next(e),
  )

  // Claude is told about the list in the system prompt, so a project needs no
  // line in its CLAUDE.md for the list to be kept.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isInstructing) return composed

    return {
      ...composed,
      sections: [...composed.sections, { id: 'attention-panel:keep-current', text: instruction(file), scope: 'session' as const }],
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      before = await rawList($, file)
      isCaptureTurn = e.text === captureRequest(file)
    }

    return next(e)
  })

  // The net under the instruction: an answer that asks the person for something
  // while the list stayed as it was is flagged in the pane, where one press
  // asks Claude to list it (or, with the option on, the mod asks by itself).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    const after = await rawList($, file)
    if (after !== before) {
      await setUncaptured($, false)
      await refresh($, file)
    } else if (!isCaptureTurn && ASKS.test(e.answer)) {
      await setUncaptured($, true)
      if (isAutoCapturing) void $.prompt.submit({ text: captureRequest(file) })
      else void $.ui.toast('Claude asked you for something that is not in the attention list.')
    }

    return done
  })

  on('command.run', { command: 'attention' }, async $ => {
    await refresh($, file)
    await $.ui.open({ id: PANE, title: TITLE })
    const state = await read($, board)
    const flagged = state.isUncaptured ? ' Claude’s last answer asked for something that is not listed.' : ''
    if (state.error === 'invalid') {
      return { text: `Attention pane opened, but the list is not a valid JSON array: ${state.source}${flagged}` }
    }
    if (state.error) {
      return { text: `Attention pane opened. Nothing is listed yet; Claude creates the list at ${state.source} when it first needs you.${flagged}` }
    }
    const open = state.items.filter(isOpen).length
    const skipped = state.skipped ? ` ${plural(state.skipped, 'entry', 'entries')} could not be shown.` : ''

    return { text: `Attention pane opened: ${plural(open, 'open item', 'open items')} from ${state.source}.${skipped}${flagged}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, board)
    const shown = ORDER.flatMap(group => state.items.filter(item => isOpen(item) && groupOf(item) === group))
    const done = state.items.filter(item => item.done).length
    // One number per open item, counted down the pane, so "item 3" names one thing.
    const numberOf = new Map(shown.map((item, index) => [item, index + 1]))
    // The number sits in a column of its own: wrapped lines of the title, detail
    // and path start under the text, never under the number.
    const gutter = String(shown.length).length + 2

    return (
      <Box flexDirection="column">
        {state.isUncaptured && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="warning">Claude’s last answer asked you for something that is not in this list.</Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="capture"
                label="Ask Claude to list it"
                onPress={() => {
                  void setUncaptured($, false)
                  void $.prompt.submit({ text: captureRequest(file) })
                }}
              />
              <Button
                key="dismiss"
                label="Dismiss"
                onPress={() => {
                  void setUncaptured($, false)
                }}
              />
            </Box>
          </Box>
        )}
        {state.error === 'invalid' && (
          <Box flexDirection="column" marginBottom={state.isStale ? 1 : 0}>
            <Text color="error">The action list is not a valid JSON array.</Text>
            {state.isStale && <Text dimColor>Showing the last list that could be read.</Text>}
            <Text dimColor>{state.source}</Text>
          </Box>
        )}
        {state.error === 'missing' && (
          <Box flexDirection="column">
            <Text dimColor>Nothing is waiting on you.</Text>
            <Text dimColor>Claude creates the list when it first needs you: {state.source}</Text>
          </Box>
        )}
        {!state.error && shown.length === 0 && <Text dimColor>Nothing is waiting on you.</Text>}
        {ORDER.map(group => {
          const items = shown.filter(item => groupOf(item) === group)
          if (items.length === 0) return null

          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color={TINT[group]}>
                {LABEL[group]} ({items.length})
              </Text>
              {items.map(item => (
                <Box flexDirection="row">
                  <Box width={gutter} flexShrink={0}>
                    <Text color={TINT[group]}>{numberOf.get(item)}.</Text>
                  </Box>
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text>{item.title}</Text>
                    {item.detail && <Text dimColor>{item.detail}</Text>}
                    {item.path && <Text dimColor>{item.path}</Text>}
                    {item.recommendation && !item.response && (
                      <Box flexDirection="column">
                        <Text color="claude">Claude recommends: {item.recommendation}</Text>
                        <Box flexDirection="row" gap={1}>
                          <Button
                            key={`accept:${item.id}`}
                            label="Accept"
                            onPress={() => {
                              void respond($, file, item.id, 'accepted', isTelling)
                            }}
                          />
                          <Button
                            key={`reject:${item.id}`}
                            label="Reject"
                            onPress={() => {
                              void respond($, file, item.id, 'rejected', isTelling)
                            }}
                          />
                        </Box>
                      </Box>
                    )}
                    {item.recommendation && item.response && (
                      <Text dimColor>
                        You {item.response}: {item.recommendation}
                      </Text>
                    )}
                  </Box>
                </Box>
              ))}
            </Box>
          )
        })}
        {Boolean(state.skipped) && (
          <Text color="warning">
            {plural(state.skipped ?? 0, 'entry', 'entries')} could not be shown: each needs an id and a title.
          </Text>
        )}
        {done > 0 && <Text dimColor>{done} done</Text>}
      </Box>
    )
  })
}
