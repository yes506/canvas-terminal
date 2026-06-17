# Collaborator agent protocol

The collaborator pane spawns one or more AI CLIs (Claude Code, Codex,
Gemini, …) as PTY-backed mini-terminals. Each agent receives a task
protocol prompt injected by the harness on first message of every
collaborator session. This document explains the rules the harness
injects and the conventions that depend on them.

The canonical source for the injected prompt is
`src/stores/collaboratorStore.ts::TASK_PROTOCOL`. **If you edit the
rules in that template literal, update this document in the same
commit.** A drift between the two is a documentation bug.

## Shared memory layout

Per collaborator session, the harness creates a directory under
`~/.cache/canvas-terminal/collab-memory/session-<id>/` containing:

- `conversation-*.md` — append-only conversation log. Agents read for
  context; the harness writes task-status updates automatically. Agents
  must not write here directly.
- `tasks-*.md` — current task definitions. Read-only for agents.
- `context.md` — optional shared context written by the user via
  `/context <text>` from the collaborator command line.
- `contexts/<collab-session-id>/<agent>.jsonl` — per-agent transcript
  mirror, written continuously by the peer-context-mirror watcher
  (cycle-F always-on). Namespaced by collab session so two sessions'
  identically-named agents (e.g. `claude1`) never collide on one file.
- `task-<id>-*.md` — per-agent peer reports / handoffs.
- `<task-id>.done.json` — completion signal written by the assigned
  agent. The harness picks these up, updates the task list, and
  appends a report to the conversation log.

## The 6 rules (injected into every agent's startup prompt)

1. **Read before acting** — on receiving a task, read
   `conversation-*.md` and `context.md` (if present) in the session
   directory to pick up prior context and other agents' work.
2. **Discover peer context on demand** — when information needed to
   advance a task is not in the current message, conversation log, or
   `context.md`, search the per-session peer-context store
   (`contexts/<collab-session-id>/*.jsonl` and other agents'
   `task-*-*.md` files) using
   **targeted grep — not exhaustive reads**. If targeted search
   doesn't surface the missing info, surface the gap to the user
   rather than crawl wider.
3. **Be self-contained** — task reports should include enough detail
   that any other agent can understand what you did without
   reconstructing context from elsewhere.
4. **Reference by task ID** (e.g. `task-1-…`) in all reports.
5. **Signal blockers** — state the blocking task ID and what you
   need. Try Rule 2 first before declaring blocked on a missing-info
   gap.
6. **Signal completion** — write `<TASK_ID>.done.json` to the session
   directory with `task_id`, `author`, `status`, `reasoning`,
   `conclusion`, and `output` fields. The harness updates the task
   list and appends a report to the conversation log automatically.

Rule 2 specifically complements Rule 5: an agent that hits an
information gap should grep the peer-context store before treating
the task as blocked, but stop short of reading whole transcripts —
that path leads to context-window exhaustion. If targeted search
fails, escalate to the user (Rule 5) rather than crawl wider.

## Rule discipline for contributors

- **Keep the prompt source-of-truth in the TS template literal.** The
  injected prompt is the contract; this doc describes it. Don't
  invert that.
- **Don't add behavioral rules here without also adding them to the
  prompt.** Agents see the prompt, not this file.
- **Don't remove rules in the prompt without checking
  `agentOutputCapture.ts`** — that file has a regex that strips the
  protocol block from captured PTY output by section delimiters; the
  delimiters are part of the contract too.
- **Tests** — assertions on the protocol block in
  `collaboratorStore.test.ts` use `.toContain("Agent Task Protocol")`,
  which matches the section header (stable across rule changes). New
  rules don't break those tests; renaming the section would.

## Related files

- `src/stores/collaboratorStore.ts::TASK_PROTOCOL` — canonical prompt.
- `src/lib/agentOutputCapture.ts` — strips the protocol block from
  captured agent output so it doesn't loop back into peer-context.
- `src-tauri/src/commands/memory.rs` — Rust-side reads/writes for the
  collab-memory directory; enforces path validation and symlink
  protection.
- `src/components/collaborator/PeerContextPanel.tsx` — frontend view
  over the contexts mirror.
