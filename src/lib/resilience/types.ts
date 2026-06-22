// Value objects for the resilience / recovery subsystem.
//
// These are pure data shapes (no behavior) shared across the resilience
// interfaces. They are intentionally serializable where they cross the
// reload / IPC boundary (TopologySnapshot, ResourceWatermark) so the
// implementer can persist + restore them without re-deriving the schema.
//
// Recorded as `value_objects` in .planner-state.json per the system-lane
// no-implementation rule.

/**
 * Root-cause sign of a "header-only" content-loss event.
 * - `webcontent-death` = hypothesis A: macOS WKWebView WebContent process
 *   jettison (React tree gone, native titlebar survives).
 * - `js-fatal`         = hypothesis B: uncaught top-level JS throw (React
 *   unmounts; caught by RootErrorBoundary).
 * - `unknown`          = neither discriminator fired conclusively.
 */
export type RootCauseSign = "webcontent-death" | "js-fatal" | "unknown";

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

/** Verdict from a liveness-gap analysis after visibility regain. */
export interface LivenessVerdict {
  /** Wall-clock gap since the last recorded heartbeat tick, in ms. */
  gapMs: number;
  /** True when the gap exceeds the death-suspicion threshold. */
  suspectDeath: boolean;
  /** Epoch ms at which the verdict was computed. */
  sampledAt: number;
}

/** A point-in-time resource-pressure sample. */
export interface ResourceWatermark {
  /** JS heap used in bytes, or null when `performance.memory` is unavailable. */
  jsHeapUsedBytes: number | null;
  /** Count of live xterm WebGL contexts at sample time. */
  webglContexts: number;
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
  /** Human-readable basis (e.g. "boundary caught: TypeError in DrawingBoard"). */
  rationale: string;
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
}

/** One serialized pane node (mirrors the live PaneNode but persistable). */
export interface SnapshotPane {
  kind: "terminal" | "collaborator";
  /** Stable session id to reattach against the surviving Rust PTY. */
  sessionId: string;
  /** Working directory captured via get_pty_cwd, or null if unknown. */
  cwd: string | null;
  /** Split children when this is a split node; null for a leaf. */
  children: [SnapshotPane, SnapshotPane] | null;
  /** Split direction for non-leaf nodes; null for a leaf. */
  direction: "row" | "column" | null;
}

/** One serialized terminal tab. */
export interface TabSnapshot {
  id: string;
  title: string;
  paneTree: SnapshotPane;
  activePaneSessionId: string;
}

/** Full serializable terminal+collaborator topology. */
export interface TopologySnapshot {
  /** Schema version for forward-compat of persisted snapshots. */
  version: number;
  capturedAt: number;
  tabs: TabSnapshot[];
  activeTabId: string | null;
}

/** Outcome of restoring a TopologySnapshot into live stores. */
export interface RestoreReport {
  restoredTabs: number;
  restoredSessions: number;
  /** Session ids whose pane could not be rebuilt. */
  failedSessions: string[];
}

/** Budget bounding how much PTY scrollback to replay on reattach. */
export interface ReplayBudget {
  /** Upper bound on bytes the Rust side should replay back to the front end. */
  maxBytes: number;
}

/** Result of reattaching one front-end terminal to a surviving Rust PTY. */
export interface PtyReattachResult {
  sessionId: string;
  /** False when the Rust PTY for this session is no longer alive. */
  alive: boolean;
  /** Bytes of replay buffer returned (<= ReplayBudget.maxBytes). */
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
