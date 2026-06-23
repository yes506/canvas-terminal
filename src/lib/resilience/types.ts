// Value objects for the resilience / recovery subsystem.
//
// Pure data shapes (no behavior) shared across the resilience interfaces.
// Serializable where they cross the reload / IPC boundary (TopologySnapshot,
// ResourceWatermark, DeathEvidence) so the implementer can persist + restore
// them without re-deriving the schema.
//
// `ToolId` is imported (type-only — still just string literals at runtime, so
// serializability holds) so AgentSnapshot.tool stays in lock-step with the live
// tool set instead of drifting from a hand-mirrored union (round-5 codex1/codex2/
// claude3/codex3 — @claude1 task-12).
import type { ToolId } from "../../types/collaborator";
//
// Revised after the round-2 peer review (codex2 task-39, claude3 task-40,
// codex3 task-41, claude2 task-38): the snapshot schema is now ISOMORPHIC to
// the live PaneNode (src/types/terminal.ts), collaborator agents are first
// class, and the A/B discriminator carries an incident identifier.
//
// Recorded as `value_objects` in .planner-state.json per the system-lane
// no-implementation rule.

/**
 * Root-cause sign of a "header-only" content-loss event.
 * - `webcontent-death` = hypothesis A: macOS WKWebView WebContent process
 *   jettison. Self-undetectable from the dead JS context — confirmed only
 *   via IWebContentWatchdog (Rust-owned durable evidence), never heartbeat.
 * - `js-fatal`         = hypothesis B: uncaught top-level JS throw (caught
 *   by RootErrorBoundary; the JS context survives).
 * - `gpu-loss`         = hypothesis C: GPU/compositor process crash while JS
 *   lives (blank screen, heartbeat keeps ticking, boundary silent). Detected
 *   only indirectly via WebGL context-loss counters in ResourceWatermark.
 *   Known partial blind spot — see IDeathDetector.classifySign.
 * - `unknown`          = no discriminator fired conclusively.
 */
export type RootCauseSign =
  | "webcontent-death"
  | "js-fatal"
  | "gpu-loss"
  | "unknown";

/** Lifecycle phase of the recovery FSM (mirrors IResilienceStore). */
export type RecoveryPhase =
  | "healthy"
  | "suspect"
  | "recovering"
  | "recovered"
  | "failed";

/** Concrete recovery action the orchestrator may take. */
export type RecoveryAction = "reload-in-place" | "recreate-webview" | "none";

/** Terminal class — drives per-kind WebGL budgeting + scrollback caps. */
export type TerminalKind = "main" | "mini";

/**
 * Incident generation token. Correlates the two asynchronous evidence paths
 * (the visibility/heartbeat path and the error-boundary path) into ONE
 * incident, so classifySign can read the boundaryCaught flag that belongs to
 * the same event. Minted on entry to 'suspect'; monotonic per JS context.
 */
export type IncidentId = string;

/** Verdict from a liveness-gap analysis after visibility regain. */
export interface LivenessVerdict {
  /** Wall-clock gap since the last recorded heartbeat tick, in ms. */
  gapMs: number;
  /** True when the gap exceeds the death-suspicion threshold. */
  suspectDeath: boolean;
  /** Epoch ms at which the verdict was computed. */
  sampledAt: number;
}

/**
 * Durable, Rust-owned evidence read AFTER a reload to classify hypothesis A.
 * This is the only source that survives a dead JS context (the in-memory
 * heartbeat does not), so it — not IHeartbeat — is what positively confirms
 * 'webcontent-death'. See G1 (claude2) / H1 (codex2) / #5 (codex3).
 */
