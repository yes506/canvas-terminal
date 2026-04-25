# Collaborator Inbox System — Implementation Plan

> Consolidated from multi-agent feasibility analysis (task-1 through task-6, 2026-04-24)

## Overview

Add a **file-based inbox + periodic polling + auto-injection** layer to the Collaborator mode, enabling asynchronous inter-agent communication and system-initiated task delivery without going through the UI.

### Concept (from canvas snapshot)

```
canvas-terminal system
┌──────────────────────────────────────────────────────────┐
│  .cache/.../session-xxxx/                                │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  agent1's inbox    agent2's inbox    agent3's inbox │ │ ← polling periodically
│  └──────┬──────────────────┬──────────────────┬────────┘ │
│         │                  │                  │          │
│         ▼                  ▼                  ▼          │ ← injecting messages as prompts
│     ┌────────┐        ┌────────┐        ┌────────┐      │
│     │ agent1 │        │ agent2 │        │ agent3 │      │ ← executing tasks automatically
│     └────────┘        └────────┘        └────────┘      │
└──────────────────────────────────────────────────────────┘
```

## Current State (what already works)

| Component | Status | Key Files |
|-----------|--------|-----------|
| Shared memory directory | Done | `src-tauri/src/commands/memory.rs:60-176` |
| Agent spawning with ordinal handles | Done | `src/stores/collaboratorStore.ts` |
| PTY prompt injection (bracketed paste) | Done | `src-tauri/src/commands/pty.rs:451-499` |
| Context header prepending | Done | `src/stores/collaboratorStore.ts:369-416` |
| Task completion scanning (`.done.json`) | Done | `src/stores/collaboratorStore.ts:318-367` |
| Echo suppression (mute capture) | Done | `src/lib/agentOutputCapture.ts` |
| Pending message queue (for spawning agents) | Done | `src/stores/collaboratorStore.ts:564-612` |

**Current architecture: push model** — user sends message via InputPrompt -> `sendToAgent()` -> `inject_into_pty()` directly.

## Gap Analysis (what's missing)

1. **Per-agent inbox directories** — No file-based inbox per agent; messages go directly from UI to PTY
2. **Periodic polling loop** — Task completion scanning is reactive (on output flush), not timer-based
3. **Inbox dispatcher** — No system that reads inbox files and auto-injects them as prompts
4. **Deduplication / acknowledgment** — No protocol to mark inbox items as processed

## Design

### Hybrid Approach (recommended by @claude2)

Keep **direct PTY injection** for user-initiated messages (low latency), and add **inbox-based delivery** for:
- System-generated messages (auto task assignment)
- Cross-agent communication (agent-to-agent messaging)
- External tool integrations (canvas exports, file watchers)

### Inbox File Structure

```
.cache/canvas-terminal/collab-memory/session-{PID}/
├── conversation-{collabId}.md          # existing
├── tasks-{collabId}.md                 # existing
├── context.md                          # existing
└── inbox/
    ├── claude1/
    │   ├── 1777022528061-msg-001.json  # pending message
    │   └── 1777022528062-msg-002.json
    ├── codex1/
    │   └── 1777022528063-msg-001.json
    └── claude2/
        └── (empty — no pending messages)
```

### Inbox Message Schema

```typescript
interface InboxMessage {
  id: string;                          // unique message ID
  target: string;                      // agent handle, e.g. "@claude1"
  content: string;                     // message body to inject
  createdBy: string;                   // "@user" | "@claude2" | "system"
  taskId?: string;                     // optional task reference
  createdAt: string;                   // ISO timestamp
  priority?: "normal" | "high";       // high = inject next poll cycle
}
```

### Polling Loop

```
CollaboratorPane (or collaboratorStore)
  │
  ├─ setInterval(scanInboxes, 2000)    // every 2 seconds
  │
  ├─ For each running agent:
  │   ├─ list files in inbox/{handle}/
  │   ├─ Sort by timestamp (FIFO)
  │   ├─ For each message file:
  │   │   ├─ Read JSON content
  │   │   ├─ Call sendToAgent(sessionId, content)
  │   │   ├─ Delete file (ack)
  │   │   └─ Append system log entry
  │   └─ Skip if agent status != "running"
  │
  └─ Also run scanForTaskCompletions() on same timer
```

