import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActionItem, AnswerSpec, AnswerType, Board } from '../types'

const PANE = 'attention'
const TITLE = 'Needs your attention'
const DEFAULT_FILE = '.claude/action-items.json'
const ADD_TOOL = 'attention_add'
const RESOLVE_TOOL = 'attention_resolve'
// How long, in milliseconds, the session's start waits for the first read of the list.
const START_WAIT = 1000
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
// The answers an item can ask for, and what a list of options may hold.
const ANSWERS: AnswerType[] = ['confirm', 'choice', 'multi', 'text']
const MIN_OPTIONS = 2
const MAX_OPTIONS = 8
const MAX_LABEL = 60
// An id the mod can name in a prompt it sends for the person.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/
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
    `Say what kind of answer you need with answer_type, so they can give it in the pane: confirm (yes or no), choice (one of the options you give), multi (any number of the options you give) or text (they type it). Give ${MIN_OPTIONS} to ${MAX_OPTIONS} short options for choice and multi, and name the ones you would pick in recommended.`,
    'An item with a response has been answered in the pane: read its response, selected (the options they picked) and note (what they typed), act on that answer, then resolve the item.',
    'If you edit the file directly instead, keep it a JSON array and keep every other item as it is. Do not list work you can do yourself.',
  ].join('\n')

const board = atom({ plugin: 'attention-panel', key: 'board' } as const, { items: [] } as Board, {
  shape: 'board-6',
})

const groupOf = (item: ActionItem): Group => (KINDS.includes(item.kind) ? item.kind : 'other')
const isOpen = (item: ActionItem): boolean => !item.done
const today = (): string => new Date().toISOString().slice(0, 10)
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// The list belongs to the project the session is in. In a git worktree the
// session's root is the worktree, so the list is looked up in the main
// checkout: one list per project, whichever worktree the session moved to.
async function findRoot($: EngineInterface): Promise<string> {
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

// Asked once: the answer cannot change while the session lives, and the list
// is read every few seconds.
let root: Promise<string> | undefined

const projectRoot = ($: EngineInterface): Promise<string> => (root ??= findRoot($))

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

type Entry = Record<string, unknown>

// The array may hold anything a hand edit left in it: only an object is looked into.
const isEntry = (one: unknown): one is Entry => typeof one === 'object' && one !== null && !Array.isArray(one)

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

// Every change to the list file is read-modify-write of the whole array, so the
// writers (the two tools and a press on Accept or Reject) take turns: a second
// one starts only when the first has written, and reads what it wrote.
let writing: Promise<unknown> = Promise.resolve()

function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = writing.then(job, job)
  writing = run.catch(() => undefined)

  return run
}

// The ids of the open items in the list's text; empty when there is no list
// or it cannot be read.
function openIds(text: string | undefined): Set<string> {
  if (text === undefined) return new Set()
  try {
    return new Set(parse(text).items.filter(isOpen).map(item => item.id))
  } catch {
    return new Set()
  }
}

// Module memory of which open items the person has been told about. It starts
// over on a reload, when the first read fills it without a toast.
let known: Set<string> | undefined

function announce($: EngineInterface, state: Board): void {
  const open = state.items.filter(isOpen)
  $.ui.status(open.length > 0 ? `${open.length} waiting on you` : undefined)
  // A broken file says nothing about what is new. A missing one does: nothing
  // is known yet, so the first item Claude adds is announced.
  if (state.error === 'invalid') return
  const fresh = known === undefined ? [] : open.filter(item => !known?.has(item.id))
  known = new Set(open.map(item => item.id))
  if (fresh.length === 1) void $.ui.toast(`Waiting on you: ${fresh[0]?.title ?? ''}`)
  if (fresh.length > 1) void $.ui.toast(`${fresh.length} new items are waiting on you.`)
}

// The ids that more than one item carries: a press can only name the first.
function duplicatesOf(items: ActionItem[]): string[] {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const item of items) (seen.has(item.id) ? twice : seen).add(item.id)

  return [...twice]
}

// What the last read found, so a file that has not changed costs one read and
// nothing else. `null` is a file that was not there.
let last: { source: string; text: string | null } | undefined

