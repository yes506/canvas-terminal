// Worktree subsystem — registry persistence layer
//
// Crash-safe storage of LeaseRecords at <managed_root>/registry.json.
// Per spec §3.1 + plan rev-2 R-T2 §codex2 #3:
//   - atomic write via tempfile + rename + fsync
//   - schema_version field for future migrations
//   - flock-protected single-writer access via registry.lock
//
// This module is the lowest-level disk layer. `Registry` (in
// `registry.rs`) wraps this with CRUD semantics + reconciliation.

use crate::worktree::types::{LeaseRecord, ManagedRoot, REGISTRY_SCHEMA_VERSION};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

/// On-disk schema. Versioned at the document level so we can migrate
/// between schema versions without touching individual records.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryDocument {
    schema_version: u32,
    leases: HashMap<String, LeaseRecord>, // key = agent_id
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            leases: HashMap::new(),
        }
    }
}

/// Errors from the persistence layer.
#[derive(Debug)]
pub enum RegistryStoreError {
    Io(io::Error),
    Json(serde_json::Error),
    LockBusy,
    SchemaMigrationNeeded { from: u32, to: u32 },
    /// Tried to insert a lease whose `agent_id` is already present.
    /// Per F1 verifier convergence (5/5): insert MUST fail-closed on
    /// collision (vs the old silent-overwrite that would orphan the
    /// existing lease).
    LeaseAlreadyExists(String),
    /// Tried to mutate a lease that no longer exists. Caller likely
    /// lost a race with the reaper. Per F1 verifier convergence (4/5).
    LeaseNotFound(String),
}

impl std::fmt::Display for RegistryStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryStoreError::Io(e) => write!(f, "io error: {e}"),
            RegistryStoreError::Json(e) => write!(f, "json error: {e}"),
            RegistryStoreError::LockBusy => write!(f, "registry.lock held by another writer"),
            RegistryStoreError::SchemaMigrationNeeded { from, to } => {
                write!(f, "registry schema {from} requires migration to {to}")
            }
            RegistryStoreError::LeaseAlreadyExists(id) => {
                write!(f, "lease '{id}' already exists in registry")
            }
            RegistryStoreError::LeaseNotFound(id) => {
                write!(f, "lease '{id}' not found in registry")
            }
        }
    }
}

impl std::error::Error for RegistryStoreError {}

impl From<io::Error> for RegistryStoreError {
    fn from(e: io::Error) -> Self {
        RegistryStoreError::Io(e)
    }
}

impl From<serde_json::Error> for RegistryStoreError {
    fn from(e: serde_json::Error) -> Self {
        RegistryStoreError::Json(e)
    }
}

pub type Result<T> = std::result::Result<T, RegistryStoreError>;

/// Disk-backed registry store. Each call internally acquires the
/// `registry.lock` flock to ensure single-writer semantics; readers
/// can run lock-free against a stale snapshot if performance demands
/// it (Phase 2 keeps it simple — all access is locked).
pub struct RegistryStore {
    root: ManagedRoot,
}

impl RegistryStore {
    pub fn new(root: ManagedRoot) -> Self {
        Self { root }
    }

    /// Read the full registry document. Returns an empty document
    /// if `registry.json` does not exist yet (cold start).
    pub fn read_all(&self) -> Result<HashMap<String, LeaseRecord>> {
        let _guard = self.acquire_write_lock()?;
        let path = self.root.registry_path();
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let doc = read_json::<RegistryDocument>(&path)?;
        if doc.schema_version != REGISTRY_SCHEMA_VERSION {
            return Err(RegistryStoreError::SchemaMigrationNeeded {
                from: doc.schema_version,
                to: REGISTRY_SCHEMA_VERSION,
            });
        }
        Ok(doc.leases)
    }

    /// Write the full registry document atomically (tempfile + rename
    /// + fsync). Used by `Registry` when it needs a multi-record
    ///   transactional update.
    pub fn write_all(&self, leases: &HashMap<String, LeaseRecord>) -> Result<()> {
        let _guard = self.acquire_write_lock()?;
        let doc = RegistryDocument {
            schema_version: REGISTRY_SCHEMA_VERSION,
            leases: leases.clone(),
        };
        atomic_write_json(&self.root.registry_path(), &doc)
    }

