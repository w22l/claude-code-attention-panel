# Answer Formats (0.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each action item declare the answer it needs (confirm, choice, multi, text) and let the person give it in the pane, and harden the mod's file handling and start-up.

**Architecture:** Everything stays in the one hooks module, `hooks/register.tsx`. All writers of the list file go through one `change()` helper under the existing `inTurn` queue. A pure `formatOf(item)` decides what the pane draws; a second session atom holds unsent drafts (ticks, open reply field).

**Tech Stack:** TypeScript/TSX hooks module for Claude Code mods (API as of 2.1.311), `claude-code/testing`.

**Spec:** `docs/superpowers/specs/2026-11-20-answer-formats-design.md` — read it first; this plan does not repeat its tables.

## Global Constraints

- One hooks module: `hooks/register.tsx`; contract in `types/index.d.ts`. No new runtime files.
- A prompt the mod submits never contains text from the list file: only fixed words, the file path, a safe id, and `accepted`/`rejected`. Chosen labels and typed notes are never in a prompt.
- Unknown fields and non-item entries in the list file are written back untouched.
- Items valid in 0.4.0 behave as in 0.4.0. An item with a `recommendation` keeps the button keys `accept:<id>` and `reject:<id>`. Confirm buttons on an item without one use `yes:<id>` and `no:<id>` (an existing test asserts `accept:notes` is absent on such an item).
- Existing tests in `tests/capture.test.tsx` and `tests/recommendation.test.tsx` pass with no change to their assertions.
- Options: 2 to 8 labels, each trimmed, non-empty, at most 60 characters, unique.
- Item ids accepted by `attention_add`: `^[A-Za-z0-9._-]{1,64}$`.
- `Input` and `Select` do not exist on the `mobile` surface: resolve them defensively (`const { Input } = $.ui.resolve(e) as { Input?: ... }`).
- Match the file's existing style: short comments that say why, `isX` booleans, no semicolons.
- Commands: `claude plugin validate .` and `claude plugin test .` from the repo root; both must be clean at the end of every task.
- Work on a branch `answer-formats`, not `main`. Commit at the end of each task.

## Review Focus

Each line names its owning task; the test is listed in that task.

1. A hand-edited `answer` that is malformed (`options` not an array, one option, a number as a label, `type: "rank"`): the item still shows, with its default format. (Task 2)
2. The question changes between drawing and pressing (options edited, item resolved, item answered elsewhere): nothing is written, a toast says so. (Task 3)
3. Option labels that are long, contain `[`/`]`, or are near-duplicates differing by case or whitespace: drawn and matched by exact label, never by position. (Task 4)
4. A reply that is only whitespace, or very long (10,000 characters), or multi-line: whitespace is ignored; the rest is stored whole as `note`, and never reaches a prompt. (Task 5)
5. The list file is read-only or disappears mid-press: a toast or tool error, the pane keeps its last list, no exception escapes a hook. (Task 1)

---

### Task 1: One write path, cached root, quiet poll

