# Answer formats for the attention pane (0.5.0)

Date: 2026-11-20. Status: approved by the owner, 2026-11-20.

## Intent

The pane lists what Claude is waiting on the person for, but the person can only
answer one shape of question: Accept or Reject of a single `recommendation`.
Real questions come in other shapes: pick one of several, pick several at once,
type a value, or simply confirm. The owner wants the answer format to fit the
question, so most asks can be answered in the pane, without retyping in the chat.

Alongside that, a hardening and polish pass on what is already there.

## Goals

- Claude declares, per item, what kind of answer it needs; the pane draws the
  matching control.
- Four formats: `confirm`, `choice` (pick one), `multi` (pick several), `text`.
- No dead ends: every open item can also be answered with a typed reply.
- Items written for 0.4.0 (with or without `recommendation`) keep working unchanged.
- The mod's existing safety rule holds: a prompt the mod submits never carries
  text from the list file.
- The stability problems listed under "Hardening" are fixed, each with a test.

## Non-goals

- Ranking, numeric sliders, date pickers, file pickers, nested questions.
- Editing an item's title or detail from the pane.
- Multiple lists, filtering, search.
- Changing the missed-ask detection (`ASKS`) or the capture flow.

## Anti-goals

- The pane becoming a form builder: one question per item, one control per question.
- Any path by which option labels, titles or other file text are submitted to
  Claude as if the person typed them.
- Breaking a hand-edited list: unknown fields are still written back untouched.

## Constraints

- Mod API as of Claude Code 2.1.311. Elements: `Box`, `Text`, `Button`, `Link`
  everywhere; `Input` and `Select` on terminal, desktop and vscode; **not** on mobile.
- The whole mod stays one hooks module, `hooks/register.tsx`, plus `types/index.d.ts`.
- `$.fs` has read and write only (no rename, no stat).
- Tests run with `claude plugin test`, in the style of `tests/*.test.tsx`.

## Approaches considered

- **A. Claude declares the answer format per item (chosen by the owner).** One
  control per format; one-click multi-select; a typed reply as escape hatch.
  Most to build; relies on Claude choosing a format, mitigated by defaults.
- **B. A text field on every item, plus today's buttons.** Least code, but every
  answer is typed; no one-click multi-select.
- **C. An "Answer…" button that opens the engine's built-in question dialog.**
  Reuses native UI, but capped at 2–4 options, leaves the pane, no free text.

## Design

### The item

New optional field on an item, written by `attention_add` or by hand:

```json
"answer": {
  "type": "multi",
  "options": ["Lint", "Unit tests", "Type check", "E2E"],
  "recommended": ["Lint", "Type check"]
}
```

- `type`: `confirm` | `choice` | `multi` | `text`.
- `options`: required for `choice` and `multi`; 2 to 8 labels, each trimmed,
  non-empty, at most 60 characters, unique. Ignored for the other types.
- `recommended`: optional; labels from `options` (one for `choice`). Labels not
  in `options` are dropped.
- `recommendation` (existing, a sentence) stays, and is shown above the control
  for any type.

An `answer` that fails these rules is not an error in the pane: the item falls
back to its default format (below) and still shows. `attention_add` rejects it
with a message saying what to fix.

`attention_add` gains flat inputs `answer_type`, `options`, `recommended` and
stores them as the nested `answer`. It also now requires `id` to match
`^[A-Za-z0-9._-]{1,64}$`, so every item can be named in a prompt. Re-adding an
item with a changed `answer` or `recommendation` clears the previous response,
as a changed recommendation does today.

### Default format when `answer` is absent

| Item | Format | Buttons |
|---|---|---|
| has `recommendation` | confirm | Accept / Reject (as 0.4.0, same button keys) |
| `sign-off` | confirm | Approve / Reject |
| `review` | confirm, one button | Reviewed |
| `blocked` | confirm, one button | Done |
| `decision` without recommendation, or unknown kind | none | only Reply… |