async function refresh($: EngineInterface, file: string): Promise<void> {
  let source = file
  let text: string | null = null
  try {
    source = await sourceOf($, file)
    text = String(await $.fs.read(source))
  } catch {
    text = null
  }
  if (last?.source === source && last.text === text) return
  last = { source, text }
  const now = await read($, board)
  let next: Board
  if (text === null) next = { items: [], source, error: 'missing' }
  else {
    try {
      const { items, skipped } = parse(text)
      const duplicates = duplicatesOf(items)
      next = { items, skipped, source, readAt: new Date().toISOString(), ...(duplicates.length > 0 ? { duplicates } : {}) }
    } catch {
      // A half-written or broken file must not blank the pane: the last list
      // that could be read stays up, marked as stale.
      const kept = now.source === source ? now.items : []
      next = { items: kept, source, error: 'invalid', isStale: kept.length > 0 }
    }
  }
  if (
    JSON.stringify(now.items) !== JSON.stringify(next.items) ||
    now.error !== next.error ||
    now.source !== next.source ||
    (now.skipped ?? 0) !== (next.skipped ?? 0)
  ) {
    // The flag is taken as it stands when the write lands, not as it stood
    // before the file was read: a press or a turn's end may have changed it.
    await update($, board, state => ({ ...next, isUncaptured: state.isUncaptured }))
  }
  announce($, next)
}

async function setUncaptured($: EngineInterface, isUncaptured: boolean): Promise<void> {
  const now = await read($, board)
  if (Boolean(now.isUncaptured) !== isUncaptured) await update($, board, state => ({ ...state, isUncaptured }))
}

// Every writer (the two tools and a press in the pane) changes the list this
// way: the whole array is read, one entry is changed and the array is written
// back, so entries the pane cannot show and fields it does not know are kept as
// they are. `edit` changes the entries in place, or returns why it will not.
// Nothing here throws: a file that cannot be parsed or written is an answer.
type Changed = { source: string; entries: unknown[] } | { error: string; isRefused?: true }

async function change($: EngineInterface, file: string, edit: (entries: unknown[]) => string | undefined): Promise<Changed> {
  const source = await sourceOf($, file)
  const raw = await rawList($, file)
  let entries: unknown[] = []
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('not an array')
      entries = parsed
    } catch {
      return { error: `${source} is not a valid JSON array. Repair the file first (keep every item), then call this tool again.` }
    }
  }
  const refusal = edit(entries)
  if (refusal !== undefined) return { error: refusal, isRefused: true }
  try {
    await $.fs.write(source, `${JSON.stringify(entries, null, 2)}\n`)
  } catch {
    return { error: `${source} could not be written. Check that the file can be changed, then call this tool again.` }
  }
  await refresh($, file)

  return { source, entries }
}

// The first entry with that id: the one a press or a tool call means.
const entryOf = (entries: unknown[], id: string): Entry | undefined => entries.filter(isEntry).find(one => one.id === id)

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
  const changed = await change($, file, entries => {
    const item = entryOf(entries, id)
    if (!item || item.done || !item.recommendation) return 'That item is no longer waiting for an answer.'
    item.response = response
    item.respondedAt = new Date().toISOString()

    return undefined
  })
  if ('error' in changed) {
    await $.ui.toast(changed.isRefused ? changed.error : 'The action list could not be updated.')
    await refresh($, file)

    return
  }
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

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

// The answer an item asks for, as written in the file or given to the tool:
// undefined when there is none, the cleaned-up answer when it can be drawn, and
// otherwise a sentence saying what to put right.
function readAnswer(value: unknown): AnswerSpec | string | undefined {
  if (value === undefined) return undefined
  if (!isEntry(value) || !ANSWERS.includes(value.type as AnswerType)) return `answer_type must be one of ${ANSWERS.join(', ')}.`
  const type = value.type as AnswerType
  if (type === 'confirm' || type === 'text') return { type }
  const given: unknown[] = Array.isArray(value.options) ? value.options : []
  const options = given.map(text)
  if (
    options.length < MIN_OPTIONS ||
    options.length > MAX_OPTIONS ||
    options.some(label => label === undefined || label.length > MAX_LABEL) ||
    new Set(options).size !== options.length
  ) {
    return `${type} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options: short labels of at most ${MAX_LABEL} characters, each different.`
  }
  const labels = options as string[]
  const wanted: unknown[] = Array.isArray(value.recommended) ? value.recommended : []
  const named = wanted.map(text).filter((label): label is string => label !== undefined && labels.includes(label))
  // A choice has one pick, the first Claude named; a multi keeps the options' order.
  const recommended = type === 'choice' ? named.slice(0, 1) : labels.filter(label => named.includes(label))

  return { type, options: labels, ...(recommended.length > 0 ? { recommended } : {}) }
}

// What the pane draws for an item, and what a press on it means.
type Format = {
  type: AnswerType | 'none'
  options: string[]
  recommended: string[]
  // The words on the confirm buttons; a confirm with no negative has one button.
  positive?: string
  negative?: string
  // A press on the positive button also marks the item done.
  isClosing: boolean
}

