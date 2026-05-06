# Phase E Design — Retire `fsdLineTap` (suspended)

**Status:** SUSPENDED pending upstream CLI capability OR stdout-interceptor design
**Author:** @claude1
**Date:** 2026-05-06
**Scope:** Remove `src/lib/fsdLineTap.ts` (267 LOC) and its parsing complexity (CR-redraw collapse, no-LF dispatch, hard-wrap reassembly, ANSI strip, partial-line cap, echo suppression, blanket mute, parser isolation, `# #FSD` escape).

---

## Why suspended

`fsdLineTap.ts` exists because the leader CLI's `##FSD` commands travel
**multiplexed with terminal display** through a PTY. Every parsing
complexity in the file is a defense against that multiplexing:

| Defense | Defended against |
|---|---|
| CR-redraw collapse (`normalizePtyLine`) | Status-bar redraws overwriting `##FSD` content |
| `processUnterminatedFsdCandidate` | CLIs that omit trailing newline |
| `pendingFsdLine` reassembly | PTY hard-wrap splitting JSON across visible rows |
| `stripAnsi` | ANSI escape codes wrapping the JSON payload |
| 64KB partial-line cap | Adversarial / malformed input DoS |
| `expectEcho` | Leader CLI echoing injected text |
| Blanket mute fallback | Phase-0 `EchoFidelity < 80%` recovery |
| `# #FSD` escape recognition | Documented opt-out for prose mentions |

The **only** way to retire all of this is to remove the multiplex —
i.e., have the leader emit `##FSD` commands somewhere other than its
PTY-multiplexed stdout.

---

## Two viable paths

### Path A — upstream CLI feature ("write to file" mode)

Convince Claude Code / Codex CLI / Gemini CLI / Copilot CLI vendors to
add a side-channel emit mode (e.g. `claude --fsd-emit-file=/path/to/out`)
where `##FSD` JSON commands stream to that file instead of stdout. The
canvas-terminal harness watches the file via `notify` (already a Phase B
dep) and dispatches.

**Status:** none of the four supported CLIs has this feature today.
Requires vendor cooperation; outside our control.

### Path B — leader-prompt-based via Write tool (claude2 task-14 §P5)

Change the leader's system prompt to instruct the CLI: *"To issue an
`##FSD` command, use the Write tool to create
`${memory_root}/inbox/orchestrator/.pending/<filename>.json` with the
following JSON body. Do NOT print `##FSD` lines to stdout."*

The harness watches `inbox/orchestrator/.pending/` via `notify` and
dispatches each new file as if it were a parsed `##FSD` line.

**Trade-offs:**
- ✓ No vendor dependency.
- ✓ Reuses Phase B's `notify` watcher infrastructure.
- ✓ Reuses the existing inbox subsystem (storage, validation, atomic claim).
- ✗ Requires every leader CLI to support a Write/file-system tool that
  can write to the memory root path. Claude Code does. Codex/Gemini/Copilot:
  status varies; depends on their permission models and tool inventory.
- ✗ Prompt-engineering brittleness: the leader might revert to `##FSD`
  on stdout if the prompt isn't followed strictly. A regression here would
  be silent (no commands fire) until the user notices nothing happens.
- ✗ Defeats the purpose if leaders STILL print `##FSD` to stdout and the
  parser stays for backward compat.

---

## Why Path B isn't a no-brainer

Even if all four CLIs support Write tools, the leader's prompt
discipline is part of the trust model. The current `fsdLineTap` parses
whatever the CLI prints; a Path B implementation requires the CLI to
actively choose Write-tool-output every time. A leader experimenting
with output formatting (e.g. printing the FSD JSON for human inspection
before committing to Write-tool emission) would silently break.

The current `fsdLineTap` is structurally fragile but **observable** —
if a `##FSD` command appears on screen, the user can see it. A
file-based emit path would be invisible during dev, making debugging
harder.

---

## Recommended trigger conditions for Phase E unlock

Re-evaluate Phase E when **all** of the following hold (per plan v6
§2.16 #21 + claude5 task-42 §5.2):

1. Phase B has been in production for ≥2 weeks with zero
   iteration_report-related defects (i.e., the inbox infrastructure
   is empirically reliable for the orch→leader direction).
2. At least one supported leader CLI has shipped either:
   - a native `--fsd-emit-file=PATH` mode (Path A), OR
   - a documented `--prompt-only-emits-via-write-tool` discipline that
     the vendor will support via prompt tuning (Path B).
3. A separate research task has produced a **prototype** showing the
   leader-emit-via-Write-tool path works for the FSD `plan`/`dispatch`
   /`done`/`blocked` verbs across at least one round-trip.
4. The team has agreed to accept the regression-detection visibility
   trade-off (file-based emit is harder to debug than stdout).

---

## Scope of Phase E (when unlocked)

Files removed:
- `src/lib/fsdLineTap.ts` (-267 LOC) — the parser itself.
- `src/lib/fsdLineTap.test.ts` (-220 LOC) — the parser's regression suite.
- The `pty-data-${sessionId}` listener path that feeds the tap.

Files added:
- `src-tauri/src/fsd/leader_outbox_watcher.rs` — `notify`-driven watcher
  on `inbox/orchestrator/.pending/` that calls
  `fsd_dispatch_command` for each new file.

Modifications:
- Leader system prompt: add the Write-tool emit instruction (per Path B).
- `AgentMiniTerminal.tsx`: stop wiring `pty-data-${sessionId}` →
  `fsdLineTap.feed` for FSD-mode sessions.

LOC delta: ~-300 net (parser removal larger than outbox-watcher add).

---

## Suspended decision rationale

Per claude2 task-11 §"My counter-proposal" + plan v6 §2.4 + plan v6
§2.16 #21:

> *"Marginal value of further review rounds is now strictly negative."*
> — claude5 task-69 §7

Phase E adds a parsing-class fix that the current `fsdLineTap` already
addresses functionally (R1 + R2 fixes for CR-redraw / no-LF / hard-wrap
all PASS regression tests). The **architectural** payoff is removing
~300 LOC of fragile parsing code, but the **operational** cost is a
new prompt-discipline trust requirement.

Suspended decision: **yes, eventually do this — but not until Phase B
is empirically stable AND a leader-emit-via-Write-tool prototype works
end-to-end.** Until then, `fsdLineTap` continues to work and is now
hardened against every reviewer-flagged failure mode (CR-redraw rescue,
no-LF dispatch, hard-wrap reassembly, ANSI strip, echo suppression).

---

## Status of this design doc

This document captures the **design** for Phase E so that when the
preconditions are met, a future implementer has a clear blueprint.
It does NOT implement Phase E. The implementation gate is the
trigger conditions above.

**Action items when conditions are met:**
1. Spike a Path B prototype (~1 sprint).
2. Validate end-to-end: leader emits one `##FSD plan` via Write tool
   → harness dispatches → orchestrator state machine processes → no
   stdout `##FSD` line ever appears.
3. Migrate one supported leader CLI's prompt; observe for ≥1 week.
4. Migrate remaining leader CLIs.
5. Remove `fsdLineTap.ts` + tests.
6. Audit: confirm no remaining `pty-data-*` listener feeds an FSD
   parser path.