**Files:**
- Modify: `hooks/register.tsx` (`projectRoot`, `sourceOf`, `refresh`, `respond`, `loadForWrite`, `addItem`, `resolveItem`, `session.start`, the pane's warnings)
- Modify: `types/index.d.ts` (`Board.duplicates?: string[]`)
- Test: `tests/hardening.test.tsx` (new; copy the mock preamble from `tests/recommendation.test.tsx`)

**Interfaces:**
- Produces:
  - `type Entry = Record<string, unknown>`; `const isEntry = (one: unknown): one is Entry`
  - `async function change($, file, edit: (entries: unknown[]) => string | undefined): Promise<{ source: string; entries: unknown[] } | { error: string }>` — loads the array (missing file = `[]`), runs `edit` (a returned string aborts with that message, nothing written), writes, then `refresh`. Invalid JSON and a failed write both come back as `{ error }`, never a throw. Callers wrap it in `inTurn`.
  - `projectRoot($)` resolves once per `register` call and is reused (memoised promise inside `register`, passed down or closed over).
  - `Board.duplicates`: ids that occur more than once among shown items.

- [ ] **Step 1: Write failing tests in `tests/hardening.test.tsx`**
  - `git is asked for the project root once`: count `process.run` calls; after `session.start`, three `$.command.run(ATTENTION)` and `mock.clock` advanced 15 s, count is `1`.
  - `an unchanged file is not re-announced`: count `ui.status` calls; advancing the clock 15 s over an unchanged file adds `0` calls.
  - `a failed write is reported, not thrown`: `fs.write` throws; `ui.press({ key: 'accept:region' })` resolves, a toast matching `/could not be updated/` was raised, and calling the `attention_add` tool returns `isError: true` with a result naming the file path.
  - `a non-object entry does not break an answer`: list `[42, null, { id: 'region', ... recommendation }]`; pressing `accept:region` writes `response: 'accepted'` and the saved array still starts `[42, null, ...]`.
  - `duplicate ids are flagged`: two items with id `region`; a `Text` matching `/more than one item has the id "region"/i` is drawn; a press changes only the first.
  - `the file vanishing mid-press does not throw`: `fs.read` throws on the second read; the press resolves and a toast is raised.
- [ ] **Step 2: Run `claude plugin test .`** — expected: the six new tests fail, the existing ones pass.
- [ ] **Step 3: Implement** `isEntry`, `change`, the memoised root, and the raw-text short-circuit in `refresh` (keep `lastText`/`lastSource` in module scope beside `known`; reset when the source changes). Rewrite `respond`, `addItem`, `resolveItem` on top of `change`; delete `loadForWrite`. In `session.start`, register the command and tools first, then start the first `refresh` without awaiting it before `next(e)`; the `ui.render` hook awaits that first load (keep its promise) so a mount straight after start still draws the list.
- [ ] **Step 4: Run `claude plugin test .` and `claude plugin validate .`** — expected: all pass, validate clean.
- [ ] **Step 5: Time-boxed look at `CONNECT_TIMEOUT`** (30 minutes): run `claude --debug --plugin-dir .` in this repo, grep the debug log for `attention-panel`. Record what was found in a `## Notes` section at the bottom of this plan. If the cause is in the mod, fix it with a test; otherwise leave it for the Troubleshooting row in Task 6.
- [ ] **Step 6: Commit** — `fix: one write path, cached project root, quiet poll`

### Task 2: The `answer` field and `attention_add`

**Files:**
- Modify: `types/index.d.ts`, `hooks/register.tsx` (`addItem`, the tool schema, `instruction`)
- Test: `tests/answers.test.tsx` (new)

**Interfaces:**
- Produces, in `types/index.d.ts`:
  ```ts
  export type AnswerType = 'confirm' | 'choice' | 'multi' | 'text'
  export type AnswerSpec = { type: AnswerType; options?: string[]; recommended?: string[] }
  // on ActionItem:
  answer?: AnswerSpec
  response?: 'accepted' | 'rejected' | 'answered'
  selected?: string[]
  note?: string
  ```
- Produces, in `register.tsx`:
  - `function readAnswer(value: unknown): AnswerSpec | string | undefined` — `undefined` when absent; a string saying what to fix when it breaks the option rules; otherwise the cleaned spec (labels trimmed, `recommended` filtered to labels in `options`, cut to one for `choice`, `options` dropped for `confirm`/`text`).
  - `type Format = { type: AnswerType | 'none'; options: string[]; recommended: string[]; positive?: string; negative?: string; isClosing: boolean }`
  - `function formatOf(item: ActionItem): Format` — the item's valid `answer`, else the spec's default table. For `confirm` (explicit or default): `sign-off` → `Approve`/`Reject`; `review` → `Reviewed`, no negative, `isClosing`; `blocked` → `Done`, no negative, `isClosing`; otherwise `Accept`/`Reject`. A default `confirm` exists only when the item has a `recommendation` or its kind is `sign-off`, `review` or `blocked`; otherwise `none`.
  - Tool inputs `answer_type` (enum of the four), `options` (array of strings), `recommended` (array of strings).

- [ ] **Step 1: Write failing tests**
  - `attention_add stores an answer`: call with `answer_type: 'multi'`, `options: [' Lint ', 'Unit tests', 'Type check']`, `recommended: ['Lint', 'Nope']`; saved item has `answer` equal to `{ type: 'multi', options: ['Lint', 'Unit tests', 'Type check'], recommended: ['Lint'] }`.
  - `attention_add refuses bad options`: one option; nine options; a 61-character label; duplicates; `choice` with no options — each returns `isError: true` and writes nothing.
  - `attention_add refuses an id it could not name`: id `"bad id!"` → `isError: true`, message contains `letters, digits`.
  - `a changed answer clears the old response`: item with `response: 'answered'`, `selected: ['A']`; re-add with different `options`; saved item has no `response`, `selected`, `note`, `respondedAt`.
  - `a malformed answer falls back` (Review Focus 1): for each of `{ type: 'rank' }`, `{ type: 'choice', options: 'A' }`, `{ type: 'multi', options: ['A'] }`, `{ type: 'choice', options: [1, 2] }` on a `sign-off` item, the pane still draws the title and a button with key `yes:<id>` labelled `Approve`.
  - `the system prompt names the formats`: the composed section text contains `confirm`, `choice`, `multi`, `text`, `selected` and `note`.
- [ ] **Step 2: Run tests** — expected: new ones fail.
- [ ] **Step 3: Implement** the types, `readAnswer`, `formatOf`, the tool schema and `addItem` changes, and extend `instruction` and the tool description per the spec's "What Claude is told". Bump the board atom's `shape` to `'board-6'`.
- [ ] **Step 4: Run tests and validate** — expected: all pass.
- [ ] **Step 5: Commit** — `feat: items declare the answer they need`

### Task 3: Answering, and confirm buttons by kind

**Files:**
- Modify: `hooks/register.tsx` (replace `respond`; the item's control block in `ui.render`)
- Test: `tests/answers.test.tsx`

**Interfaces:**
- Consumes: `change`, `formatOf`, `Format`.
- Produces:
  - `type Reply = { response: 'accepted' | 'rejected' } | { selected: string[] } | { note: string }`
  - `async function answer($, file, id: string, reply: Reply, isTelling: boolean): Promise<void>` — via `change`: finds the first entry with that id; refuses (toast `That item is no longer waiting for an answer.`) when missing, done or already answered; for `selected`, refuses (toast `The question changed; look again.`) unless every label is in the item's current `formatOf(...).options`, and unless exactly one for `choice`; writes `response` (`answered` for `selected`/`note`), `selected` or `note`, `respondedAt`; sets `done: true` when the format `isClosing` and the reply is `accepted`. Then, when `isTelling`, submits the prompt.
  - Prompt text: confirm keeps today's sentence (`... I accepted your recommendation for action item "<id>" ...`); every other reply sends `In the attention panel I answered action item "<id>". Read the item in <file> and act on that answer, then update the list.`
  - `async function reopen($, file, id): Promise<void>` — clears `response`, `selected`, `note`, `respondedAt`; no prompt.
  - Button keys: `accept:<id>` / `reject:<id>` when the item has a `recommendation`, otherwise `yes:<id>` / `no:<id>`; `change:<id>`.

- [ ] **Step 1: Write failing tests**
  - `a sign-off without a recommendation can be approved`: buttons `yes:notes` labelled `Approve` and `no:notes` labelled `Reject`; pressing writes `accepted`; item stays `done: false`.
  - `Done on a blocked item closes it`: one button `yes:key` labelled `Done`, no `no:key`; pressing writes `response: 'accepted'` and `done: true`; one prompt sent, containing `"key"`.
  - `Reviewed closes a review item`: same shape.
  - `an answer to a changed question is refused` (Review Focus 2): mount, then replace the file so the item is `done: true`; press → file unchanged, toast raised, no prompt.
  - `Change brings the buttons back`: after accepting, `change:region` exists; pressing clears `response`; `accept:region` is drawn again; no prompt was sent for the press.
  - `tellClaude off sends nothing`: register with `{ tellClaude: false }`; press; zero prompts.
- [ ] **Step 2: Run tests** — expected: new ones fail.
- [ ] **Step 3: Implement** `answer`, `reopen`, and draw confirm from `formatOf`. The answered line: `You accepted: <recommendation>` / `You rejected: <recommendation>` when there is a recommendation (unchanged text), else `You answered: <positive or negative label>`.
- [ ] **Step 4: Run tests and validate** — expected: all pass, including `tests/recommendation.test.tsx` untouched.
- [ ] **Step 5: Commit** — `feat: confirm buttons for every kind; Change`

### Task 4: Choice and multi

**Files:**
- Modify: `types/index.d.ts` (drafts contract), `hooks/register.tsx`
- Test: `tests/answers.test.tsx`

**Interfaces:**
- Consumes: `answer`, `formatOf`.
- Produces:
  - `export type Draft = { picked?: string[]; isReplying?: boolean }`; `export type Drafts = Record<string, Draft>`; `PluginState['attention-panel'].drafts: Shaped<Drafts>`
  - `const drafts = atom({ plugin: 'attention-panel', key: 'drafts' } as const, {} as Drafts, { shape: 'drafts-1' })`
  - `function pickedOf(item: ActionItem, format: Format, all: Drafts): string[]` — the draft's ticks that are still options, else `format.recommended`.
  - `refresh` drops drafts whose item is gone, done or answered.
  - Button keys: `pick:<id>:<index>` (choice and multi; the index addresses the button, the **label** is what is stored and checked), `submit:<id>`.

- [ ] **Step 1: Write failing tests** (each on `terminal` and `desktop`)
  - `a choice is answered with one press`: three options, `recommended: ['Tokyo']`; the first button's text contains `Tokyo (recommended)`; pressing `pick:region:1` writes `response: 'answered'`, `selected: ['Singapore']`; the prompt contains `"region"` and none of the labels; the pane shows `You chose: Singapore`.
  - `several options are ticked and submitted`: recommended ones start as `[x]`; `submit:checks` reads `Submit 2 selected`; pressing `pick:checks:1` makes it `Submit 3 selected`; unticking all removes `submit:checks`; submitting writes `selected` in option order.
  - `ticks survive a refresh but not a changed question`: tick, advance the clock 5 s over the same file → still ticked; rewrite the item's options → ticks for removed labels are gone.
  - `awkward labels` (Review Focus 3): options `['[beta]', 'Beta', 'beta ']` written by hand in the file; pressing `pick:<id>:2` stores exactly `['beta']` (trimmed, matched by exact label, case kept); a 60-character label is drawn whole.
- [ ] **Step 2: Run tests** — expected: new ones fail.
- [ ] **Step 3: Implement** the drafts atom and the two controls. Lay the option buttons out with `flexWrap="wrap"` if `BoxProps` has it (grep the types), else one per row. The recommended choice button is `variant="primary"`.
- [ ] **Step 4: Run tests and validate** — expected: all pass.
- [ ] **Step 5: Commit** — `feat: choice and multi answers`

### Task 5: Text, Reply…, mobile, age

**Files:**
- Modify: `hooks/register.tsx`
- Test: `tests/answers.test.tsx`

**Interfaces:**
- Consumes: `answer`, `drafts`, `Draft.isReplying`.
- Produces:
  - Element keys: `text:<id>` (the Input of a `text` item), `reply:<id>` (the Reply… button), `note:<id>` (the Input it reveals), `cancel:<id>`.
  - `function ageOf(since: string | undefined, now: Date): string | undefined` — `today`, `<n>d` under 14 days, `<n>w` after; `undefined` when `since` does not parse or is in the future.

- [ ] **Step 1: Write failing tests**
  - `a text item is answered by typing`: `ui.input({ key: 'text:url', text: 'https://api.example.com' })` writes `response: 'answered'`, `note: 'https://api.example.com'`; the prompt does not contain `example.com`; the pane shows `You replied: https://api.example.com`.
  - `Reply… answers any item`: on a `choice` item, `note:region` is absent until `reply:region` is pressed; submitting `Neither, use Sydney` writes `note` and no `selected`; `cancel:region` hides the field and writes nothing.
  - `empty and odd replies` (Review Focus 4): `'   '` writes nothing and raises no prompt; a 10,000-character and a three-line reply are stored whole.
  - `mobile has no fields`: on surface `mobile`, a `text` item shows `Answer this one in the chat.`, no `reply:<id>` button is drawn anywhere, and confirm/choice/multi buttons still work.
  - `age is shown`: with the clock at 2026-11-20, `since: '2026-11-18'` → `2d`; `'2026-11-20'` → `today`; `'2026-10-30'` → `3w`; `'soon'` → no age text.
- [ ] **Step 2: Run tests** — expected: new ones fail.
- [ ] **Step 3: Implement.** Draw the age dim at the end of the title row. Use `$.clock`'s notion of now if the testing clock exposes one (grep `clock` in the types), else `new Date()`.
- [ ] **Step 4: Run tests and validate** — expected: all pass.
- [ ] **Step 5: Commit** — `feat: typed answers, Reply…, item age`

### Task 6: Docs and release

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json` (`"version": "0.5.0"`), `.claude-plugin/marketplace.json` if it carries a version, optionally `docs/pane.svg`

- [ ] **Step 1: README.** Intro paragraph; step 6 retitled "Answer in the pane" with the four formats, Reply… and Change, using the spec's sketch; File format table gains `answer`, `selected`, `note`, and `response` gains `answered`; the default-buttons table; "What the mod touches" (what a press writes; what the prompt contains — still never file text; git run once per session); Troubleshooting rows: `The question changed; look again.`, a `text` item on mobile, duplicate ids, and the tool-server timeout with whatever Task 1 Step 5 found; the stale "Claude Code 2.1.311" line stays unless tested on a newer build.
- [ ] **Step 2: CHANGELOG** `## 0.5.0` in the existing voice: answer formats first, then hardening, then the test count.
- [ ] **Step 3: Full check.** `claude plugin validate . && claude plugin test .` — expected: clean, every test passing. `git diff main --stat` touches only the files this plan names.
- [ ] **Step 4: Commit** — `0.5.0: answers that fit the question`

## Notes

(Task 1 Step 5 findings go here.)
