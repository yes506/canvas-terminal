// Worktree subsystem — core types
//
// Source-of-truth: docs/worktree/spec.md §1 (state machine), §3 (lease
// schema), §4 (dirty preservation transitions). Types are introduced
// here in Phase 2 (per plan-rev-2 R-T1.2) so phases 3–6 build on the
// same lifecycle contract instead of retrofitting.
//
// Phase 7 hardens these via compile_fail + proptest; the fields and
// variants here are the spec-mandated minimum.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ----------------------------------------------------------------------
// Newtypes (validated paths + branch refs)
// ----------------------------------------------------------------------

/// Absolute path to the managed root for worktrees.
/// Per spec §6: `<managed_root>/registry.json`,
/// `<managed_root>/orchestrator.lock`, `<managed_root>/locks/<id>.lock`,
/// `<managed_root>/quarantine/<id>/`. Test root and prod root are
/// separate constants per plan rev-2 §R-T2.7.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManagedRoot(PathBuf);

impl ManagedRoot {
    /// Construct a `ManagedRoot` from an absolute path. Returns
    /// `None` if the path is relative (per spec invariant: managed
    /// root is always absolute so all sub-paths can be validated by
    /// prefix).
    pub fn new(path: impl Into<PathBuf>) -> Option<Self> {
        let p = path.into();
        if p.is_absolute() {
            Some(Self(p))
        } else {
            None
        }
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn registry_path(&self) -> PathBuf {
        self.0.join("registry.json")
    }

    pub fn registry_lock_path(&self) -> PathBuf {
        self.0.join("registry.lock")
    }

    pub fn orchestrator_lock_path(&self) -> PathBuf {
        self.0.join("orchestrator.lock")
    }

    pub fn locks_dir(&self) -> PathBuf {
        self.0.join("locks")
    }

    /// Per R2 verifier convergence (codex1 B1): only accepts a
    /// validated `AgentId` so the joined path cannot escape `locks/`
    /// via `..` or other path traversal in the raw string.
    pub fn lock_path_for(&self, agent_id: &AgentId) -> PathBuf {
        self.locks_dir().join(format!("{}.lock", agent_id.as_str()))
    }

    pub fn quarantine_dir(&self) -> PathBuf {
        self.0.join("quarantine")
    }

    /// Per R2 verifier convergence (codex1 B1): only accepts a
    /// validated `AgentId` so the joined path cannot escape
    /// `quarantine/` via path traversal.
    pub fn quarantine_dir_for(&self, agent_id: &AgentId) -> PathBuf {
        self.quarantine_dir().join(agent_id.as_str())
    }

    pub fn worktrees_dir(&self) -> PathBuf {
        self.0.join("worktrees")
    }

    /// Per F6 verifier convergence: the reaper's per-sweep lockfile
    /// is SEPARATE from `orchestrator.lock`. Sharing the same file
    /// would cause the holding instance's reaper sweeps to always
    /// no-op (Darwin per-process exclusion), preventing the holder
    /// from cleaning up its own crashed children until the next app
    /// restart.
    pub fn sweep_lock_path(&self) -> PathBuf {
        self.0.join("sweep.lock")
    }
}

/// Validated single path segment used as an agent identifier.
/// Per R2 verifier convergence (codex1 B1): the agent id is joined
/// into `<root>/locks/<id>.lock`, `<root>/quarantine/<id>/`, and
/// `<root>/worktrees/<id>/`. If the raw string contains `/`, `\`,
/// `..`, or other path traversal shapes, those joins escape the
/// intended subtree even though `Path::starts_with` lexically
/// passes. This newtype is the type-level guard against that.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct AgentId(String);

impl AgentId {
    /// Construct from a raw string. Returns `None` if the value
    /// contains any path-traversal-shaped substring.
    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let s = raw.into();
        if s.is_empty()
            || s == "."
            || s == ".."
            || s.contains('/')
            || s.contains('\\')
            || s.starts_with('.')
            || s.starts_with('-')
            || s.bytes().any(|b| b.is_ascii_control())
        {
            return None;
        }
        Some(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Validated worktree path. Always under a `ManagedRoot`'s
/// `worktrees_dir()`. Per spec §6.1 invariant: agents never write
/// outside this path (modulo audit-only shell-mediated escapes per
/// plan rev-3 P1.3).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreePath(PathBuf);

impl WorktreePath {
    /// Construct a worktree path under `managed_root`. Per R2 verifier
    /// convergence: callers should prefer `for_agent` so the worktree
    /// path is built from a validated `AgentId`. This raw-path
    /// constructor still exists for serde / migration use; it now
    /// REJECTS any path containing a `..` component, in addition to
    /// the existing prefix check, to defend against lexical traversal.
    pub fn new(managed_root: &ManagedRoot, path: impl Into<PathBuf>) -> Option<Self> {
        use std::path::Component;
        let p = path.into();
        if !p.starts_with(managed_root.worktrees_dir()) {
            return None;
        }
        // Reject any `..` component (R2: codex1 B1)
        if p.components().any(|c| matches!(c, Component::ParentDir)) {
            return None;
        }
        Some(Self(p))
    }

    /// Preferred constructor: build from a validated `AgentId`. The
    /// resulting path is `<managed_root>/worktrees/<agent_id>/` and
    /// is guaranteed safe by construction.
    pub fn for_agent(managed_root: &ManagedRoot, agent_id: &AgentId) -> Self {
        Self(managed_root.worktrees_dir().join(agent_id.as_str()))
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

/// Validated branch reference. Always matches `agent/<session>/<id>`
/// per spec §3 namespace prefix.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct BranchRef(String);

impl BranchRef {
    /// Construct from raw string. Returns `None` if the name does not
    /// start with `agent/` or contains characters illegal in git
    /// refnames. Per F2 verifier convergence (4/5): MUST match
    /// exactly `agent/<session>/<agent>` — three non-empty path
    /// components — and no individual component may violate git
    /// refname rules.
    pub fn new(name: impl Into<String>) -> Option<Self> {
        let s = name.into();

        // Strict 3-component shape: ["agent", session, agent_id]
        let parts: Vec<&str> = s.split('/').collect();
        if parts.len() != 3 {
            return None;
        }
        if parts[0] != "agent" {
            return None;
        }
        if parts[1].is_empty() || parts[2].is_empty() {
            return None;
        }

        // Per-component git refname rules (subset, conservative):
        //   no '..', '@{', '~', '^', ':', '?', '*', '[', '\\', ' '
        //   no leading '.' or '-'
        //   no trailing '.lock'
        //   no ASCII control characters
        for comp in &parts[1..] {
            if comp.contains("..")
                || comp.contains("@{")
                || comp.contains(' ')
                || comp.contains('~')
                || comp.contains('^')
                || comp.contains(':')
                || comp.contains('?')
                || comp.contains('*')
                || comp.contains('[')
                || comp.contains('\\')
                || comp.starts_with('.')
                || comp.starts_with('-')
                || comp.ends_with(".lock")
                || comp.bytes().any(|b| b.is_ascii_control())
            {
                return None;
            }
        }

        Some(Self(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Build a branch ref from session id + agent id.
    pub fn for_agent(session_id: &str, agent_id: &str) -> Option<Self> {
        Self::new(format!("agent/{session_id}/{agent_id}"))
    }
}

// ----------------------------------------------------------------------
// AgentState — the lifecycle state machine (spec §1)
// ----------------------------------------------------------------------

/// One state per node in the lifecycle state machine. See spec.md §1
/// transition table for legal edges and the four atomicity invariants.
///
/// Phase 7 will harden this via compile_fail + proptest. For Phase 2,
/// the variants are exactly the set spec §1 declares.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentState {
    Provisioning,
    Ready,
    Working,
    Draining,
    Snapshotting,
    ArtifactWritten,
    WipRefWritten,
    Preserved,
    MergeReady,
    /// Phase 6 — lease has been added to the merge queue and is
    /// awaiting human approval (or auto-approve if configured).
    MergeQueued,
    /// Phase 6 — merge worker is actively merging the lease's branch
    /// into base. No external mutations should touch the worktree
    /// during this state.
    Merging,
    /// Phase 6 — merge succeeded. Branch was fast-forwarded into base
    /// (or 3-way merged); subsequent transition to `Removed`/`GcDone`.
    Merged,
    /// Phase 6 half-state — merge attempt failed (conflict, secret
    /// rescan trip, push failure). Retry/abort surface for the human.
    MergeFailed { reason: String },
    /// Phase 6 — user aborted the merge from the UI. Lease remains
    /// for inspection; reaper does not GC.
    MergeAborted { reason: String },
    Removed,
    GcDone,
    PreserveFailed { reason: String },
    GcError { reason: String, retries: u32 },
}

impl AgentState {
    /// Per spec §7 + §3.4: when the supervisor is actively managing
    /// the lease in one of these states, the reaper does NOT reap on
    /// heartbeat-staleness alone; it waits for explicit handover.
    /// Required to prevent two reapers double-processing a lease
    /// whose supervisor is mid-drain.
    pub fn is_actively_managed(&self) -> bool {
        // **H1 fix per claude3 Issue 1**: include `Merged` and
        // `Removed` so the reaper does NOT claim a lease that's mid-
        // tail-cleanup in `gc_lease`/`execute_merge`. Without this,
        // a registry-contention failure between Merged and GcDone (or
        // Removed and GcDone) silently transitions the lease to
        // Draining → drainer → classify_work → Io error (worktree dir
        // gone) → infinite loop. The owning operation (drainer or
        // merge worker) must complete its tail; the reaper only takes
        // over after recovery::adopt_orphan_leases promotes them on
        // next Tauri start.
        matches!(
            self,
            AgentState::Draining
                | AgentState::Snapshotting
                | AgentState::ArtifactWritten
                | AgentState::WipRefWritten
                | AgentState::MergeReady
                | AgentState::MergeQueued
                | AgentState::Merging
                | AgentState::Merged
                | AgentState::Removed
        )
    }

    /// Terminal states per spec §1. No transitions out.
    pub fn is_terminal(&self) -> bool {
        matches!(self, AgentState::GcDone)
    }

    /// Half-states visible in UI; reaper retries idempotently per
    /// spec §1 + spec-state-diagram.md.
    pub fn is_half_state(&self) -> bool {
        matches!(
            self,
            AgentState::PreserveFailed { .. }
                | AgentState::GcError { .. }
                | AgentState::MergeFailed { .. }
                | AgentState::MergeAborted { .. }
        )
    }
}

// ----------------------------------------------------------------------
// LeaseRecord — the canonical persisted form (spec §3.1 + S5 split)
// ----------------------------------------------------------------------

/// Schema version for `LeaseRecord`. Bumped on any backward-incompatible
/// change. `RegistryStore` reads this to decide whether to migrate.
pub const REGISTRY_SCHEMA_VERSION: u32 = 1;

/// Canonical persisted form of an agent's lease. Stored at
/// `<managed_root>/registry.json` (atomic write per `RegistryStore`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeaseRecord {
    // identity
    pub session_id: String,
    pub agent_id: String,
    pub parent_agent_id: Option<String>,
    pub task_id: String,

    // git
    pub repo_root: PathBuf,
    pub base_ref: String,
    pub base_commit: String,
    pub branch_ref: BranchRef,
    pub worktree_path: WorktreePath,

    // ownership (S5 persisted slice; PID is hint, nonce is authoritative)
    pub owner_pid: i32,
    pub owner_nonce: String,
    pub owner_start_time: Option<i64>,
    pub process_group_id: Option<i32>,
    pub heartbeat_at: i64,
    pub heartbeat_timeout_secs: u32,
    pub liveness_quiescent_secs: u32,
    pub wedge_grace_secs: u32,

    // state
    pub state: AgentState,
    pub artifact_path: Option<PathBuf>,
    pub last_error: Option<String>,
    pub last_reaper_id: Option<String>,

    // metadata
    pub created_at: i64,
    pub updated_at: i64,
    pub schema_version: u32,
}

impl LeaseRecord {
    /// Default heartbeat timeout per spec §3.4.
    pub const DEFAULT_HEARTBEAT_TIMEOUT_SECS: u32 = 30;
    /// Default quiescent threshold per S4.
    pub const DEFAULT_LIVENESS_QUIESCENT_SECS: u32 = 60;
    /// Default wedge grace window per S4.
    pub const DEFAULT_WEDGE_GRACE_SECS: u32 = 30;
}

// ----------------------------------------------------------------------
// LeaseSnapshot — the UI-facing flattened view (spec §3.3)
// ----------------------------------------------------------------------

/// UI-safe flattened snapshot of a lease. Returned by
/// `query_agent_lease` Tauri command. Never includes raw PIDs/FDs/
/// absolute filesystem paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseSnapshot {
    pub agent_id: String,
    pub session_id: String,
    pub state: AgentState,
    pub branch_short: String,
    pub worktree_relative: String,
    pub heartbeat_age_secs: u32,
    pub is_alive: bool,
    pub last_error: Option<String>,
    pub artifact_present: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_root_rejects_relative() {
        assert!(ManagedRoot::new("relative/path").is_none());
        assert!(ManagedRoot::new("/abs/path").is_some());
    }

    #[test]
    fn worktree_path_must_be_under_managed_root() {
        let mr = ManagedRoot::new("/tmp/canvas").unwrap();
        // Inside worktrees dir
        assert!(WorktreePath::new(&mr, "/tmp/canvas/worktrees/agent-1").is_some());
        // Outside managed root
        assert!(WorktreePath::new(&mr, "/etc/passwd").is_none());
        // Inside managed root but not under worktrees/
        assert!(WorktreePath::new(&mr, "/tmp/canvas/quarantine/agent-1").is_none());
    }

    #[test]
    fn branch_ref_validates_namespace() {
        // valid 3-component
        assert!(BranchRef::new("agent/sess-1/agent-A").is_some());

        // F2: must be exactly 3 components
        assert!(BranchRef::new("agent/").is_none()); // 2 (with trailing empty) → also session empty
        assert!(BranchRef::new("agent//bad").is_none()); // session empty
        assert!(BranchRef::new("agent/session-only").is_none()); // 2 components
        assert!(BranchRef::new("agent/a/b/c").is_none()); // 4 components
        assert!(BranchRef::new("main").is_none()); // not in our namespace
        assert!(BranchRef::new("not-agent/a/b").is_none()); // wrong prefix

        // git refname rules at component level
        assert!(BranchRef::new("agent/sess/..").is_none()); // .. in component
        assert!(BranchRef::new("-agent/x/y").is_none()); // leading - in first component
        assert!(BranchRef::new("agent/-bad/y").is_none()); // F2 stricter: leading - in any component bad
        assert!(BranchRef::new("agent/sess/x:y").is_none()); // : not allowed
        assert!(BranchRef::new("agent/sess/foo.lock").is_none()); // F2 git rule: no .lock suffix
        assert!(BranchRef::new("agent/sess/.hidden").is_none()); // F2 git rule: no leading .
    }

    #[test]
    fn branch_ref_for_agent_helper() {
        let b = BranchRef::for_agent("sess-1", "agent-A").unwrap();
        assert_eq!(b.as_str(), "agent/sess-1/agent-A");
    }

    #[test]
    fn agent_state_actively_managed_set() {
        // Spec §7: drainer + snapshot family is actively-managed
        assert!(AgentState::Draining.is_actively_managed());
        assert!(AgentState::Snapshotting.is_actively_managed());
        assert!(AgentState::ArtifactWritten.is_actively_managed());
        assert!(AgentState::WipRefWritten.is_actively_managed());
        assert!(AgentState::MergeReady.is_actively_managed());
        // Phase 6 merge family is actively-managed (so reaper doesn't
        // double-claim during merge orchestration).
        assert!(AgentState::MergeQueued.is_actively_managed());
        assert!(AgentState::Merging.is_actively_managed());
        // **K5 fix per claude3 minor (rev-6 verification)**: H1 added
        // Merged + Removed to is_actively_managed (intermediate states
        // between successful merge/gc tail and final GcDone — reaper
        // must NOT claim them or it infinite-loops). Lock that
        // invariant in via positive assertions so a future refactor
        // can't silently regress.
        assert!(AgentState::Merged.is_actively_managed());
        assert!(AgentState::Removed.is_actively_managed());
        // Not actively-managed
        assert!(!AgentState::Working.is_actively_managed());
        assert!(!AgentState::Ready.is_actively_managed());
        assert!(!AgentState::Preserved.is_actively_managed());
    }

    #[test]
    fn agent_state_terminal_and_half_states() {
        assert!(AgentState::GcDone.is_terminal());
        assert!(!AgentState::Working.is_terminal());

        assert!(AgentState::PreserveFailed { reason: "x".into() }.is_half_state());
        assert!(AgentState::GcError {
            reason: "x".into(),
            retries: 1
        }
        .is_half_state());
        assert!(!AgentState::Working.is_half_state());
    }

    #[test]
    fn managed_root_paths_are_correct() {
        let mr = ManagedRoot::new("/tmp/canvas").unwrap();
        let agent = AgentId::new("agent-A").unwrap();
        assert_eq!(mr.registry_path(), PathBuf::from("/tmp/canvas/registry.json"));
        assert_eq!(
            mr.orchestrator_lock_path(),
            PathBuf::from("/tmp/canvas/orchestrator.lock")
        );
        assert_eq!(
            mr.lock_path_for(&agent),
            PathBuf::from("/tmp/canvas/locks/agent-A.lock")
        );
        assert_eq!(
            mr.quarantine_dir_for(&agent),
            PathBuf::from("/tmp/canvas/quarantine/agent-A")
        );
    }

    #[test]
    fn agent_id_rejects_traversal_shapes() {
        // R2: codex1 B1 — AgentId is a single safe path segment.
        assert!(AgentId::new("agent-A").is_some());
        assert!(AgentId::new("").is_none()); // empty
        assert!(AgentId::new(".").is_none()); // current-dir
        assert!(AgentId::new("..").is_none()); // parent
        assert!(AgentId::new("a/b").is_none()); // contains separator
        assert!(AgentId::new("a\\b").is_none()); // backslash
        assert!(AgentId::new("../escape").is_none()); // traversal
        assert!(AgentId::new(".hidden").is_none()); // leading .
        assert!(AgentId::new("-leading-dash").is_none()); // leading -
    }

    #[test]
    fn worktree_path_new_rejects_parent_dir_components() {
        // R2: codex1 B1 — even if a path lexically starts_with the
        // worktrees dir, a `..` component normalizes outside.
        let mr = ManagedRoot::new("/tmp/canvas").unwrap();
        // valid
        assert!(WorktreePath::new(&mr, "/tmp/canvas/worktrees/agent-A").is_some());
        // contains `..` traversal — must be rejected
        assert!(
            WorktreePath::new(&mr, "/tmp/canvas/worktrees/../quarantine/x").is_none()
        );
        assert!(
            WorktreePath::new(&mr, "/tmp/canvas/worktrees/agent-A/../../etc").is_none()
        );
    }

    #[test]
    fn worktree_path_for_agent_is_safe_by_construction() {
        let mr = ManagedRoot::new("/tmp/canvas").unwrap();
        let agent = AgentId::new("agent-A").unwrap();
        let wt = WorktreePath::for_agent(&mr, &agent);
        assert_eq!(wt.as_path(), std::path::Path::new("/tmp/canvas/worktrees/agent-A"));
    }
}