export interface DeathEvidence {
  /** True if Rust observed a native WebContent termination (delegate hook). */
  observedTermination: boolean;
  /** Durable last heartbeat Rust recorded before the gap, or null. */
  lastGoodBeatAt: number | null;
  /** now − lastGoodBeatAt, computed on the post-reload bootstrap, or null. */
  gapMs: number | null;
  /** Webview launch generation (current). The fresh JS context has NO prior
   *  in-memory baseline to compare against, so the "did we reload" decision is
   *  NOT derivable on the frontend from this value alone — see
   *  `reloadedSinceLastBeat`, which Rust computes by comparing its own durable
   *  previous generation. `launchCount` is retained for diagnostics/telemetry. */
  launchCount: number;
  /** Rust-computed: true iff `launchCount` incremented across the durable
   *  last-beat gap (i.e. the webview relaunched, not merely backgrounded).
   *  Round-4 fix (codex1 MED — @claude1 task-6): the comparison must be
   *  Rust-internal because the dead JS context lost the prior count. The
   *  detector reads THIS boolean, never re-derives it from `launchCount`.
   *  Round-5 caveat (claude3 LOW — @claude1 task-12): a reload can be
   *  SELF-INDUCED (recovery's own prepareReloadRecovery, incl. B-escalation),
   *  so this is only valid death-evidence for an UNEXPECTED reload — i.e. when
   *  NO recovery session is pending. On an expected resume the sign comes from
   *  the pending RecoverySession.decision, not from re-deriving death here (see
   *  IDeathDetector.classifySign + IRecoveryOrchestrator.resumeAfterReload). */
  reloadedSinceLastBeat: boolean;
}

/** A point-in-time resource-pressure sample. */
export interface ResourceWatermark {
  /** JS heap used in bytes, or null when performance.memory is unavailable. */
  jsHeapUsedBytes: number | null;
  /** Count of live xterm WebGL contexts at sample time. */
  webglContexts: number;
  /** Cumulative WebGL context-loss events seen (secondary signal for gpu-loss). */
  webglContextLosses: number;
  /** Open main terminal tabs at sample time. */
  terminalTabs: number;
  /** Open collaborator panes at sample time. */
  collaboratorPanes: number;
  /** Epoch ms of the sample. */
  sampledAt: number;
}

/** Classification result pairing a sign with confidence + rationale. */
export interface SignClassification {
  sign: RootCauseSign;
  /** 0..1 — how strongly the evidence supports `sign`. */
  confidence: number;
  /** Human-readable basis (e.g. "Rust observedTermination=true, gap 41s"). */
  rationale: string;
  /** The incident this classification belongs to. */
  incidentId: IncidentId;
}

/** Read-model handed to the boundary fallback renderer. */
export interface RecoveryView {
  phase: RecoveryPhase;
  sign: RootCauseSign;
  /** Last error message surfaced to the user, or null. */
  lastError: string | null;
  /** Whether a manual retry/recover action should be offered. */
  canRetry: boolean;
}

/** Snapshot of the resilience FSM + last observations. */
export interface ResilienceState {
  phase: RecoveryPhase;
  lastSign: RootCauseSign | null;
  lastWatermark: ResourceWatermark | null;
  recoveryAttempts: number;
  /** True if RootErrorBoundary caught a throw in the current incident. */
  boundaryCaught: boolean;
  /** The active/most-recent incident token, or null when healthy. */
  lastIncidentId: IncidentId | null;
}

/**
 * One rename-audit entry — isomorphic to AgentNameRecord
 * (src/types/collaborator.ts), inlined here so the snapshot stays serializable
 * and decoupled from the live store type. `nameHistory[0]` is the system birth
 * name; the last entry is the current nickname.
 */
export interface AgentNameSnapshot {
  nickname: string;
  /** ISO timestamp this nickname became active. */
  setAt: string;
  /** Who set it: "system" (auto), "user" (UI/slash), or "@<handle>" (programmatic). */
  setBy: "system" | "user" | `@${string}`;
}

/**
 * One collaborator agent tile inside a collaborator pane. Captured so the
 * pane re-hydrates its (component-local `spawns`) state after reload WITHOUT
 * re-spawning — the surviving Rust PTY is reattached instead. Mirrors the
 * Spawn shape in CollaboratorPane.tsx plus the collaboratorStore agent meta.
 * See codex2 H2 / claude3 #4 / codex3 #4.
 *
 * Round-4 review fix (codex1 MED / codex2 MED — 3-way; @claude1 task-6 verified
 * against SpawnedAgent collaborator.ts:65-97): the snapshot now mirrors the FULL
 * materialized identity model so a restore neither re-mints it via `addAgent`
 * (which would recompute ordinal/nicknameSlug and DROP a user rename) nor leaves
 * mention/AtMention/task-routing resolution unable to rebuild the tile. The
 * restore path MUST seed `collaboratorStore` directly from these fields, bypassing
 * `addAgent`'s ordinal/slug/history minting.
 *
 * Round-5 review fix (codex1/codex2/claude3/codex3 — 4-way; @claude1 task-12):
 * field types are tightened to the live `SpawnedAgent` shape (`tool: ToolId`,
 * `status` union, NON-null `nickname`) so the snapshot cannot represent a state
 * `restoreAgents` would have to invent. Note there is intentionally NO separate
 * transcript/log-pointer field: a tile's durable log identity is DERIVABLE from
 * (`collabSessionId`, `sessionId`, `handle`) — the session memory dir + per-task
 * report files are keyed on exactly those — so "log preservation" means the
 * restore re-homes the tile under the same keys, not that a pointer is stored.
 *
 * Recovery policy (CLOSED in the planner per round-3 codex2 MED / claude3 D):
 * for an ALIVE Rust PTY, reattach is REQUIRED (lossless); for a DEAD PTY, the
 * tile is restored as an exited shell that PRESERVES `handle`, `nickname`, and
 * its (derivable) log identity — it is never silently dropped and never
 * auto-respawned. Dead-PTY tiles surface in RestoreReport.failedSessions.
 */
