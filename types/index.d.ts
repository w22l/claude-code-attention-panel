export type ActionItem = {
  id: string
  kind: 'decision' | 'sign-off' | 'blocked' | 'review'
  title: string
  detail?: string
  path?: string
  since?: string
  done?: boolean
}

export type Board = { items: ActionItem[]; source?: string; error?: 'missing' | 'invalid'; readAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'attention-panel': { board: Shaped<Board> }
  }
}
