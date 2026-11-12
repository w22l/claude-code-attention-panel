export type ActionItem = {
  id: string
  // One of the four known kinds. A list written by hand may hold another word:
  // such an item is still shown, under "Other".
  kind: 'decision' | 'sign-off' | 'blocked' | 'review'
  title: string
  detail?: string
  path?: string
  since?: string
  done?: boolean
  recommendation?: string
  response?: 'accepted' | 'rejected'
  respondedAt?: string
}

export type Board = {
  items: ActionItem[]
  source?: string
  error?: 'missing' | 'invalid'
  readAt?: string
  // Entries of the file that are not items (no id or no title): counted, never dropped silently.
  skipped?: number
  // The file is not valid JSON right now and `items` is the last list that could be read.
  isStale?: boolean
  // Claude's last answer asked the person for something and the list did not change in that turn.
  isUncaptured?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'attention-panel': { board: Shaped<Board> }
  }
}