    /// Convenience: read, mutate, write — all under a single lock.
    /// The closure may return an error to abort the transaction without
    /// writing (per F1 verifier convergence: callers need to surface
    /// uniqueness/missing-record violations).
    pub fn update<F>(&self, mutate: F) -> Result<()>
    where
        F: FnOnce(&mut HashMap<String, LeaseRecord>) -> Result<()>,
    {
        let _guard = self.acquire_write_lock()?;
        let path = self.root.registry_path();
        let mut leases = if path.exists() {
            let doc = read_json::<RegistryDocument>(&path)?;
            if doc.schema_version != REGISTRY_SCHEMA_VERSION {
                return Err(RegistryStoreError::SchemaMigrationNeeded {
                    from: doc.schema_version,
                    to: REGISTRY_SCHEMA_VERSION,
                });
            }
            doc.leases
        } else {
            HashMap::new()
        };

        mutate(&mut leases)?;

        let doc = RegistryDocument {
            schema_version: REGISTRY_SCHEMA_VERSION,
            leases,
        };
        atomic_write_json(&self.root.registry_path(), &doc)
    }

    /// Acquire the registry write lock. Caller must hold the returned
    /// guard for the duration of the read+write transaction. flock is
    /// released when the guard drops (RAII per spike 1 / E1 fix).
    ///
    /// Retry note: on macOS under heavy parallel I/O, fs2's
    /// `try_lock_exclusive` (which delegates to BSD `flock(2)`) can
    /// return `EWOULDBLOCK` even on a freshly-opened FD pointing at
    /// a file no other process holds. This appears to be a kernel
    /// timing artifact unrelated to our own lock holders. A short
    /// retry loop with exponential backoff absorbs the spurious
    /// failures without masking real contention (real contention
    /// stays held for milliseconds-to-seconds, well beyond our budget).
    fn acquire_write_lock(&self) -> Result<RegistryWriteLock> {
        let path = self.root.registry_lock_path();
        let mut delay_us = 100u64;
        for attempt in 0..8 {
            let file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .open(&path)?;
            if file.try_lock_exclusive().is_ok() {
                return Ok(RegistryWriteLock { _file: file });
            }
            if attempt < 7 {
                std::thread::sleep(std::time::Duration::from_micros(delay_us));
                delay_us = (delay_us * 2).min(10_000);
            }
        }
        Err(RegistryStoreError::LockBusy)
    }
}

/// RAII guard. Drop releases the registry.lock flock.
pub struct RegistryWriteLock {
    _file: File,
}

// ----------------------------------------------------------------------
// I/O helpers
// ----------------------------------------------------------------------

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let mut file = File::open(path)?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    Ok(serde_json::from_str(&buf)?)
}

