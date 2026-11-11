import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActionItem, Board } from '../types'

const PANE = 'attention'
const TITLE = 'Needs your attention'
const DEFAULT_FILE = '.claude/action-items.json'
const LABEL: Record<ActionItem['kind'], string> = {
  decision: 'Decide',
  'sign-off': 'Sign off',
  blocked: 'Blocked on you',
  review: 'Review',
}
const ORDER: ActionItem['kind'][] = ['blocked', 'decision', 'sign-off', 'review']
// Theme keys, so the headings follow the person's Claude Code theme.
const TINT: Record<ActionItem['kind'], 'error' | 'warning' | 'success' | 'suggestion'> = {
  blocked: 'error',
  decision: 'warning',
  'sign-off': 'success',
  review: 'suggestion',
}

const board = atom({ plugin: 'attention-panel', key: 'board' } as const, { items: [] } as Board, {
  shape: 'board-3',
})

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

async function refresh($: EngineInterface, file: string): Promise<void> {
  let next: Board
  let source = file
  try {
    source = file.startsWith('/') ? file : `${await projectRoot($)}/${file}`
    const text = String(await $.fs.read(source))
    try {
      const parsed: unknown = JSON.parse(text)
      if (!Array.isArray(parsed)) throw new Error('not an array')
      next = { items: parsed as ActionItem[], source, readAt: new Date().toISOString() }
    } catch {
      next = { items: [], source, error: 'invalid' }
    }
  } catch {
    next = { items: [], source, error: 'missing' }
  }
  const now = await read($, board)
  if (JSON.stringify(now.items) !== JSON.stringify(next.items) || now.error !== next.error || now.source !== next.source) {
    await update($, board, () => next)
  }
}

export const register: Register = (on, options) => {
  const file = typeof options.file === 'string' && options.file.trim() !== '' ? options.file.trim() : DEFAULT_FILE

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'attention',
      description: 'Show the action items in this project that need your attention',
    })
    await refresh($, file)
    $.clock.every(5000, () => refresh($, file))
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'attention' }, async $ => {
    await refresh($, file)
    await $.ui.open({ id: PANE, title: TITLE })
    const state = await read($, board)
    if (state.error === 'invalid') return { text: `Attention pane opened, but the list is not a valid JSON array: ${state.source}` }
    if (state.error) return { text: `Attention pane opened. No action list yet; expected at ${state.source}` }
    const open = state.items.filter(item => !item.done).length

    return { text: `Attention pane opened: ${open} open item${open === 1 ? '' : 's'} from ${state.source}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, board)
    const shown = ORDER.flatMap(kind => state.items.filter(item => !item.done && item.kind === kind))
    const done = state.items.filter(item => item.done).length
    // One number per open item, counted down the pane, so "item 3" names one thing.
    const numberOf = new Map(shown.map((item, index) => [item, index + 1]))
    // The number sits in a column of its own: wrapped lines of the title, detail
    // and path start under the text, never under the number.
    const gutter = String(shown.length).length + 2

    return (
      <Box flexDirection="column">
        {state.error === 'invalid' && (
          <Box flexDirection="column">
            <Text>The action list is not a valid JSON array.</Text>
            <Text dimColor>{state.source}</Text>
          </Box>
        )}
        {state.error === 'missing' && (
          <Box flexDirection="column">
            <Text dimColor>No action list for this project yet.</Text>
            <Text dimColor>Expected at: {state.source}</Text>
          </Box>
        )}
        {!state.error && shown.length === 0 && <Text dimColor>Nothing is waiting on you.</Text>}
        {ORDER.map(kind => {
          const group = shown.filter(item => item.kind === kind)
          if (group.length === 0) return null

          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color={TINT[kind]}>
                {LABEL[kind]} ({group.length})
              </Text>
              {group.map(item => (
                <Box flexDirection="row">
                  <Box width={gutter} flexShrink={0}>
                    <Text color={TINT[kind]}>{numberOf.get(item)}.</Text>
                  </Box>
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text>{item.title}</Text>
                    {item.detail && <Text dimColor>{item.detail}</Text>}
                    {item.path && <Text dimColor>{item.path}</Text>}
                  </Box>
                </Box>
              ))}
            </Box>
          )
        })}
        {done > 0 && <Text dimColor>{done} done</Text>}
      </Box>
    )
  })
}
