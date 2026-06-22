// Value objects for the resilience / recovery subsystem.
//
// Pure data shapes (no behavior) shared across the resilience interfaces.
// Serializable where they cross the reload / IPC boundary (TopologySnapshot,
// ResourceWatermark, DeathEvidence) so the implementer can persist + restore
// them without re-deriving the schema.
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
  /** Webview launch generation; an increment across a beat-gap implies a reload. */
  launchCount: number;
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
 * One collaborator agent tile inside a collaborator pane. Captured so the
 * pane re-hydrates its (component-local `spawns`) state after reload WITHOUT
 * re-spawning — the surviving Rust PTY is reattached instead. Mirrors the
 * Spawn shape in CollaboratorPane.tsx plus the collaboratorStore agent meta.
 * See codex2 H2 / claude3 #4 / codex3 #4.
 */
export interface AgentSnapshot {
  /** Agent PTY session id — reattach target (must be reused, never regenerated). */
  sessionId: string;
  /** Tool id the agent was spawned with (claude / codex / gemini …). */
  tool: string;
  /** Agent working directory, or null if unresolved at capture. */
  cwd: string | null;
  /** Last known agent status (spawning / active / exited …). */
  status: string;
  /** Stable @handle for the agent. */
  handle: string;
  /** User-assigned nickname, or null. */
  nickname: string | null;
  /** Whether the agent opted into peer-context publishing. */
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
