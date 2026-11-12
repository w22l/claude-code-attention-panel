# Changelog

## 0.4.0

The list now keeps itself, in every project, without a line in `CLAUDE.md`.

- Claude is told about the list in its system prompt: add an item in the same turn in which it asks you for something.
- Two tools for Claude, `attention_add` and `attention_resolve`. They create the list when it does not exist, change one entry and keep the rest, and refuse to rewrite a file that is not valid JSON.
- A missed ask is flagged: when an answer asks you for something and the list did not change in that turn, the pane shows a line with **Ask Claude to list it** and **Dismiss**.
- The status line shows how many items are open; a new item raises a toast once.
- Nothing vanishes: an item with an unknown `kind` is shown under **Other**; entries without an `id` or `title` are counted on a line of their own; a file that stops parsing leaves the last good list on screen, marked as stale.
- A missing list is no longer worded as a problem: the pane says nothing is waiting and where the list will be created.
- New options: Tell Claude to keep the list (on), Ask Claude automatically when an ask is missed (off).
- Thirteen new tests.

## 0.3.0

- Recommendations: an item may carry a `recommendation`. The pane shows it with Accept and Reject buttons.
- Pressing a button writes `response` and `respondedAt` onto the item in the list file and, unless turned off, sends Claude a short prompt naming the item and the answer.
- New option: Tell Claude when you answer.
- Tests for accepting, rejecting and a missing list, run on the terminal and desktop surfaces.

## 0.2.2

- Section headings are coloured by kind, using Claude Code theme colours so they follow your theme.
- Open items are numbered down the pane instead of bulleted.
- Wrapped lines of a title, detail or path now align under the text, not under the number.

## 0.2.1

- The pane and `/attention` now distinguish a missing list from one that is not a valid JSON array.
- Added a licence file, a disclaimer, a step-by-step guide and diagrams.
- Manifest: author, repository and keywords.

## 0.2.0

- Reads the list from the current project (`.claude/action-items.json` by default) instead of a fixed path.
- In a git worktree, reads the list from the main checkout.
- New option: the path of the action items file.

## 0.1.0

- First version: a pane listing open action items, and the `/attention` command.
