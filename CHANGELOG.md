# Changelog

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
