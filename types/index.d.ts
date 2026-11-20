// The answer an item asks for. The pane draws a control for it: two buttons, one
// button per option, a tick per option, or a field to type in.
export type AnswerType = 'confirm' | 'choice' | 'multi' | 'text'

export type AnswerSpec = {
  type: AnswerType
  // For choice and multi: two to eight labels, each different.
  options?: string[]
  // Labels from `options` that Claude would pick (one for choice).
  recommended?: string[]
}

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
  answer?: AnswerSpec
  // Written by the mod when the person answers in the pane. `answered` goes
  // with `selected` (the options picked) or `note` (what was typed).
  response?: 'accepted' | 'rejected' | 'answered'
  selected?: string[]
  note?: string
  respondedAt?: string
}

export type Board = {
  items: ActionItem[]
  source?: string
  error?: 'missing' | 'invalid'
  readAt?: string
  // Entries of the file that are not items (no id or no title): counted, never dropped silently.
  skipped?: number
  // Ids that more than one item carries: a press can only mean the first of them.
  duplicates?: string[]
  // The file is not valid JSON right now and `items` is the last list that could be read.
  isStale?: boolean
  // An answer of Claude's asked the person for something and no item was added in that turn.
  // Stays until an item is added, the person asks Claude to list it, or dismisses it.
  isUncaptured?: boolean
}

// What the person has begun on an item and not sent: the options ticked on a
// multi, and whether the field for a typed reply is open. Kept for the session,
// never written to the list file.
export type Draft = {
  // Absent until a tick is changed: the recommended options then count as ticked.
  picked?: string[]
  isReplying?: boolean
}

// By item id.
export type Drafts = Record<string, Draft>

declare module 'claude-code' {
  interface PluginState {
    'attention-panel': { board: Shaped<Board>; drafts: Shaped<Drafts> }
  }
}