## Implementation Steps

### Phase 1: Inbox Infrastructure

**Files to modify:**

1. **`src-tauri/src/commands/memory.rs`**
   - No changes needed — existing `write_memory_file`, `read_memory_file`, `list_memory_files`, `delete_memory_file` already support subdirectory paths like `inbox/claude1/msg.json`

2. **`src/stores/collaboratorStore.ts`**
   - Add `scanForInboxMessages(collabSessionId)` method
   - Add `writeToInbox(agentHandle, message)` method
   - Move task completion scanning from reactive (on output flush) to timer-based
   - Add `startInboxPoller()` / `stopInboxPoller()` lifecycle methods

3. **`src/types/collaborator.ts`**
   - Add `InboxMessage` interface

### Phase 2: Polling Loop

**Files to modify:**

4. **`src/components/collaborator/CollaboratorPane.tsx`**
   - Start inbox poller when collaborator session opens
   - Stop poller on unmount / session close

5. **`src/components/collaborator/AgentMiniTerminal.tsx`**
   - Remove reactive `scanForTaskCompletions()` calls from output flush handler (moved to timer)

### Phase 3: Write Path (agent-to-agent)

**Files to modify:**

6. **`src/stores/collaboratorStore.ts`**
   - Add agent context injection: include inbox write instructions in protocol header
   - Example: agents can write to `inbox/<target-handle>/<id>.json` to send messages to other agents

7. **`src/components/collaborator/commands.ts`**
   - Optional: add `/inbox` command for manual inbox inspection

### Phase 4: Integration Points

8. **Canvas export → inbox** — When `/canvas-export @agent` runs, write to inbox instead of direct injection
9. **Task assignment → inbox** — When tasks are created with assignee, auto-write to assignee's inbox
10. **Cross-agent messaging** — Agents discover other agents' handles from task definitions and write to their inboxes

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Duplicate dispatch (multiple scanners read same file) | Agent receives same prompt twice | Atomic delete-on-read; use file rename as lock |
| Agent exits while inbox has pending messages | Lost messages | Keep inbox files; re-inject when agent respawns |
| Hidden auto-injections surprise user | UX confusion | Visible system log entries + status indicator |
| Polling latency (2s delay) | Slight delay vs direct injection | Acceptable for system messages; keep direct injection for user messages |
| Race condition on concurrent file writes | Corrupt inbox | Use timestamp-based unique filenames; no shared files |

## Scope Boundary

- Inbox polling only for agents in the current collaborator session
- File-based polling (not OS-level file watchers) — simpler, cross-platform
- Per app-process session directory scoping (existing security model)
- No external network communication — local filesystem only

## Architecture Decision: Push vs Pull

| Aspect | Push (current) | Pull (inbox) | Hybrid (recommended) |
|--------|---------------|--------------|---------------------|
| Latency | Immediate | 1-2s polling delay | Immediate for user, 1-2s for system |
| Reliability | Fragile (readiness detection) | Robust (file-persisted) | Best of both |
| Inter-agent | Not possible | Natural | Enabled via inbox |
| External integration | Not possible | Natural | Enabled via inbox |
| Complexity | Simple | Moderate | Moderate |

## Summary

The concept from the canvas snapshot is **fully implementable**. ~80% of the infrastructure exists. The key additions are:

1. Per-agent inbox directories under shared memory (trivial — existing APIs support it)
2. A 2-second polling loop in `collaboratorStore.ts` (moderate — similar to existing `scanForTaskCompletions`)
3. Inbox dispatcher that reads → injects → deletes (moderate — reuses `sendToAgent`)
4. Protocol header update so agents know how to write to each other's inboxes (small)

Estimated effort: **2-3 days** for a working MVP (Phases 1-2), **1 additional week** for full cross-agent communication (Phases 3-4).