/// Atomic write: write to sibling tempfile → fsync → rename.
/// Per plan rev-3 P1.2: production atomic write uses raw
/// `std::fs::rename` + fsync rather than the `tempfile` crate (which
/// is dev-dep-only).
fn atomic_write_json<T: Serialize>(target: &Path, value: &T) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| io::Error::other("target has no parent"))?;
    std::fs::create_dir_all(parent)?;

    let json = serde_json::to_string_pretty(value)?;

    // Sibling tempfile name. Per-PID + nonce avoids collision with
    // a sibling instance writing concurrently (though flock should
    // prevent that anyway; defense in depth).
    let tmp_name = format!(
        ".{file}.tmp-{pid}-{nonce}",
        file = target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("registry"),
        pid = std::process::id(),
        nonce = rand::random::<u32>(),
    );
    let tmp_path = parent.join(tmp_name);

    {
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
    }

    // rename() is atomic on POSIX
    std::fs::rename(&tmp_path, target)?;

    // fsync the parent dir so the rename is persistent. macOS doesn't
    // require this for crash-consistency in the same way Linux does,
    // but it's correct on both.
    if let Ok(dir) = OpenOptions::new().read(true).open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::managed_root::ensure_layout;
    use crate::worktree::types::{AgentState, BranchRef, WorktreePath};

    fn fresh_store() -> (tempfile::TempDir, RegistryStore) {
        let tmp = tempfile::tempdir().unwrap();
        let root = ManagedRoot::new(tmp.path()).unwrap();
        ensure_layout(&root).unwrap();
        let store = RegistryStore::new(root);
        (tmp, store)
    }

    fn sample_lease(id: &str) -> LeaseRecord {
        let tmp_root = ManagedRoot::new("/tmp/canvas-test").unwrap();
        LeaseRecord {
            session_id: "sess-1".into(),
            agent_id: id.into(),
            parent_agent_id: None,
            task_id: "task-1".into(),
            repo_root: "/tmp/repo".into(),
            base_ref: "refs/heads/main".into(),
            base_commit: "deadbeef".into(),
            branch_ref: BranchRef::for_agent("sess-1", id).unwrap(),
            worktree_path: WorktreePath::new(
                &tmp_root,
                tmp_root.worktrees_dir().join(id),
            )
            .unwrap(),
            owner_pid: 12345,
            owner_nonce: "nonce-abc".into(),
            owner_start_time: Some(1234567890),
            process_group_id: Some(12345),
            heartbeat_at: 1234567890,
            heartbeat_timeout_secs: LeaseRecord::DEFAULT_HEARTBEAT_TIMEOUT_SECS,
            liveness_quiescent_secs: LeaseRecord::DEFAULT_LIVENESS_QUIESCENT_SECS,
            wedge_grace_secs: LeaseRecord::DEFAULT_WEDGE_GRACE_SECS,
            state: AgentState::Working,
            artifact_path: None,
            last_error: None,
            last_reaper_id: None,
            created_at: 1234567890,
            updated_at: 1234567890,
            schema_version: REGISTRY_SCHEMA_VERSION,
        }
    }

    #[test]
    fn cold_start_returns_empty() {
        let (_tmp, store) = fresh_store();
        let leases = store.read_all().unwrap();
        assert!(leases.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let (_tmp, store) = fresh_store();
        let lease = sample_lease("agent-A");
        let mut map = HashMap::new();
        map.insert(lease.agent_id.clone(), lease.clone());
        store.write_all(&map).unwrap();

        let read = store.read_all().unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read.get("agent-A").unwrap(), &lease);
    }

    #[test]
    fn update_closure_runs_under_lock() {
        let (_tmp, store) = fresh_store();
        store.update(|leases| {
            leases.insert("agent-A".into(), sample_lease("agent-A"));
            Ok(())
        }).unwrap();
        store.update(|leases| {
            leases.insert("agent-B".into(), sample_lease("agent-B"));
            Ok(())
        }).unwrap();

        let read = store.read_all().unwrap();
        assert_eq!(read.len(), 2);
    }

    #[test]
    fn update_closure_can_abort_with_error() {
        // F1 fix: closure can return Err to abort the transaction.
        let (_tmp, store) = fresh_store();
        let result = store.update(|_leases| {
            Err(RegistryStoreError::LeaseAlreadyExists("agent-X".into()))
        });
        assert!(matches!(result, Err(RegistryStoreError::LeaseAlreadyExists(_))));
        // Verify nothing was written (closure returned Err before the write)
        let read = store.read_all().unwrap();
        assert!(read.is_empty());
    }

    #[test]
    fn atomic_write_does_not_corrupt_on_partial_failure() {
        // Simulate a partial write by writing a valid registry, then
        // pre-creating a leftover .tempXXX file in the parent — the
        // atomic-write should not be confused by stale tempfiles.
        let (_tmp, store) = fresh_store();
        let map: HashMap<String, LeaseRecord> = HashMap::new();
        store.write_all(&map).unwrap();

        // Drop a stale tempfile in the registry dir
        let stale =
            store.root.as_path().join(".registry.json.stale-tmp");
        std::fs::write(&stale, "garbage").unwrap();

        // Subsequent writes should still succeed
        store.write_all(&map).unwrap();
        let read = store.read_all().unwrap();
        assert!(read.is_empty());
    }
}
