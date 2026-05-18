# Implementation Report - README Built-in Browser Docs

## Source

- Planner lane: `local`
- Planner marker: `(plan-local, human-confirmed)` in the current chat
- User confirmation: `confirm plan`
- Worktree: `.worktrees/implementer-readme-browser-docs-68527-94729-19041`
- Branch: `implementer/readme-browser-docs-68527-94729-19041`

## Work Queue

| Item | Status | Files |
|---|---|---|
| Document built-in browser functionality in English and Korean READMEs | completed | `README.md`, `README.ko.md` |

## Changes

- Added built-in browser mention to the opening summary in both READMEs.
- Added built-in browsing bullets to the "What's New" / "새로운 내용" section.
- Added dedicated browser feature sections covering the right-side drawer, tabs, address bar, navigation controls, local-file handling, state preservation, and session restore.
- Added `Cmd+Shift+B` to the terminal shortcuts tables.
- Added browser scheme filtering to the security section.

## Validation

- Reviewed `git diff -- README.md README.ko.md`.
- Verified key English/Korean headings and browser mentions with `rg`.
- No runtime test run was needed because this is a documentation-only change.

## Marker

Pending merge marker: `(impl-local, human-confirmed)`