export interface AgentSnapshot {
  /** Agent PTY session id — reattach target (must be reused, never regenerated). */
  sessionId: string;
  /** Parent collaborator pane/session id (collabSessionId) this tile belongs to.
   *  REQUIRED to re-home the tile into the correct pane and to scope killAllAgents
   *  suppression; without it the restore cannot reconstruct pane membership. */
  collabSessionId: string;
  /** Tool the agent was spawned with — live ToolId union (not a loose string),
   *  so restore seeds a valid SpawnedAgent row directly. */
  tool: ToolId;
  /** Agent working directory, or null if unresolved at capture. */
  cwd: string | null;
  /** Last known agent status — live SpawnedAgentInit union. A dead-PTY tile is
   *  restored as 'exited' (per the recovery policy above). */
  status: "spawning" | "running" | "exited";
  /** IMMUTABLE protocol @handle ("claude1" …) — restored verbatim (tasks/logs key on it). */
  handle: string;
  /** Monotonic per-tool ordinal within the collab session — restored verbatim so
   *  reattach does NOT re-mint it via addAgent (which would drift identity). */
  ordinal: number;
  /** Display nickname — NON-null, mirroring live SpawnedAgent.nickname (a system
   *  birth name always exists; `nameHistory[last]` is its source of truth). */
  nickname: string;
  /** Cached slugify(nickname) for O(1) mention/collision — restored, not recomputed. */
  nicknameSlug: string;
  /** Append-only rename audit — restored verbatim so a user rename survives recovery. */
  nameHistory: AgentNameSnapshot[];
  /** Peer-context publishing opt-in, resolved to a concrete boolean at capture
   *  (live SpawnedAgent.publishOptedIn is optional with `=== true` semantics; the
   *  snapshot stores the resolved value so restore needs no defaulting). */
  publishOptedIn: boolean;
}

/**
 * Serialized leaf pane. Isomorphic to PaneLeaf (src/types/terminal.ts) plus
 * the persistence-only fields (cwd, agents). `cwd` is meaningful only for
 * terminal/collaborator leaves; `agents` is populated only for collaborator
 * leaves (null otherwise).
 */
export interface SnapshotLeaf {
  type: "leaf";
  kind: "terminal" | "collaborator";
  /** Stable session id to reattach against the surviving Rust PTY. */
  sessionId: string;
  /** Working directory captured via get_pty_cwd, or null if unknown/N-A. */
  cwd: string | null;
  /** Collaborator agent tiles to re-hydrate; null for terminal leaves. */
  agents: AgentSnapshot[] | null;
}

/** Serialized split node. Isomorphic to PaneSplit (src/types/terminal.ts). */
export interface SnapshotSplit {
  type: "split";
  direction: "horizontal" | "vertical";
  children: [SnapshotPane, SnapshotPane];
}

/** Serializable pane tree — a discriminated union matching the live PaneNode. */
export type SnapshotPane = SnapshotLeaf | SnapshotSplit;

/** One serialized terminal tab (isomorphic to Tab incl. maximized state). */
export interface TabSnapshot {
  id: string;
  title: string;
  paneTree: SnapshotPane;
  activePaneSessionId: string;
  /** Maximized pane session id, or null — preserves UI topology. */
  maximizedPaneSessionId: string | null;
}