An explicit `answer.type: "confirm"` takes its buttons from the item's kind in
the same way: `sign-off` Approve / Reject, `review` a lone Reviewed, `blocked` a
lone Done, anything else Accept / Reject. *(Designer's call.)*

The lone **Done** and **Reviewed** buttons record `response: accepted` **and set
`done: true`**: the person has done the thing, and there is nothing left for
Claude to decide. Claude is still told (the same fixed prompt), so blocked work
resumes. Every other answer leaves the item open, showing the answered line,
until Claude resolves it, as in 0.4.0. *(Designer's call.)*

### What the pane draws

```
Decide (2)
1. Which checks should block a merge?                      2d
   [x] Lint   [ ] Unit tests   [x] Type check   [ ] E2E
   [ Submit 2 selected ]  [ Reply… ]

2. Choose the hosting region
   Claude recommends: Tokyo is nearest to most users.
   [ Tokyo (recommended) ]  [ Singapore ]  [ Frankfurt ]  [ Reply… ]

Blocked on you (1)
3. What should the API base URL be?
   > https://…                                   (enter to send)

Sign off (1)
4. Approve the release notes
   [ Approve ]  [ Reject ]  [ Reply… ]
```

- `choice`: one button per option; a press answers at once. The recommended
  option is the primary button and carries "(recommended)".
- `multi`: one toggle button per option, drawn `[x] label` / `[ ] label`;
  recommended options start ticked. `Submit N selected` answers; it is not drawn
  while nothing is ticked.
- `text`: an `Input` in place, Enter sends. An empty submit is ignored.
- `confirm`: positive and negative button; a press answers at once.
- **Reply…** on every unanswered item except `text` ones: reveals an `Input`
  under the item (and a Cancel). Sending it answers the item with the typed note.
- On mobile (no `Input`): Reply… is not drawn, and a `text` item shows
  "Answer this one in the chat."
- An answered item shows one dim line (`You chose: Lint, Type check`,
  `You replied: …`, `You accepted: …`) and a **Change** button, which clears the
  answer so the controls return. Change submits no prompt.
- Each open item shows its age from `since` (`today`, `2d`, `3w`), dim, when
  `since` parses as a date.
- Item order stays the file's order within each group; group order as today.

Ticks and "which item has its reply field open" are session state in a second
atom (keyed by item id), not written to the list file. Drafts for items that are
gone, answered, or whose options changed are discarded on refresh.

### What is written

On an answer, the mod re-reads the file, and writes onto the one item:

| Field | Value |
|---|---|
| `response` | `accepted` / `rejected` for confirm (unchanged); `answered` for choice, multi, text and Reply |
| `selected` | array of chosen labels (choice: one; multi: one or more). Absent otherwise |
| `note` | the typed text (text format, or Reply). Absent otherwise |
| `respondedAt` | ISO timestamp (unchanged) |

Before writing it checks the item is still open and unanswered, and for choice
and multi that every chosen label is still in the item's current `options`. If
not, nothing is written and a toast says the question changed; the pane refreshes.

### What Claude is told

Unchanged in kind: with *Tell Claude when you answer* on, one fixed-text prompt
naming the item id and the file, e.g. `In the attention panel I answered action
item "merge-checks". Read the item in <file> and act on that answer, then update
the list.` For confirm the word `accepted` / `rejected` stays in the prompt as
today. Chosen labels and the typed note are **not** in the prompt; Claude reads
them from the file. (The note is the person's own words, but one rule for every
format is simpler to reason about and to test.)

The system-prompt section and the `attention_add` description are extended to
say: choose the answer format that fits the question; give options for choice
and multi; an item with a `response` is answered — read `selected` and `note`,
act, then resolve it.

### Hardening

1. **git is run on every read.** `sourceOf` spawns `git rev-parse` each call:
   every 5 seconds and several times a turn. Resolve the project root once per
   session (per `register`), and reuse it.
2. **Session start blocks on the first read.** `session.start` awaits the file
   read (and git) before `next(e)`. In the session that produced this design the
   mod's tool server failed with `CONNECT_TIMEOUT` after 30 s, twice (main session
   and a subagent); the repository is on an external volume. Cause not yet
   established. Investigation is time-boxed: try to reproduce and find the cause;
   if it is in the mod, fix it; if it is not found or lies in the engine, ship
   the minimum (the first refresh no longer holds up `session.start`, and runs
   after the tools are registered), note it in Troubleshooting, and do not block
   0.5.0 on it. *(Designer's call.)*
3. **The poll rewrites state it does not need to.** Keep the last raw text; when
   the file's text is unchanged, skip parse, compare and announce.
4. **`respond` has its own, weaker file handling** than the two tools. One shared
   load/validate/write path for every writer; entries that are not objects are
   never dereferenced.
5. **Duplicate ids** in a hand-edited file make buttons ambiguous. The pane acts
   on the first and shows a one-line warning naming the id.
6. **A write that fails** (read-only file) inside a tool call returns a clear
   tool error rather than the generic catch.

### Housekeeping

- `types/index.d.ts`: the new fields; state `shape` bumped; a contract entry for
  the drafts atom.
- README: step 6 rewritten around answer formats; File format table; What the
  mod touches; Troubleshooting rows. CHANGELOG entry; version 0.5.0 in
  `plugin.json`.
- Tests: a new `tests/answers.test.tsx` covering each format on terminal and
  desktop, the mobile fallback, the changed-question refusal, Change, 0.4.0
  items, invalid `answer` fallback, and each hardening item. Existing tests stay
  green without edits to their assertions.

## Left to the builder

- Exact button keys for new controls (existing `accept:<id>` / `reject:<id>` stay).
- Whether `path` is drawn with `Link` or stays text.
- Wording of toasts and of the dim answered line.
- Whether `docs/pane.svg` is redrawn to show the new controls.
- How age is rounded.
