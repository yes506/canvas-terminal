// Central configuration for the resilience / recovery subsystem.
//
// This is the single named owner of the staged-rollout feature gate
// (`recoveryGateOpen`) referenced by IRecoveryOrchestrator.shouldRecover, plus
// the thresholds / budgets / caps the concrete implementations read. Keeping
// them here (rather than scattered literals) means the staged rollout
// (#1+#2 diagnostics ship first → collect evidence → flip the gate to enable
// #3/#4 recovery) flips ONE flag.
//
// The gate defaults CLOSED: until it is opened, shouldRecover returns
// proceed:false for every sign so only diagnostics accrue and the
// reload-crossing recovery path (which depends on the deferred Rust IPC
// layer) never fires.

export interface ResilienceConfig {
  /**
   * The #3 evidence gate. Default CLOSED. While closed, shouldRecover never
   * authorizes a reload-crossing recovery regardless of sign — only the
   * diagnostic trail (#1 heartbeat/watchdog/watermark, #2 detector) accrues.
   */
  recoveryGateOpen: boolean;

  /** Heartbeat tick cadence (ms). */
  heartbeatIntervalMs: number;
  /** How often a beat is forwarded to the durable Rust sink (throttle, ms). */
  beatForwardThrottleMs: number;
  /** Liveness gap beyond which a death is suspected (ms). */
  deathSuspicionThresholdMs: number;

  /** Upper bound on PTY scrollback bytes Rust replays on reattach. */
  replayBudgetBytes: number;
  /** Debounce for the proactive topology persist writer (ms). */
  persistDebounceMs: number;
  /** Schema version stamped onto persisted TopologySnapshots. */
  snapshotSchemaVersion: number;

  /** Per-kind scrollback line caps. mini <= main (numerous panes bounded tighter). */
  scrollbackLines: { main: number; mini: number };

  /** Max simultaneous xterm WebGL contexts before the allocator denies. */
  webglContextCap: number;

  /** Durable recovery-session lifetime before it expires (ms). */
  recoverySessionTtlMs: number;
  /** Max durable resume attempts before recovery fails fast to 'failed'. */
  recoveryMaxAttempts: number;
  /**
   * How long resumeAfterReload's adoption-readiness barrier waits for the
   * restored panes to mount + subscribe their pty-data listeners before the
   * unready ids are reported lost (webcontent-death-recovery node 12b).
   */
  adoptionReadinessTimeoutMs: number;
}

export const resilienceConfig: ResilienceConfig = {
  recoveryGateOpen: false,

  heartbeatIntervalMs: 2000,
  beatForwardThrottleMs: 1000,
  deathSuspicionThresholdMs: 10000,

  replayBudgetBytes: 256 * 1024,
  persistDebounceMs: 400,
  snapshotSchemaVersion: 1,

  scrollbackLines: { main: 10000, mini: 2000 },

  webglContextCap: 16,

  recoverySessionTtlMs: 60000,
  recoveryMaxAttempts: 2,
  adoptionReadinessTimeoutMs: 10000,
};