/** Full serializable terminal+collaborator topology. */
export interface TopologySnapshot {
  /** Schema version for forward-compat of persisted snapshots. */
  version: number;
  capturedAt: number;
  tabs: TabSnapshot[];
  activeTabId: string | null;
}

/** Outcome of rebuilding the pane shell from a persisted snapshot. */
export interface RestoreReport {
  restoredTabs: number;
  restoredSessions: number;
  /** Session ids whose pane could not be rebuilt. */
  failedSessions: string[];
}

/** Budget bounding how much PTY scrollback Rust replays on reattach. */
export interface ReplayBudget {
  /** Upper bound on bytes Rust replays back through the pty-data event stream. */
  maxBytes: number;
}

/**
 * Result of reattaching one front-end terminal to a surviving Rust PTY.
 * Replay payload is NOT returned inline — Rust re-emits its bounded per-session
 * ring buffer through the existing `pty-data-{sessionId}` event the front end
 * already listens on (see IPtyReattachClient + the Rust replay-buffer contract
 * in architecture.html). `replayBytes` reports how much was re-emitted.
 */
export interface PtyReattachResult {
  sessionId: string;
  /** False when the Rust PTY for this session is no longer alive. */
  alive: boolean;
  /** Bytes of replay buffer re-emitted (<= ReplayBudget.maxBytes). */
  replayBytes: number;
}

/** Decision of whether/how to recover for a given sign. */
export interface RecoveryDecision {
  proceed: boolean;
  sign: RootCauseSign;
  action: RecoveryAction;
  /** Why this decision was reached (gating rationale). */
  reason: string;
}

/**
 * Durable, generation-stamped recovery token. Carries recovery INTENT across a
 * webview reload — the one thing the in-memory orchestrator cannot. Minted in
 * the dying/old context (or by Rust on the A path) and read by the fresh
 * context's bootstrap. See round-3 review (codex2/claude3/codex3 convergence):
 * an in-memory recover() + isReloadInProgress flag cannot survive the reload
 * they trigger.
 */
export type RecoveryToken = string;

/**
 * Durable recovery-session record, persisted (PID-stable Rust store or
 * Rust-mirrored) so a FRESH JS context after reload knows a recovery is in
 * progress, what to do, and to suppress teardown before any component mounts.
 */
export interface RecoverySession {
  token: RecoveryToken;
  /** What the orchestrator intends to do on resume. */
  decision: RecoveryDecision;
  /** True ⇒ component unmount must SKIP kill_pty during this recovery. */
  suppressTeardown: boolean;
  createdAt: number;
  /** Generation/expiry guard so a stale session can't drive a spurious resume. */
  expiresAt: number;
  /**
   * Durable resume-attempt counter. Round-4 fix (claude3 MED-1 — @claude1
   * task-6): the FSM's in-memory `recoveryAttempts` RESETS on every reload, so
   * a `resumeAfterReload` that itself re-triggers a WebContent death would re-read
   * this same session and thrash-retry until `expiresAt`. This counter is
   * durably INCREMENTED-and-persisted by `IRecoverySession.claimAttempt()` BEFORE
   * any restore side-effect (round-5 fix — codex1/codex2/claude3 — @claude1
   * task-12: `loadPending()` is read-only and cannot mutate it); when it exceeds
   * `maxAttempts` the orchestrator fails fast to 'failed' instead of looping.
   * Time-expiry remains the outer backstop.
   */
  attempts: number;
  /** Upper bound on `attempts` before recovery is abandoned to 'failed'. */
  maxAttempts: number;
}

/** Result of staging a reload-crossing recovery in the old/live context. */
export interface RecoveryLaunch {
  token: RecoveryToken;
  action: RecoveryAction;
  /** True once the reload/recreate has been requested. */
  reloadRequested: boolean;
}

/** Terminal outcome of a recovery run. */
export interface RecoveryOutcome {
  success: boolean;
  restoredSessions: number;
  /** Session ids that could not be recovered (PTY dead / restore failed). */
  lostSessions: string[];
  elapsedMs: number;
  phase: RecoveryPhase;
}

/** Grant/deny of a WebGL context slot under the budget cap. */
export interface WebglGrant {
  sessionId: string;
  /** True = caller may create a WebGL renderer; false = fall back to DOM. */
  granted: boolean;
  /** Reason for a denial (e.g. "cap reached: 16 active"). */
  reason: string;
}