function formatOf(item: ActionItem): Format {
  const read = readAnswer(item.answer ?? undefined)
  // An answer a hand edit broke is passed over: the item falls back to what its kind gets.
  const spec = typeof read === 'object' ? read : undefined
  const plain = { options: [], recommended: [], isClosing: false }
  if (spec && spec.type !== 'confirm') {
    return { ...plain, type: spec.type, options: spec.options ?? [], recommended: spec.recommended ?? [] }
  }
  if (item.kind === 'sign-off') return { ...plain, type: 'confirm', positive: 'Approve', negative: 'Reject' }
  if (item.kind === 'review') return { ...plain, type: 'confirm', positive: 'Reviewed', isClosing: true }
  if (item.kind === 'blocked') return { ...plain, type: 'confirm', positive: 'Done', isClosing: true }
  if (spec || item.recommendation) return { ...plain, type: 'confirm', positive: 'Accept', negative: 'Reject' }

  return { ...plain, type: 'none' }
}

async function addItem($: EngineInterface, file: string, input: Record<string, unknown>): Promise<{ result: string; isError?: true }> {
  const id = text(input.id)
  const title = text(input.title)
  const kind = text(input.kind)
  if (!id || !title) return { result: 'An item needs an id and a title.', isError: true }
  if (!kind || !KINDS.includes(kind as Kind)) {
    return { result: `kind must be one of ${KINDS.join(', ')}.`, isError: true }
  }
  if (!SAFE_ID.test(id)) {
    return { result: 'id must be 1 to 64 letters, digits, dots, dashes or underscores, with no spaces.', isError: true }
  }
  if (input.answer_type === undefined && input.options !== undefined) {
    return { result: `Options need an answer_type: choice or multi.`, isError: true }
  }
  const answer =
    input.answer_type === undefined
      ? undefined
      : readAnswer({ type: input.answer_type, options: input.options, recommended: input.recommended })
  if (typeof answer === 'string') return { result: answer, isError: true }
  const fields = {
    kind: kind as Kind,
    title,
    ...(text(input.detail) ? { detail: text(input.detail) } : {}),
    ...(text(input.path) ? { path: text(input.path) } : {}),
    ...(text(input.recommendation) ? { recommendation: text(input.recommendation) } : {}),
    ...(answer ? { answer } : {}),
  }
  let isNew = false
  const changed = await change($, file, entries => {
    const at = entries.findIndex(one => isEntry(one) && one.id === id)
    isNew = at === -1
    if (isNew) {
      entries.push({ id, ...fields, since: today(), done: false })
    } else {
      const old = entries[at] as Entry
      const merged: Entry = { ...old, ...fields, done: false }
      // A new recommendation, or other options to pick from, is a new
      // question: the answer to the old one goes.
      const isAsking =
        (fields.recommendation !== undefined && fields.recommendation !== old.recommendation) ||
        (answer !== undefined && JSON.stringify(answer) !== JSON.stringify(readAnswer(old.answer ?? undefined)))
      if (isAsking) for (const key of ['response', 'selected', 'note', 'respondedAt']) delete merged[key]
      entries[at] = merged
    }

    return undefined
  })
  if ('error' in changed) return { result: changed.error, isError: true }
  await setUncaptured($, false)
  const open = changed.entries.filter(one => isEntry(one) && !one.done).length

  return { result: `${isNew ? 'Added' : 'Updated'} "${id}". ${plural(open, 'item is', 'items are')} open in ${changed.source}.` }
}

async function resolveItem($: EngineInterface, file: string, input: Record<string, unknown>): Promise<{ result: string; isError?: true }> {
  const id = text(input.id)
  if (!id) return { result: 'Give the id of the item to mark done.', isError: true }
  const changed = await change($, file, entries => {
    const item = entryOf(entries, id)
    if (!item) {
      const ids = entries.filter(isEntry).map(one => one.id).filter(Boolean)

      return `No item "${id}". The list holds: ${ids.join(', ') || 'nothing'}.`
    }
    item.done = true

    return undefined
  })
  if ('error' in changed) return { result: changed.error, isError: true }

  return { result: `Marked "${id}" done.` }
}

export const register: Register = (on, options) => {
  const file = typeof options.file === 'string' && options.file.trim() !== '' ? options.file.trim() : DEFAULT_FILE
  const isTelling = options.tellClaude !== false
  const isInstructing = options.instructClaude !== false
  const isAutoCapturing = options.autoCapture === true

  // The open items when the turn began, and whether this turn is the mod's own
  // capture request (which must never raise another). The request is marked
  // when it is sent, not recognised by its text, which a hook may rewrite.
  let before = new Set<string>()
  let isCapturePending = false
  let isCaptureTurn = false
  // The first read of the list, started when the session starts.
  let loaded: Promise<unknown> = Promise.resolve()

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
            recommendation: { type: 'string', description: 'What you recommend, in one sentence; the pane shows it above the buttons' },
            answer_type: {
              type: 'string',
              enum: ANSWERS,
              description:
                'The answer you need, which the pane draws a control for. confirm: yes or no. choice: one of options. multi: any number of options. text: they type it. Leave it out and the kind decides',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: `For choice and multi: ${MIN_OPTIONS} to ${MAX_OPTIONS} short labels, each different, at most ${MAX_LABEL} characters`,
            },
            recommended: { type: 'array', items: { type: 'string' }, description: 'The options you would pick, as written in options (one for choice)' },
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
    // The start waits for the first read, but not for long: a slow disk or a
    // slow git must not hold the session up. The pane and the timer wait for
    // the read itself.
    loaded = refresh($, file).catch(() => undefined)
    await Promise.race([
      loaded,
      new Promise<void>(done => {
        void $.clock.after(START_WAIT, () => done())
      }),
    ])
    $.clock.every(5000, async () => {
      await loaded
      await refresh($, file)
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  // The mod's two tools are answered here; every other tool call passes
  // straight through, and stays untouched if this hook ever fails.
  on('tool.call', ($, e, next) => {
    const tool = String(e.tool)
    if (tool === `mcp__attention-panel__${ADD_TOOL}`) return inTurn(() => addItem($, file, e as Record<string, unknown>))
    if (tool === `mcp__attention-panel__${RESOLVE_TOOL}`) {
      return inTurn(() => resolveItem($, file, e as Record<string, unknown>))
    }

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
      before = openIds(await rawList($, file))
      isCaptureTurn = isCapturePending
      isCapturePending = false
    }

    return next(e)
  })

  // The net under the instruction: an answer that asks the person for something
  // while the list stayed as it was is flagged in the pane, where one press
  // asks Claude to list it (or, with the option on, the mod asks by itself).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return done
    // Only a new open item answers an ask. Any other change in the turn (an
    // item resolved, a recommendation answered) leaves the ask unlisted.
    const after = openIds(await rawList($, file))
    const hasListed = [...after].some(id => !before.has(id))
    await refresh($, file)
    if (hasListed) {
      await setUncaptured($, false)
    } else if (!isCaptureTurn && ASKS.test(e.answer)) {
      await setUncaptured($, true)
      if (isAutoCapturing) {
        isCapturePending = true
        void $.prompt.submit({ text: captureRequest(file) })
      } else void $.ui.toast('Claude asked you for something that is not in the attention list.')
    }

    return done
  })

  on('command.run', { command: 'attention' }, async $ => {
    await refresh($, file)
    await $.ui.open({ id: PANE, title: TITLE })
    const state = await read($, board)
    const flagged = state.isUncaptured ? ' Claude asked you for something that is not listed.' : ''
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
    await loaded
    const state = await read($, board)
    const shown = ORDER.flatMap(group => state.items.filter(item => isOpen(item) && groupOf(item) === group))
    const done = state.items.filter(item => item.done).length
    // One number per open item, counted down the pane, so "item 3" names one thing.
    const numberOf = new Map(shown.map((item, index) => [item, index + 1]))
    // The number sits in a column of its own: wrapped lines of the title, detail
    // and path start under the text, never under the number.
    const gutter = String(shown.length).length + 2
    // Of items sharing an id only the first is drawn with buttons: a press names an id.
    const isFirst = (item: ActionItem): boolean => state.items.find(one => one.id === item.id) === item

    return (
      <Box flexDirection="column">
        {state.isUncaptured && (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="warning">Claude asked you for something that is not in this list.</Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="capture"
                label="Ask Claude to list it"
                onPress={() => {
                  void setUncaptured($, false)
                  isCapturePending = true
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
                    {item.recommendation && !item.response && isFirst(item) && (
                      <Box flexDirection="column">
                        <Text color="claude">Claude recommends: {item.recommendation}</Text>
                        <Box flexDirection="row" gap={1}>
                          <Button
                            key={`accept:${item.id}`}
                            label="Accept"
                            onPress={() => {
                              void inTurn(() => respond($, file, item.id, 'accepted', isTelling))
                            }}
                          />
                          <Button
                            key={`reject:${item.id}`}
                            label="Reject"
                            onPress={() => {
                              void inTurn(() => respond($, file, item.id, 'rejected', isTelling))
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
        {(state.duplicates ?? []).map(id => (
          <Text color="warning">More than one item has the id "{id}"; a press answers the first.</Text>
        ))}
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
