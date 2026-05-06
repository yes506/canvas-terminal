//! FSD durable storage primitives.
//!
//! All FSD run state lives under `~/.cache/canvas-terminal/collab-memory/fsd-runs/`
//! (the *non-session* root). The FSD inbox subsystem (plan v6) lives under a
//! sibling root `~/.cache/canvas-terminal/collab-memory/inbox/`. Both are
//! structurally invisible to `clear_stale_sessions()` — that scanner only
//! matches `session-<pid>` directories per `parse_session_pid` (memory.rs:27).
//! See plan v5 §1.2 for verification.
//!
//! ## INVARIANTS
//!
//! 1. `claim_memory_file` operates ONLY on paths under `fsd-runs/`.
//!    `claim_inbox_file` (plan v6) operates ONLY on paths under `inbox/`.
//!    Both reuse the same `rename_no_replace` + `reject_symlink_components`
//!    machinery; they differ only in the scope-prefix check.
//! 2. This module is NOT exposed via `#[tauri::command]`. Both helpers are
//!    `pub(crate)`, backend-only, called by FSD orchestrator code that builds
//!    paths from typed identifiers — not from raw leader JSON.
//! 3. The atomic claim uses kernel-level no-replace rename (`renamex_np` on
//!    macOS, `renameat2` on Linux). Plain `std::fs::rename` silently overwrites
//!    on Unix — verified empirically in plan v5 §2.1.
//!
//! See plan v5 §4.1 + §5.7 for the P0 fix that motivated this module.
//! See plan v6 §2.5 for the inbox sibling primitive design rationale.

use crate::commands::memory::{get_memory_root, validate_relative_path};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Phase-2+ atomic-claim infrastructure. Phase 1 doesn't currently use the
/// pending → processing → done state machine — orchestrator writes the
/// task result directly to the task dir. The primitive remains as scaffolding
/// for Phase 2's multi-claimer dispatch coordination.
#[allow(dead_code)]
const FSD_PREFIX: &str = "fsd-runs/";

/// Inbox-subsystem scope prefix (plan v6 §2.5). All inbox claim/write paths
/// MUST start with this. Mirrors `FSD_PREFIX` for the inbox sibling primitive.
#[allow(dead_code)] // PR-1 ships the constant + claim_inbox_file; consumers land in PR-3a/PR-3b
pub(crate) const INBOX_PREFIX: &str = "inbox/";

/// Atomic claim primitive: rename `from` → `to` within `fsd-runs/`.
///
/// Both paths MUST be relative and start with `fsd-runs/`. The rename uses
/// kernel-level no-replace semantics so concurrent claimers cannot overwrite
/// each other.
///
/// Returns:
/// - `Ok(true)` — rename succeeded; caller now owns the destination path.
/// - `Ok(false)` — source did not exist (race lost; caller should pick another candidate).
/// - `Err(...)` — validation, scope, or I/O error; destination guaranteed not to exist or be overwritten.
#[allow(dead_code)] // Phase 2: orchestrator's pending→processing→done workflow
pub(crate) fn claim_memory_file(from: &str, to: &str) -> Result<bool, String> {
    if !from.starts_with(FSD_PREFIX) {
        return Err(format!("scope: source must be under {}", FSD_PREFIX));
    }
    if !to.starts_with(FSD_PREFIX) {
        return Err(format!("scope: destination must be under {}", FSD_PREFIX));
    }
    validate_relative_path(from)?;
    validate_relative_path(to)?;
    let root = get_memory_root()?;
    reject_symlink_components(&root, from)?;
    reject_symlink_components(&root, to)?;

    let from_abs = root.join(from);
    let to_abs = root.join(to);

    // Source must exist as a regular file (not symlink, not directory).
    let meta = match std::fs::symlink_metadata(&from_abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("source is a symlink".into());
    }
    if !meta.is_file() {
        return Err("source is not a regular file".into());
    }

    // Create destination parent dirs *after* validating they're symlink-free,
    // then re-check post-create in case of intervening symlink races.
    if let Some(parent_rel) = Path::new(to).parent().and_then(|p| p.to_str()) {
        if !parent_rel.is_empty() {
            std::fs::create_dir_all(root.join(parent_rel)).map_err(|e| e.to_string())?;
            reject_symlink_components(&root, parent_rel)?;
        }
    }

    rename_no_replace(&from_abs, &to_abs)
}

/// Atomic claim primitive for the inbox subsystem: rename `from` → `to`
/// within `inbox/`. Sibling of `claim_memory_file` per plan v6 §2.5.
///
/// Used for the consumer-side ownership transfer `.pending → .processing`
/// (and `.processing → .pending` on stale-claim reap). Producers do NOT
/// use this primitive — they atomic-rename from `.tmp/` directly via
/// `rename_no_replace`. See plan v6 §2.5.
///
/// Both paths MUST be relative and start with `inbox/`. The rename uses
/// the same kernel-level no-replace primitive as `claim_memory_file`,
/// so concurrent claimers cannot overwrite each other.
///
/// Returns:
/// - `Ok(true)` — rename succeeded; caller now owns the destination path.
/// - `Ok(false)` — source did not exist (race lost; caller should pick another candidate).
/// - `Err(...)` — validation, scope, or I/O error; destination guaranteed not to exist or be overwritten.
#[allow(dead_code)] // PR-3a wires consumers (poller, ack, reap)
pub(crate) fn claim_inbox_file(from: &str, to: &str) -> Result<bool, String> {
    if !from.starts_with(INBOX_PREFIX) {
        return Err(format!("scope: source must be under {}", INBOX_PREFIX));
    }
    if !to.starts_with(INBOX_PREFIX) {
        return Err(format!("scope: destination must be under {}", INBOX_PREFIX));
    }
    validate_relative_path(from)?;
    validate_relative_path(to)?;
    let root = get_memory_root()?;
    reject_symlink_components(&root, from)?;
    reject_symlink_components(&root, to)?;

    let from_abs = root.join(from);
    let to_abs = root.join(to);

    // Source must exist as a regular file (not symlink, not directory).
    let meta = match std::fs::symlink_metadata(&from_abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if meta.file_type().is_symlink() {
        return Err("source is a symlink".into());
    }
    if !meta.is_file() {
        return Err("source is not a regular file".into());
    }

    // Create destination parent dirs *after* validating they're symlink-free,
    // then re-check post-create in case of intervening symlink races.
    if let Some(parent_rel) = Path::new(to).parent().and_then(|p| p.to_str()) {
        if !parent_rel.is_empty() {
            std::fs::create_dir_all(root.join(parent_rel)).map_err(|e| e.to_string())?;
            reject_symlink_components(&root, parent_rel)?;
        }
    }

    rename_no_replace(&from_abs, &to_abs)
}

/// Walk every component of `root.join(relative)` under `root` and reject if
/// any existing component is a symlink. Components that don't exist yet are
/// fine (they'll be created safely later).
///
/// Takes `root: &Path` (vs re-deriving via `get_memory_root()`) so callers
/// can pass the same root they used for `root.join(...)` — single derivation
/// per claim, no syscall amplification (per @claude3 task-30 §4.4).
#[allow(dead_code)] // called by claim_memory_file (Phase 2 workflow)
pub(crate) fn reject_symlink_components(root: &Path, relative: &str) -> Result<(), String> {
    let mut walk = root.to_path_buf();
    for comp in Path::new(relative).components() {
        match comp {
            std::path::Component::Normal(seg) => {
                walk.push(seg);
                if let Ok(meta) = std::fs::symlink_metadata(&walk) {
                    if meta.file_type().is_symlink() {
                        return Err(format!("symlinked path component: {}", walk.display()));
                    }
                }
            }
            std::path::Component::CurDir => continue,
            // RootDir / ParentDir / Prefix should have been rejected by
            // validate_relative_path upstream; defense in depth here.
            _ => return Err(format!("disallowed path component: {:?}", comp)),
        }
    }
    Ok(())
}

/// Kernel-level no-replace rename.
///
/// `std::fs::rename` silently overwrites destinations on Unix — verified
/// empirically in plan v5 §2.1 by reproducing `mv a.txt b.txt` overwriting
/// b.txt's content. For an atomic claim primitive that arbitrates concurrent
/// claimers, only kernel-level RENAME_EXCL / RENAME_NOREPLACE is safe.
///
/// Returns:
/// - `Ok(true)` — rename succeeded.
/// - `Ok(false)` — source didn't exist (ENOENT — race lost).
/// - `Err(...)` — destination existed (EEXIST) or other I/O error.
#[allow(dead_code)] // called by claim_memory_file (Phase 2 workflow)
#[cfg(target_os = "macos")]
fn rename_no_replace(from: &Path, to: &Path) -> Result<bool, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from_c = CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to_c = CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // RENAME_EXCL: fail with EEXIST if destination exists (atomic).
    // libc::renamex_np is available on macOS 10.12+.
    let rc = unsafe { libc::renamex_np(from_c.as_ptr(), to_c.as_ptr(), libc::RENAME_EXCL) };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ENOENT) => Ok(false),
        Some(libc::EEXIST) => Err("destination already exists".into()),
        _ => Err(err.to_string()),
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(from: &Path, to: &Path) -> Result<bool, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let from_c = CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to_c = CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE) — Linux 3.15+.
    const RENAME_NOREPLACE: libc::c_uint = 1;
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from_c.as_ptr(),
            libc::AT_FDCWD,
            to_c.as_ptr(),
            RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    match err.raw_os_error() {
        Some(libc::ENOENT) => Ok(false),
        Some(libc::EEXIST) => Err("destination already exists".into()),
        _ => Err(err.to_string()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_no_replace(_from: &Path, _to: &Path) -> Result<bool, String> {
    // Phase 5 Windows support; Phase 1 is unix-only per plan v5 §11 non-goal.
    Err("FSD claim_memory_file: this OS is not supported in Phase 1".into())
}

// ---------------------------------------------------------------------------
// Typed run/task path builders (per plan v5 §5.7 / item N).
//
// The Rust orchestrator constructs claim paths from typed identifiers, NOT
// from raw leader JSON. Defense in depth: a leader cannot construct path
// strings that bypass FSD scope or the run/task hierarchy.
// ---------------------------------------------------------------------------

/// Type-safe path builder for a single FSD task within a run/turn.
///
/// Fields are PRIVATE; construct via `TaskPath::try_new(...)` so that every
/// ID is validated against `[A-Za-z0-9._-]+` (no slashes, no `..`, no empty,
/// no control chars). Without this guard, a leader-supplied `task_id` like
/// `../../foo` could escape the FSD scope (validate_relative_path would
/// catch it later, but defense in depth — the orchestrator builds these
/// paths from leader JSON and we want failure at construction, not at IPC).
/// (Per @codex2 task-42 P1.)
pub(crate) struct TaskPath<'a> {
    leader_handle: &'a str,
    run_id: &'a str,
    turn: u32,
    task_id: &'a str,
}

impl<'a> TaskPath<'a> {
    /// Construct a TaskPath, validating each identifier component.
    ///
    /// Allowed characters per ID: ASCII letters, digits, `.`, `_`, `-`.
    /// Rejects empty strings, `/`, `..`, control characters, and non-ASCII.
    pub fn try_new(
        leader_handle: &'a str,
        run_id: &'a str,
        turn: u32,
        task_id: &'a str,
    ) -> Result<Self, String> {
        validate_id_component("leader_handle", leader_handle)?;
        validate_id_component("run_id", run_id)?;
        validate_id_component("task_id", task_id)?;
        Ok(Self {
            leader_handle,
            run_id,
            turn,
            task_id,
        })
    }

    fn dir(&self) -> String {
        format!(
            "fsd-runs/{}/runs/{}/turns/{}/tasks/{}",
            self.leader_handle, self.run_id, self.turn, self.task_id
        )
    }

    pub fn pending(&self) -> String {
        format!("{}/pending.json", self.dir())
    }

    /// Phase 2: target path for `claim_memory_file(pending → processing)`.
    #[allow(dead_code)]
    pub fn processing(&self) -> String {
        format!("{}/processing.json", self.dir())
    }

    /// Phase 2: target path for `claim_memory_file(processing → done)`.
    #[allow(dead_code)]
    pub fn done(&self) -> String {
        format!("{}/done.json", self.dir())
    }
}

/// Validate an identifier intended to become a path segment. Allows the
/// minimal "URL-/filename-safe" subset: ASCII alphanumerics + `.`, `_`, `-`.
///
/// Shared between `TaskPath` (this module) and `InboxScope` (`fsd::inbox`)
/// as the single source of truth for ID component validation. Plan v6 §2.2
/// promoted this from private to `pub(crate)` so the inbox subsystem can
/// reuse it without duplicating the regex/charset rules.
pub(crate) fn validate_id_component(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{}: must not be empty", field));
    }
    // Disallow `..` even when surrounded by other allowed chars — prevents
    // `..foo` or `foo..` and the literal `..`. (validate_relative_path
    // catches the literal but a path segment containing `..` is also suspicious.)
    if value == "." || value == ".." {
        return Err(format!("{}: must not be '.' or '..'", field));
    }
    for (i, ch) in value.chars().enumerate() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-' => continue,
            _ => {
                return Err(format!(
                    "{}: invalid character {:?} at position {} (allowed: A-Z a-z 0-9 . _ -)",
                    field, ch, i
                ))
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Inbox subsystem helpers (plan v6 PR-3a).
//
// Producer write path (atomic):
//   1. seq_provider.next() → issued seq
//   2. build envelope; build_pending_filename()
//   3. tokio::fs::write inbox/<scope>/.tmp/<filename>
//   4. claim_inbox_file (rename) .tmp/ → target lane
//   5. (if Nth write) persist_seq_global_to_disk()
//
// Consumer claim path: .pending → .processing via claim_inbox_file
// Ack path: .processing/<full_filename> → .processed/<message_id>.json
//
// All paths under ${memory_root}/inbox/ (plan v6 §2.1).
// ---------------------------------------------------------------------------

use super::inbox::{
    build_pending_filename, parse_seq_from_filename, priority_for_kind, ENVELOPE_SCHEMA_VERSION,
    InboxMessage, InboxMessagePartial, InboxScope, InboxState,
};

/// Provider of monotonic sequence numbers. Implemented by `AtomicU64`
/// (the live counter on `AppState`). Trait abstraction lets tests inject
/// a deterministic provider. Plan v6 §2.6.
#[allow(dead_code)] // PR-3b/PR-4 consumers
pub(crate) trait SeqProvider: Send + Sync {
    fn next(&self) -> u64;
}

impl SeqProvider for AtomicU64 {
    fn next(&self) -> u64 {
        // Counter holds "next free"; bare fetch_add returns the issued value
        // and increments to next-next-free. NO `+ 1` here — that was the
        // off-by-one bug v6 fixed (plan v6 §2.1, claude5/codex2/codex3 v5).
        self.fetch_add(1, Ordering::SeqCst)
    }
}

/// Persist `seq_global` location relative to `${memory_root}`.
const SEQ_PERSIST_PATH_REL: &str = "inbox/.meta/seq_global.json";

/// Persist `seq_global` to disk so recovery has a fast path before scanning.
/// Plan v6 §2.12. Caller invokes after Nth successful write or on FSD-tier-off.
pub(crate) fn persist_seq_global(value: u64) -> Result<(), String> {
    let root = get_memory_root()?;
    let abs = root.join(SEQ_PERSIST_PATH_REL);
    // Defense-in-depth: validate the path-to-`.meta/` is symlink-free
    // BEFORE `create_dir_all` and AFTER (to close intervening-symlink
    // races). Per codex3 task-57 "Remaining Finding": without the
    // pre-create check, an existing symlinked prefix like `inbox -> /tmp`
    // would cause `create_dir_all` to materialize directories outside
    // the memory root as a side effect, even though the subsequent
    // file write is rejected. Per codex3 task-47 §1 + claude5 task-49
    // §2.6 for the post-create check.
    reject_symlink_components(&root, "inbox/.meta")?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    reject_symlink_components(&root, "inbox/.meta")?;

    let body = serde_json::json!({ "seq_global": value }).to_string();
    // Atomic write: random-suffixed tempfile + no-replace rename to a
    // private path, then rename over the target. The randomness prevents
    // a planted symlink from sitting at a predictable `seq_global.json.tmp`
    // path and redirecting the write (per codex3 task-52 §2). The tmp
    // file lives in the same dir as the target so rename is atomic.
    use rand::RngCore;
    let mut suffix_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut suffix_bytes);
    let suffix = hex::encode(suffix_bytes);
    let tmp = abs.with_file_name(format!(
        "{}.{}.tmp",
        abs.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("seq_global.json"),
        suffix
    ));
    // With a 64-bit random suffix, true random collision is ~1 in 2^64
    // (effectively zero). The realistic path that triggers this branch is
    // a planted symlink at the (random) tmp filename — refuse to overwrite
    // and surface the suspicion. Per claude4 task-58 §3.3 — message is
    // tightened from the prior "collision or symlink" wording to focus on
    // the real concern.
    if std::fs::symlink_metadata(&tmp).is_ok() {
        return Err(format!(
            "persist_seq_global: tmp path {} unexpectedly exists \
             (likely planted symlink — refusing to overwrite)",
            tmp.display()
        ));
    }
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    // rename overwrites the target, but the target is the canonical
    // seq_global.json — single-writer assumption documented in module-doc.
    std::fs::rename(&tmp, &abs).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the persisted `seq_global` from disk. Returns `Ok(None)` if the file
/// doesn't exist (cold first boot); `Err(...)` only on parse/IO errors.
fn read_persisted_seq_global() -> Result<Option<u64>, String> {
    let root = get_memory_root()?;
    let abs = root.join(SEQ_PERSIST_PATH_REL);
    let body = match std::fs::read_to_string(&abs) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let n = parsed
        .get("seq_global")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "missing or invalid seq_global field".to_string())?;
    Ok(Some(n))
}

/// Walk every inbox lane that uses ordered filenames (`.pending`,
/// `.processing`, `.audit`, `.failed`) and return the maximum `seq_global`
/// observed. Soft-fails to 0 on missing dirs / malformed filenames so
/// startup recovery never panics. Plan v6 §2.4.
///
/// SECURITY: per codex3 task-57 "Low-Risk Note" + claude5 task-64 §4 +
/// task-59 §4 — the prior version used `path.is_dir()` (which follows
/// symlinks), so a planted `inbox/leader-evil -> /tmp/somewhere` could
/// cause `read_dir` to walk outside the memory root and inflate
/// `seq_global` from filenames in unrelated directories. This is
/// read-only (cannot delete or write outside root), but the "for
/// consistency with the reaper/listing hardening" principle says we
/// should reject symlinked scope/lane entries. Now uses
/// `symlink_metadata` no-follow checks at every level.
fn scan_inbox_for_max_seq_global() -> Result<u64, String> {
    let root = get_memory_root()?;
    let inbox_root = root.join(INBOX_PREFIX);
    if !inbox_root.exists() {
        return Ok(0);
    }
    // Reject the entire scan if `inbox/` itself is symlinked — a planted
    // `inbox -> /tmp/somewhere` would let the recovery walk find seqs from
    // arbitrary disk locations.
    if let Ok(meta) = std::fs::symlink_metadata(&inbox_root) {
        if meta.file_type().is_symlink() {
            eprintln!(
                "fsd: scan_inbox_for_max_seq_global: inbox/ is symlinked — \
                 refusing to scan; recovery falls back to 0"
            );
            return Ok(0);
        }
    }
    let mut max_seq: u64 = 0;
    // Walk one level: each child dir is an inbox (e.g. `global`, `leader-X`).
    let entries = match std::fs::read_dir(&inbox_root) {
        Ok(it) => it,
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip the `.meta/` dir — it contains seq_global.json, not messages.
        if path.file_name().and_then(|s| s.to_str()) == Some(".meta") {
            continue;
        }
        // Use symlink_metadata (no-follow) so a symlinked scope dir is
        // skipped, not enumerated. Mirrors the `init_inbox_reapers`
        // discovery hardening from round-2.
        let entry_meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if entry_meta.file_type().is_symlink() || !entry_meta.is_dir() {
            continue;
        }
        for lane in [
            InboxState::Pending,
            InboxState::Processing,
            InboxState::Audit,
            InboxState::Failed,
        ] {
            let lane_dir = path.join(lane.dir_name());
            // Lane-level symlink check: a planted `.audit -> /etc` would
            // otherwise cause read_dir to enumerate /etc filenames. The
            // parse_seq_from_filename strict format check makes spurious
            // matches very unlikely, but the defense-in-depth principle
            // still applies (matches list_inbox_pending pattern).
            let lane_meta = match std::fs::symlink_metadata(&lane_dir) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if lane_meta.file_type().is_symlink() || !lane_meta.is_dir() {
                continue;
            }
            let lane_entries = match std::fs::read_dir(&lane_dir) {
                Ok(it) => it,
                Err(_) => continue,
            };
            for f in lane_entries.flatten() {
                let name = match f.file_name().into_string() {
                    Ok(n) => n,
                    Err(_) => continue,
                };
                if let Some(seq) = parse_seq_from_filename(&name) {
                    if seq > max_seq {
                        max_seq = seq;
                    }
                }
            }
        }
    }
    Ok(max_seq)
}

/// Recover `seq_global` from disk: prefers the persisted file's fast path,
/// falls back to (and combines with `max(...)`) the disk scan.
///
/// CRITICAL: returns `max(persisted, scanned)`, not just `persisted`.
/// Plan v6 §2.2 + codex2 task-39 §1 / codex3 task-40 §1 — persisted may
/// be stale (every-Nth-write policy), so a crash between checkpoints can
/// leave higher seqs on disk than persisted. Trusting persisted alone
/// would risk reissuing an in-use seq.
///
/// Soft-fails to 0 on any IO/parse error (warn-logged) so app startup
/// never panics. Plan v6 §2.4.
pub(crate) fn recover_seq_global() -> u64 {
    let persisted = match read_persisted_seq_global() {
        Ok(Some(n)) => n,
        Ok(None) => 0,
        Err(e) => {
            eprintln!("inbox: persisted seq_global read failed: {} (falling back)", e);
            0
        }
    };
    let scanned = match scan_inbox_for_max_seq_global() {
        Ok(n) => n,
        Err(e) => {
            eprintln!("inbox: seq_global disk scan failed: {} (falling back to 0)", e);
            0
        }
    };
    std::cmp::max(persisted, scanned)
}

/// Producer write helper. Atomically places a message into the target
/// inbox lane with orchestrator-stamped `seq_global` and `priority`.
/// Plan v6 §2.5 / §2.6.
///
/// Workflow:
///   1. Validate scope.
///   2. Get next seq from provider.
///   3. Compute filename via `build_pending_filename`.
///   4. Write payload to `.tmp/<filename>`.
///   5. `claim_inbox_file(.tmp/<filename> → <target_state>/<filename>)`.
///
/// Returns the filename written (relative form, just the basename).
///
/// Caller is responsible for periodic `persist_seq_global` calls; this
/// helper does NOT auto-persist on every write to avoid unbounded fsync
/// amplification. Plan v6 §2.12.
#[allow(dead_code)] // PR-4 consumer (orchestrator shadow-audit hook)
pub(crate) fn write_inbox_payload_atomic(
    scope: &InboxScope,
    partial: &InboxMessagePartial,
    state: InboxState,
    seq_provider: &dyn SeqProvider,
) -> Result<String, String> {
    scope.validate()?;
    if state == InboxState::Processed {
        return Err("write_inbox_payload_atomic: cannot write directly to .processed/ (use ack)".into());
    }
    if state == InboxState::Tmp {
        return Err("write_inbox_payload_atomic: target state cannot be .tmp/ (used internally)".into());
    }

    let seq = seq_provider.next();
    let priority = priority_for_kind(partial.kind);
    let envelope = InboxMessage {
        message_id: partial.message_id.clone(),
        schema: ENVELOPE_SCHEMA_VERSION,
        sender_id: partial.sender_id.clone(),
        sender_kind: partial.sender_kind,
        target_id: partial.target_id.clone(),
        kind: partial.kind,
        content: partial.content.clone(),
        created_at_ms: partial.created_at_ms,
        seq_global: seq,
        priority,
        run_id: partial.run_id.clone(),
        task_id: partial.task_id.clone(),
        turn: partial.turn,
        source_cmd_id: partial.source_cmd_id.clone(),
        sn: partial.sn.clone(),
        rn: partial.rn.clone(),
        attempt: partial.attempt,
    };
    envelope.validate()?;

    let filename = build_pending_filename(priority, seq, partial.created_at_ms, &partial.message_id);
    let tmp_rel = format!("{}/{}", scope.state_dir(InboxState::Tmp), filename);
    let target_rel = format!("{}/{}", scope.state_dir(state), filename);

    // Step 1: write payload to .tmp/.
    let root = get_memory_root()?;
    let tmp_abs = root.join(&tmp_rel);
    // Defense-in-depth: validate the .tmp/ parent path is symlink-free
    // BOTH before `create_dir_all` (to prevent directory-creation side
    // effects outside the memory root if a prefix is symlinked) AND after
    // (to close intervening-symlink races). Per codex3 task-57 "Remaining
    // Finding" (pre-create) and codex3 task-47 §1 + claude5 task-49 §2.6
    // (post-create). Without the pre-create check, a symlinked prefix
    // like `inbox -> /tmp` would cause `create_dir_all` to materialize
    // directories outside the memory root as a side effect.
    let parent_rel_opt = std::path::Path::new(&tmp_rel)
        .parent()
        .and_then(|p| p.to_str());
    if let Some(parent_rel) = parent_rel_opt {
        reject_symlink_components(&root, parent_rel)?;
    }
    if let Some(parent) = tmp_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(parent_rel) = parent_rel_opt {
        reject_symlink_components(&root, parent_rel)?;
    }
    let body = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
    std::fs::write(&tmp_abs, body).map_err(|e| e.to_string())?;

    // Step 2: atomic rename .tmp/ → target. claim_inbox_file enforces
    // no-replace + symlink rejection + scope check.
    match claim_inbox_file(&tmp_rel, &target_rel) {
        Ok(true) => {
            // Step 3: AFTER the write succeeds, persist `seq_global` every
            // Nth issued seq so cold-start recovery has a fast path. Plan
            // v6 §2.12 + post-review fix (codex2 task-51 + claude5 task-54
            // §4.2): persist must be AFTER successful write; otherwise we
            // can persist a value larger than what's actually on disk
            // (recovery's max() covers it but the comment "every Nth
            // successful write" must match the code).
            const PERSIST_EVERY_N: u64 = 10;
            if seq % PERSIST_EVERY_N == 0 {
                if let Err(e) = persist_seq_global(seq) {
                    eprintln!(
                        "fsd: persist_seq_global({}) failed: {} (recovery fallback to scan)",
                        seq, e
                    );
                }
            }
            Ok(filename)
        }
        Ok(false) => Err("write_inbox_payload_atomic: tmp file vanished mid-write".into()),
        Err(e) => {
            // Rollback: remove the orphan tmp file on failure.
            let _ = std::fs::remove_file(&tmp_abs);
            Err(e)
        }
    }
}

/// Acknowledge successful delivery: rename `.processing/<full_filename>`
/// → `.processed/<message_id>.json`. The truncation to message_id is
/// intentional — plan v6 §2.3, the dedup ledger uses cmd_id-only as its key.
#[allow(dead_code)] // PR-3b consumer
pub(crate) fn ack_inbox_message(
    scope: &InboxScope,
    full_filename: &str,
    message_id: &str,
) -> Result<bool, String> {
    scope.validate()?;
    let from = format!("{}/{}", scope.state_dir(InboxState::Processing), full_filename);
    let to = format!("{}/{}.json", scope.state_dir(InboxState::Processed), message_id);
    claim_inbox_file(&from, &to)
}

/// List `.pending/*.json` filenames in lex-sorted order. Used by pollers
/// to pick the next claim candidate. Plan v6 §2.5.
///
/// SECURITY: validates the path-to-`.pending/` is symlink-free BEFORE
/// `read_dir` (per codex3 task-52 §1). Without this, a planted symlink at
/// `inbox/leader-X/.pending -> /tmp/elsewhere` would let a poller list
/// files outside the memory root.
#[allow(dead_code)] // PR-3b consumer
pub(crate) fn list_inbox_pending(scope: &InboxScope) -> Result<Vec<String>, String> {
    scope.validate()?;
    let root = get_memory_root()?;
    let pending_rel = scope.state_dir(InboxState::Pending);
    reject_symlink_components(&root, &pending_rel)?;
    let dir_abs = root.join(&pending_rel);
    if !dir_abs.exists() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir_abs)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json"))
        .filter(|n| parse_seq_from_filename(n).is_some()) // skip malformed
        .collect();
    names.sort();
    Ok(names)
}

/// Reap `.processing/` files older than `max_age_secs` back to `.pending/`.
/// Returns the number of files moved. Used by Phase B's periodic reaper
/// task and as a startup sanity-pass. Plan v6 §2.6 retention table.
#[allow(dead_code)] // PR-3b consumer
pub(crate) fn reap_stale_inbox_claims(
    scope: &InboxScope,
    max_age_secs: u64,
) -> Result<u32, String> {
    scope.validate()?;
    reap_lane_back(scope, InboxState::Processing, InboxState::Pending, max_age_secs)
}

/// Reap (delete) `.processed/` files older than `max_age_secs`. Returns the
/// number deleted. 24h TTL by default. Plan v6 §2.6.
#[allow(dead_code)] // PR-3b consumer
pub(crate) fn reap_old_processed(scope: &InboxScope, max_age_secs: u64) -> Result<u32, String> {
    reap_lane_delete(scope, InboxState::Processed, max_age_secs)
}

/// Reap (delete) `.audit/` files older than `max_age_secs`. Returns the
/// number deleted. 7-day default for Phase A bake; deleted entirely after.
/// Plan v6 §2.10 — `.archive/` lane was dropped in v6.
#[allow(dead_code)] // PR-3b consumer
pub(crate) fn reap_old_audit(scope: &InboxScope, max_age_secs: u64) -> Result<u32, String> {
    reap_lane_delete(scope, InboxState::Audit, max_age_secs)
}

/// Internal helper: rename old files in one lane back to another. Used
/// for stale-claim recovery (`.processing/ → .pending/`).
///
/// SECURITY: validates the lane path is symlink-free BEFORE `read_dir`
/// (per codex3 task-52 §1). Without this, a planted symlink at
/// `inbox/leader-X/.processing -> /var` would let the reaper enumerate
/// files outside the memory root.
fn reap_lane_back(
    scope: &InboxScope,
    from_state: InboxState,
    to_state: InboxState,
    max_age_secs: u64,
) -> Result<u32, String> {
    let root = get_memory_root()?;
    let from_rel = scope.state_dir(from_state);
    reject_symlink_components(&root, &from_rel)?;
    let dir = root.join(&from_rel);
    if !dir.exists() {
        return Ok(0);
    }
    let now = std::time::SystemTime::now();
    let mut moved = 0u32;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let age_secs = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if age_secs < max_age_secs {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let from_rel = format!("{}/{}", scope.state_dir(from_state), name);
        let to_rel = format!("{}/{}", scope.state_dir(to_state), name);
        // Per claude5 task-49 §2.4: distinguish race-lost (silent) from real
        // errors (logged). Silent swallow of Err would hide permission /
        // scope-violation issues during mass reaping.
        match claim_inbox_file(&from_rel, &to_rel) {
            Ok(true) => moved += 1,
            Ok(false) => continue, // race lost — silent skip
            Err(e) => {
                eprintln!(
                    "fsd::reap_lane_back: claim_inbox_file({}, {}) failed: {}",
                    from_rel, to_rel, e
                );
                continue;
            }
        }
    }
    Ok(moved)
}

/// Internal helper: delete old files in one lane. Used for `.processed/`
/// + `.audit/` retention.
///
/// SECURITY: validates the lane path is symlink-free BEFORE `read_dir`
/// + `remove_file` (per codex3 task-52 §1). Without this, a planted
/// symlink at `inbox/leader-X/.audit -> /etc` would cause the reaper to
/// delete files outside the memory root.
fn reap_lane_delete(
    scope: &InboxScope,
    state: InboxState,
    max_age_secs: u64,
) -> Result<u32, String> {
    scope.validate()?;
    let root = get_memory_root()?;
    let lane_rel = scope.state_dir(state);
    reject_symlink_components(&root, &lane_rel)?;
    let dir = root.join(&lane_rel);
    if !dir.exists() {
        return Ok(0);
    }
    let now = std::time::SystemTime::now();
    let mut deleted = 0u32;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let age_secs = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if age_secs < max_age_secs {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU32;
    use std::sync::Once;

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);
    static INIT_TEST_ROOT: Once = Once::new();

    /// Set CANVAS_TERMINAL_MEMORY_ROOT to a per-test-process tempdir on first
    /// call so tests don't pollute the user's real ~/.cache. Idempotent across
    /// parallel test threads via std::sync::Once. (Per @claude3 task-43 §5.2.)
    fn ensure_test_root_isolated() {
        INIT_TEST_ROOT.call_once(|| {
            // Only override if not already set (so CI can pin its own path).
            if std::env::var("CANVAS_TERMINAL_MEMORY_ROOT").is_err() {
                let test_root = std::env::temp_dir()
                    .join(format!("canvas-terminal-fsd-test-{}", std::process::id()));
                fs::create_dir_all(&test_root).expect("create test_root");
                // SAFETY: set_var is unsafe in Rust 2024 due to env-thread-safety
                // concerns. We're calling this from std::sync::Once at test-init,
                // before any other thread reads the env var, so the race is closed.
                #[allow(unused_unsafe)]
                unsafe {
                    std::env::set_var(
                        "CANVAS_TERMINAL_MEMORY_ROOT",
                        test_root.to_string_lossy().as_ref(),
                    );
                }
            }
        });
    }

    /// Each test gets its own subdirectory under fsd-runs/ to avoid collisions
    /// when run in parallel with `cargo test` (which uses multiple threads).
    fn unique_test_prefix() -> String {
        ensure_test_root_isolated();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("fsd-runs/_test/{}-{}", std::process::id(), n)
    }

    /// Sibling of `unique_test_prefix` for the inbox-scope tests. Same
    /// per-PID + counter isolation, but rooted under `inbox/_test/` so the
    /// scope-prefix check accepts these paths.
    fn unique_inbox_test_prefix() -> String {
        ensure_test_root_isolated();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("inbox/_test/{}-{}", std::process::id(), n)
    }

    fn write_file(rel: &str, content: &str) {
        let root = get_memory_root().unwrap();
        let abs = root.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, content).unwrap();
    }

    fn cleanup(rel: &str) {
        let root = get_memory_root().unwrap();
        let _ = fs::remove_dir_all(root.join(rel));
    }

    #[test]
    fn happy_path_pending_to_processing() {
        let prefix = unique_test_prefix();
        let from = format!("{}/pending.json", prefix);
        let to = format!("{}/processing.json", prefix);
        write_file(&from, "{}");

        let result = claim_memory_file(&from, &to);
        assert_eq!(result, Ok(true));

        let root = get_memory_root().unwrap();
        assert!(!root.join(&from).exists(), "source should be gone");
        assert!(root.join(&to).exists(), "destination should exist");

        cleanup(&prefix);
    }

    #[test]
    fn missing_source_returns_ok_false() {
        let prefix = unique_test_prefix();
        let from = format!("{}/never-existed.json", prefix);
        let to = format!("{}/dest.json", prefix);

        let result = claim_memory_file(&from, &to);
        assert_eq!(result, Ok(false));

        cleanup(&prefix);
    }

    #[test]
    fn destination_exists_returns_err() {
        let prefix = unique_test_prefix();
        let from = format!("{}/pending.json", prefix);
        let to = format!("{}/processing.json", prefix);
        write_file(&from, "FROM");
        write_file(&to, "TO");

        let result = claim_memory_file(&from, &to);
        assert!(result.is_err(), "expected Err, got {:?}", result);

        // CRITICAL: destination must NOT have been overwritten (this is the
        // P0 bug from plan v5 §2.1 that std::fs::rename had).
        let root = get_memory_root().unwrap();
        let to_content = fs::read_to_string(root.join(&to)).unwrap();
        assert_eq!(to_content, "TO", "destination must not be overwritten");

        cleanup(&prefix);
    }

    #[test]
    fn scope_violation_from_rejected() {
        let result = claim_memory_file("session-1234/foo.md", "fsd-runs/dest.json");
        assert!(matches!(result, Err(ref e) if e.contains("source must be under fsd-runs/")));
    }

    #[test]
    fn scope_violation_to_rejected() {
        let result = claim_memory_file("fsd-runs/foo.json", "session-1234/dest.md");
        assert!(matches!(result, Err(ref e) if e.contains("destination must be under fsd-runs/")));
    }

    #[test]
    fn traversal_rejected() {
        let result = claim_memory_file("fsd-runs/../../etc/passwd", "fsd-runs/dest.json");
        assert!(result.is_err());
    }

    /// Regression test: v3's `reject_symlink_components` walked absolute path
    /// components from `/`, so `walk == "/"` failed `starts_with(root)` on
    /// the first iteration and rejected every valid path. v5's helper takes
    /// the relative path under a cloned root, only handling `Component::Normal`
    /// segments. (Per @claude2 task-34 §2.4.)
    #[test]
    fn regression_v3_absolute_path_bug() {
        let prefix = unique_test_prefix();
        let from = format!("{}/pending.json", prefix);
        let to = format!("{}/processing.json", prefix);
        write_file(&from, "{}");

        // The relative path here, under root, expands to an absolute path
        // like /Users/.../collab-memory/fsd-runs/_test/.../pending.json.
        // v3's reject_symlink_components(absolute) would have failed here
        // because walk = "/" doesn't start with the root path.
        // v5's reject_symlink_components(root, relative) walks under root
        // and only checks Component::Normal segments — works correctly.
        let result = claim_memory_file(&from, &to);
        assert_eq!(result, Ok(true), "v3 bug regression: should accept");

        cleanup(&prefix);
    }

    #[test]
    fn task_path_builder_shape() {
        let path = TaskPath::try_new("claude1", "abc123", 2, "t-2-a").unwrap();
        assert_eq!(
            path.pending(),
            "fsd-runs/claude1/runs/abc123/turns/2/tasks/t-2-a/pending.json"
        );
        assert_eq!(
            path.processing(),
            "fsd-runs/claude1/runs/abc123/turns/2/tasks/t-2-a/processing.json"
        );
        assert_eq!(
            path.done(),
            "fsd-runs/claude1/runs/abc123/turns/2/tasks/t-2-a/done.json"
        );
    }

    #[test]
    fn task_path_rejects_slash_in_id() {
        // Per @codex2 task-42 P1: a leader-supplied task_id with a `/` would
        // alter the directory hierarchy under fsd-runs/ even though
        // validate_relative_path passes the resulting full path.
        let result = TaskPath::try_new("claude1", "abc/../bad", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("run_id")));

        let result = TaskPath::try_new("claude1", "ok", 1, "t-1-a/escape");
        assert!(matches!(result, Err(ref e) if e.contains("task_id")));
    }

    #[test]
    fn task_path_rejects_dot_dot() {
        let result = TaskPath::try_new("..", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("leader_handle")));

        let result = TaskPath::try_new("ok", "..", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("run_id")));
    }

    #[test]
    fn task_path_rejects_empty() {
        let result = TaskPath::try_new("", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("must not be empty")));
    }

    #[test]
    fn task_path_rejects_control_chars() {
        let result = TaskPath::try_new("claude1\n", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("invalid character")));

        let result = TaskPath::try_new("ok", "ok", 1, "t-1-a\0");
        assert!(matches!(result, Err(ref e) if e.contains("invalid character")));
    }

    #[test]
    fn task_path_rejects_non_ascii() {
        // Defense in depth: filesystem nuances around UTF-8 normalization,
        // case-folding, and Windows path semantics make ASCII-only safer.
        let result = TaskPath::try_new("클로드", "ok", 1, "t-1-a");
        assert!(matches!(result, Err(ref e) if e.contains("invalid character")));
    }

    #[test]
    fn task_path_accepts_safe_chars() {
        // All of these are valid: letters, digits, dots, underscores, hyphens.
        let path = TaskPath::try_new("claude1", "run_2026-05-03.abc", 99, "t.1-a_b");
        assert!(path.is_ok());
    }

    // ---- claim_inbox_file (plan v6 PR-1) -----------------------------------

    #[test]
    fn claim_inbox_file_happy_path_pending_to_processing() {
        let prefix = unique_inbox_test_prefix();
        let from = format!("{}/.pending/msg-1.json", prefix);
        let to = format!("{}/.processing/msg-1.json", prefix);
        write_file(&from, "{}");

        let result = claim_inbox_file(&from, &to);
        assert_eq!(result, Ok(true));

        let root = get_memory_root().unwrap();
        assert!(!root.join(&from).exists(), "source should be gone");
        assert!(root.join(&to).exists(), "destination should exist");

        cleanup(&prefix);
    }

    #[test]
    fn claim_inbox_file_missing_source_returns_ok_false() {
        let prefix = unique_inbox_test_prefix();
        let from = format!("{}/.pending/never-existed.json", prefix);
        let to = format!("{}/.processing/dest.json", prefix);

        let result = claim_inbox_file(&from, &to);
        assert_eq!(result, Ok(false));

        cleanup(&prefix);
    }

    #[test]
    fn claim_inbox_file_destination_exists_returns_err() {
        // Per @codex3 task-40 §7: explicitly cover the no-overwrite invariant.
        // This is the core concurrency safety property of the primitive.
        let prefix = unique_inbox_test_prefix();
        let from = format!("{}/.pending/msg-1.json", prefix);
        let to = format!("{}/.processing/msg-1.json", prefix);
        write_file(&from, "FROM");
        write_file(&to, "TO");

        let result = claim_inbox_file(&from, &to);
        assert!(result.is_err(), "expected Err, got {:?}", result);

        // CRITICAL: destination must NOT have been overwritten.
        let root = get_memory_root().unwrap();
        let to_content = fs::read_to_string(root.join(&to)).unwrap();
        assert_eq!(to_content, "TO", "destination must not be overwritten");

        cleanup(&prefix);
    }

    #[test]
    fn claim_inbox_file_scope_violation_from_rejected() {
        // Source not under inbox/ — must reject before any I/O.
        let result = claim_inbox_file("fsd-runs/foo.json", "inbox/dest.json");
        assert!(matches!(result, Err(ref e) if e.contains("source must be under inbox/")));

        let result = claim_inbox_file("session-1234/foo.md", "inbox/dest.json");
        assert!(matches!(result, Err(ref e) if e.contains("source must be under inbox/")));
    }

    #[test]
    fn claim_inbox_file_scope_violation_to_rejected() {
        // Destination not under inbox/ — must reject.
        let result = claim_inbox_file("inbox/foo.json", "fsd-runs/dest.json");
        assert!(matches!(result, Err(ref e) if e.contains("destination must be under inbox/")));

        let result = claim_inbox_file("inbox/foo.json", "session-1234/dest.md");
        assert!(matches!(result, Err(ref e) if e.contains("destination must be under inbox/")));
    }

    #[test]
    fn claim_inbox_file_traversal_rejected() {
        // Defense-in-depth: even if the prefix passes, traversal segments
        // must be caught by validate_relative_path.
        let result = claim_inbox_file("inbox/../../etc/passwd", "inbox/dest.json");
        assert!(result.is_err());
    }

    // ---- PR-3a: write_inbox_payload_atomic, ack, recovery ---------------

    use super::super::inbox::{InboxMessagePartial, MessageKind, SenderKind};

    fn make_partial(message_id: &str) -> InboxMessagePartial {
        InboxMessagePartial {
            message_id: message_id.into(),
            sender_id: "orchestrator".into(),
            sender_kind: SenderKind::Orchestrator,
            target_id: "leader-claude1".into(),
            kind: MessageKind::IterationReport,
            content: "test report".into(),
            created_at_ms: 1_714_823_900_000,
            run_id: Some("r1".into()),
            task_id: None,
            turn: Some(3),
            source_cmd_id: None,
            sn: None,
            rn: None,
            attempt: 1,
        }
    }

    fn unique_leader_handle() -> String {
        ensure_test_root_isolated();
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("test-leader-{}-{}", std::process::id(), n)
    }

    #[test]
    fn write_inbox_payload_atomic_happy_path() {
        let handle = unique_leader_handle();
        let scope = InboxScope::Leader { handle: handle.clone() };
        let counter = AtomicU64::new(43); // simulate post-init "next free" = 43
        let partial = make_partial("0123456789abcdef");

        let filename = write_inbox_payload_atomic(&scope, &partial, InboxState::Audit, &counter)
            .expect("write should succeed");

        // Filename uses seq=43 (first fetch_add returns 43, increments to 44).
        assert!(
            filename.contains("00000000000000000043"),
            "expected seq=43 in filename, got: {}",
            filename
        );

        // Counter is now 44 ("next free").
        assert_eq!(counter.load(Ordering::SeqCst), 44);

        // The file must exist in .audit/, not in .tmp/.
        let root = get_memory_root().unwrap();
        let target_dir = root.join(scope.state_dir(InboxState::Audit));
        assert!(target_dir.join(&filename).exists());
        let tmp_dir = root.join(scope.state_dir(InboxState::Tmp));
        assert!(!tmp_dir.join(&filename).exists());

        // Cleanup
        let _ = fs::remove_dir_all(root.join(scope.relative_path()));
    }

    /// Plan v6 §2.8 regression test for the v5 off-by-one bug.
    ///
    /// Counter initialized to "max_seen + 1" (next-free) → first
    /// `seq_provider.next()` call returns max_seen + 1.
    /// If anyone reverts to `fetch_add(1) + 1`, this test fires because
    /// the issued seq would be max_seen + 2 instead.
    ///
    /// Test is isolated to a unique scope; we don't call the global
    /// `scan_inbox_for_max_seq_global` (which sees other parallel tests'
    /// state) — instead we directly construct the post-init counter value
    /// to test the increment math in isolation.
    #[test]
    fn init_then_first_write_uses_max_plus_one() {
        let handle = unique_leader_handle();
        let scope = InboxScope::Leader { handle: handle.clone() };

        // Simulate "max_seen=10" from a prior session. Init places the
        // counter at max_seen + 1 = 11 (the "next free" semantic from v6 §2.1).
        let counter = AtomicU64::new(11);

        // First write through the SeqProvider trait.
        let partial = make_partial("0123456789abcdef");
        let filename = write_inbox_payload_atomic(&scope, &partial, InboxState::Audit, &counter)
            .expect("write should succeed");

        // CRITICAL ASSERTION: first issued seq must be max_seen + 1 = 11.
        // If the off-by-one returns (e.g. fetch_add(1) + 1), this fires
        // because the filename would contain seq=12 instead of seq=11.
        assert!(
            filename.contains("00000000000000000011"),
            "off-by-one regression: expected seq=11 in filename, got: {}",
            filename
        );

        // Counter is now at 12 (next free for the second write).
        assert_eq!(counter.load(Ordering::SeqCst), 12);

        // Cleanup
        let root = get_memory_root().unwrap();
        let _ = fs::remove_dir_all(root.join(scope.relative_path()));
    }

    #[test]
    fn write_inbox_payload_atomic_rejects_processed_target() {
        // .processed/ is the dedup ledger — only ack_inbox_message writes to it.
        let scope = InboxScope::Leader { handle: unique_leader_handle() };
        let counter = AtomicU64::new(1);
        let partial = make_partial("0123456789abcdef");
        let r = write_inbox_payload_atomic(&scope, &partial, InboxState::Processed, &counter);
        assert!(r.is_err());
    }

    #[test]
    fn ack_inbox_message_truncates_filename_to_message_id() {
        let scope = InboxScope::Leader { handle: unique_leader_handle() };
        let counter = AtomicU64::new(43);
        let partial = make_partial("0123456789abcdef");

        // Producer writes to .pending/ (counter→44).
        let full_filename = write_inbox_payload_atomic(&scope, &partial, InboxState::Pending, &counter)
            .expect("write");

        // Manually move .pending → .processing (simulating consumer claim).
        let pending_rel = format!("{}/{}", scope.state_dir(InboxState::Pending), full_filename);
        let processing_rel = format!("{}/{}", scope.state_dir(InboxState::Processing), full_filename);
        assert_eq!(claim_inbox_file(&pending_rel, &processing_rel).unwrap(), true);

        // Ack: .processing/<full> → .processed/<message_id>.json
        let r = ack_inbox_message(&scope, &full_filename, "0123456789abcdef")
            .expect("ack should succeed");
        assert!(r);

        // Verify dedup-ledger filename is cmd_id-only.
        let root = get_memory_root().unwrap();
        let dedup_path = root
            .join(scope.state_dir(InboxState::Processed))
            .join("0123456789abcdef.json");
        assert!(dedup_path.exists(), "dedup ledger entry missing");

        // Original full-filename path no longer exists.
        let orig_processing = root.join(&processing_rel);
        assert!(!orig_processing.exists());

        // Cleanup
        let _ = fs::remove_dir_all(root.join(scope.relative_path()));
    }

    #[test]
    fn list_inbox_pending_lex_sorts_and_skips_malformed() {
        let scope = InboxScope::Leader { handle: unique_leader_handle() };
        let counter = AtomicU64::new(43);

        // Write 3 messages with different priorities. `turn` invariant: only
        // IterationReport carries `turn`; clear it when changing kind.
        let p_low = make_partial("0000000000000001");
        let mut p_high = make_partial("0000000000000002");
        p_high.kind = MessageKind::Control; // priority 9 → priority_inv 0 → sorts first
        p_high.turn = None; // Control must NOT carry turn (envelope invariant)
        let p_mid = make_partial("0000000000000003");

        write_inbox_payload_atomic(&scope, &p_low, InboxState::Pending, &counter).unwrap();
        write_inbox_payload_atomic(&scope, &p_high, InboxState::Pending, &counter).unwrap();
        write_inbox_payload_atomic(&scope, &p_mid, InboxState::Pending, &counter).unwrap();

        // Drop a malformed file in .pending/ — must be skipped silently.
        let root = get_memory_root().unwrap();
        let pending_dir = root.join(scope.state_dir(InboxState::Pending));
        std::fs::write(pending_dir.join("garbage-not-a-real-filename.json"), "{}").unwrap();

        let names = list_inbox_pending(&scope).expect("list");
        assert_eq!(names.len(), 3, "should return 3 valid msgs (skip 1 malformed)");

        // Lex sort = priority DESC: Control (priority_inv=0) sorts BEFORE
        // IterationReport (priority_inv=4).
        assert!(names[0].starts_with("0-"), "highest priority sorts first, got: {}", names[0]);

        let _ = fs::remove_dir_all(root.join(scope.relative_path()));
    }

    /// Per claude5 task-49 §2.7: the original "returns_zero_on_empty_inbox"
    /// test couldn't actually verify zero (other parallel tests pollute the
    /// inbox tree). Renamed to match what it actually proves: scan completes
    /// without panic on a populated tree, returning a u64.
    #[test]
    fn scan_inbox_for_max_seq_global_does_not_panic() {
        let _scanned = scan_inbox_for_max_seq_global().expect("scan must not panic");
    }

    #[test]
    fn recover_seq_global_takes_max_persisted_or_scanned() {
        // CRITICAL: isolate to test temp root (must come before lock).
        ensure_test_root_isolated();
        // Critical correctness invariant per plan v6 §2.2.
        // Serialize on the shared module-level META_FILE_LOCK.
        // Recover poisoned lock so a prior test panic doesn't cascade.
        let _guard = META_FILE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Sub-test: persisted > scanned → use persisted (the fast-path case).
        persist_seq_global(999_999).expect("persist");
        let r = recover_seq_global();
        assert!(
            r >= 999_999,
            "recovery must be >= persisted value, got {}",
            r
        );

        // Cleanup so other tests start clean.
        let root = get_memory_root().unwrap();
        let _ = std::fs::remove_file(root.join(SEQ_PERSIST_PATH_REL));
    }

    /// Plan v6 §2.2 inverse direction (codex3 task-47 §3): the actual v5/v6
    /// bug was scanned > persisted. A regression that drops the
    /// `max(persisted, scanned)` invariant in favor of "persisted only"
    /// would not be caught by `recover_seq_global_takes_max_persisted_or_scanned`
    /// (which only proves persisted-high). This test seeds a real `.audit/`
    /// file with a known seq, persists a LOWER value, and asserts recovery
    /// returns the higher (scanned) value.
    #[test]
    fn recover_seq_global_inverse_scanned_higher_than_persisted() {
        ensure_test_root_isolated();
        let _guard = META_FILE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Seed `.audit/` with a file whose seq=12345 via the production
        // write helper. After the write, counter is at 12346 (post-increment).
        let leader_handle = format!("test-recover-inverse-{}", std::process::id());
        let scope = InboxScope::Leader { handle: leader_handle.clone() };
        let counter = AtomicU64::new(12345);
        let partial = make_partial("0123456789abcdef");
        write_inbox_payload_atomic(&scope, &partial, InboxState::Audit, &counter)
            .expect("seed write");

        // Persist a LOWER value than the seeded file's seq. Note: the
        // write_inbox_payload_atomic call above persisted at seq%10==0 (which
        // is 12345 → not %10, no persist). We force a low value here to set
        // up the inverse condition.
        persist_seq_global(100).expect("persist");

        // Recovery must return max(persisted=100, scanned=12345) = 12345.
        let recovered = recover_seq_global();
        assert!(
            recovered >= 12345,
            "recovery returned {} but seeded scan max was 12345 (persisted=100). \
             max(persisted, scanned) invariant violated.",
            recovered
        );

        // Cleanup
        let root = get_memory_root().unwrap();
        let _ = std::fs::remove_dir_all(root.join(scope.relative_path()));
        let _ = std::fs::remove_file(root.join(SEQ_PERSIST_PATH_REL));
    }

    /// Module-level lock for tests that touch the shared
    /// `${memory_root}/inbox/.meta/seq_global.json` path. Multiple tests
    /// race-delete each other's state otherwise under `cargo test`'s
    /// parallel runner. Both `persist_seq_global_lifecycle` and
    /// `recover_seq_global_takes_max_persisted_or_scanned` acquire this.
    static META_FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Single test owns the meta file lifecycle (persist + read + delete +
    /// missing-returns-None) so parallel tests don't race on the shared
    /// `${memory_root}/inbox/.meta/seq_global.json` path.
    #[test]
    fn persist_seq_global_lifecycle() {
        // CRITICAL: must isolate to the test temp root, otherwise this test
        // would touch the real ~/.cache/canvas-terminal/. See
        // `ensure_test_root_isolated` for the env-var override pattern.
        ensure_test_root_isolated();

        // Lock is poisoned if a prior test panicked while holding it; use
        // `unwrap_or_else` to recover the inner guard so this test still
        // runs after a poison event in another test.
        let _guard = META_FILE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Start clean — prior tests may have left the meta file in any state.
        let root = get_memory_root().unwrap();
        let abs = root.join(SEQ_PERSIST_PATH_REL);
        let _ = std::fs::remove_file(&abs);
        // Also remove the .json.tmp file in case persist crashed mid-way.
        let tmp = abs.with_file_name(format!(
            "{}.tmp",
            abs.file_name().and_then(|s| s.to_str()).unwrap()
        ));
        let _ = std::fs::remove_file(&tmp);

        let value = 12345;
        persist_seq_global(value).expect("persist");
        let read = read_persisted_seq_global()
            .expect("read")
            .expect("file should exist after persist");
        assert_eq!(read, value);

        // Now verify missing → None. Use .expect so silent failure is visible.
        std::fs::remove_file(&abs)
            .map_err(|e| format!("failed to remove {}: {}", abs.display(), e))
            .unwrap();
        let r = read_persisted_seq_global().expect("read");
        assert_eq!(r, None);
    }

    // ---- Symlink-defense regression battery (plan v6 round-5 finalization)
    //
    // Per codex3 task-67 §"Remaining non-blockers" + claude5 task-69 §5:
    // the implementation now has 8 distinct symlink-defense sites across
    // producer/consumer/listing/reaping/recovery paths (see claude5 task-69
    // §2 for the full table). None had a direct unit test. This battery
    // plants a symlink at known points and verifies the defense triggers
    // WITHOUT following the link — closes the regression-protection gap
    // before Phase B begins adding new code paths that interact with the
    // inbox tree.
    //
    // Approach: each test creates a temp dir scoped under
    // `inbox/_test/<pid>/<n>` (uses `unique_inbox_test_prefix`), plants a
    // symlink to `/tmp/canvas-terminal-symlink-target-<pid>-<n>` (must
    // NOT be touched by any defense), invokes the defense site, and
    // asserts (a) the defense rejected/skipped, (b) the planted target
    // path is unmodified.

    #[cfg(unix)]
    fn make_symlink_target() -> std::path::PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let target = std::env::temp_dir().join(format!(
            "canvas-terminal-symlink-target-{}-{}",
            std::process::id(),
            n
        ));
        // Pre-create as an empty dir so symlink creation is deterministic;
        // the defenses must NOT add any file to this directory.
        let _ = std::fs::remove_dir_all(&target);
        fs::create_dir_all(&target).expect("create symlink target");
        target
    }

    #[cfg(unix)]
    fn assert_target_untouched(target: &std::path::Path) {
        // The target must remain empty — no defense site may have written
        // through the symlink. If the planted target has any entries, a
        // defense regressed and followed the link.
        let entries: Vec<_> = std::fs::read_dir(target)
            .expect("target dir readable")
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            entries.is_empty(),
            "symlink target {} was modified ({} entries) — defense regressed",
            target.display(),
            entries.len()
        );
    }

    /// `claim_inbox_file` must reject a symlinked source path component,
    /// not follow it. Plan v6 round-1 +.
    #[cfg(unix)]
    #[test]
    fn symlink_defense_claim_inbox_file_rejects_symlinked_source() {
        let prefix = unique_inbox_test_prefix();
        let target = make_symlink_target();
        let root = get_memory_root().unwrap();
        // Plant a symlink at inbox/_test/.../scope -> /tmp/...
        let scope_rel = format!("{}/scope", prefix);
        let scope_abs = root.join(&scope_rel);
        fs::create_dir_all(scope_abs.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&target, &scope_abs).expect("symlink");

        let from = format!("{}/file.json", scope_rel);
        let to = format!("{}/file.processed.json", prefix);
        let result = claim_inbox_file(&from, &to);
        assert!(result.is_err(), "expected Err on symlinked source");
        assert_target_untouched(&target);

        let _ = fs::remove_file(&scope_abs);
        let _ = fs::remove_dir_all(&target);
        cleanup(&prefix);
    }

    /// `write_inbox_payload_atomic` must reject a symlinked `.tmp/`
    /// parent BEFORE `create_dir_all` and after. Closes codex3 task-57
    /// "Remaining Finding" with a direct regression test.
    #[cfg(unix)]
    #[test]
    fn symlink_defense_producer_rejects_symlinked_tmp_parent() {
        ensure_test_root_isolated();
        let target = make_symlink_target();
        let root = get_memory_root().unwrap();

        // Create a unique scope and plant a symlink at scope/.tmp -> target.
        // Use a scope under inbox/_test/<pid>/<n>/scope so we can construct
        // an InboxScope::Leader whose state_dir(InboxState::Tmp) is exactly
        // the symlinked path.
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let handle = format!("symlinkdef-{}-{}", std::process::id(), n);
        let scope = InboxScope::Leader { handle: handle.clone() };
        let scope_dir_rel = scope.relative_path();
        let tmp_dir_rel = scope.state_dir(InboxState::Tmp);
        let scope_dir_abs = root.join(&scope_dir_rel);
        fs::create_dir_all(&scope_dir_abs).expect("create scope dir");
        let tmp_dir_abs = root.join(&tmp_dir_rel);
        std::os::unix::fs::symlink(&target, &tmp_dir_abs).expect("symlink .tmp");

        let counter = AtomicU64::new(1);
        let partial = make_partial("0123456789abcdef");
        let result = write_inbox_payload_atomic(&scope, &partial, InboxState::Audit, &counter);
        assert!(
            result.is_err(),
            "expected Err on symlinked .tmp/ parent, got {:?}",
            result
        );
        assert_target_untouched(&target);

        // Cleanup
        let _ = fs::remove_file(&tmp_dir_abs);
        let _ = fs::remove_dir_all(&target);
        let _ = fs::remove_dir_all(&scope_dir_abs);
    }

    /// `persist_seq_global` must reject a symlinked `inbox/.meta` parent.
    /// Closes codex3 task-57 §1 with a direct test.
    #[cfg(unix)]
    #[test]
    fn symlink_defense_persist_seq_global_rejects_symlinked_meta() {
        ensure_test_root_isolated();
        let _guard = META_FILE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let target = make_symlink_target();
        let root = get_memory_root().unwrap();
        let inbox_abs = root.join("inbox");
        fs::create_dir_all(&inbox_abs).expect("create inbox");
        let meta_abs = inbox_abs.join(".meta");
        // Remove any prior real `.meta` first
        let _ = fs::remove_dir_all(&meta_abs);
        let _ = fs::remove_file(&meta_abs);
        std::os::unix::fs::symlink(&target, &meta_abs).expect("symlink .meta");

        let result = persist_seq_global(7777);
        assert!(
            result.is_err(),
            "expected Err on symlinked inbox/.meta, got {:?}",
            result
        );
        assert_target_untouched(&target);

        // Cleanup
        let _ = fs::remove_file(&meta_abs);
        let _ = fs::remove_dir_all(&target);
    }

    /// `list_inbox_pending` must reject a symlinked lane path.
    #[cfg(unix)]
    #[test]
    fn symlink_defense_list_inbox_pending_rejects_symlinked_lane() {
        ensure_test_root_isolated();
        let target = make_symlink_target();
        let root = get_memory_root().unwrap();

        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let handle = format!("symlinkdef-list-{}-{}", std::process::id(), n);
        let scope = InboxScope::Leader { handle: handle.clone() };
        let pending_dir_rel = scope.state_dir(InboxState::Pending);
        let pending_abs = root.join(&pending_dir_rel);
        // Create the parent (scope dir) then symlink the .pending child.
        fs::create_dir_all(pending_abs.parent().unwrap()).expect("create parent");
        std::os::unix::fs::symlink(&target, &pending_abs).expect("symlink .pending");

        let result = list_inbox_pending(&scope);
        assert!(
            result.is_err(),
            "expected Err on symlinked .pending lane, got {:?}",
            result
        );
        assert_target_untouched(&target);

        // Cleanup
        let _ = fs::remove_file(&pending_abs);
        let _ = fs::remove_dir_all(&target);
        let _ = fs::remove_dir_all(root.join(scope.relative_path()));
    }

    /// `scan_inbox_for_max_seq_global` must skip a symlinked scope and
    /// not follow it. Recovery should soft-fall to whatever the rest of
    /// the tree provides (or 0). Closes codex3 task-67 §1 with a direct
    /// regression test for the round-5 fix.
    #[cfg(unix)]
    #[test]
    fn symlink_defense_scan_skips_symlinked_scope() {
        ensure_test_root_isolated();
        let target = make_symlink_target();
        // Pre-populate the target with what would otherwise be a high seq
        // filename — if the scan followed the symlink, it would set
        // seq_global to this value.
        fs::write(
            target.join("0-99999999999999999999-9999999999999-deadbeefdeadbeef.json"),
            "{}",
        )
        .expect("seed bait file");

        let root = get_memory_root().unwrap();
        let inbox_abs = root.join("inbox");
        fs::create_dir_all(&inbox_abs).expect("create inbox");
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let scope_name = format!("leader-symlinkbait-{}-{}", std::process::id(), n);
        let scope_abs = inbox_abs.join(&scope_name);
        // Remove anything at that path then create symlink.
        let _ = fs::remove_dir_all(&scope_abs);
        let _ = fs::remove_file(&scope_abs);
        std::os::unix::fs::symlink(&target, &scope_abs).expect("symlink scope");

        // Scan must NOT pick up the bait seq (would be ~10^19).
        let scanned = scan_inbox_for_max_seq_global().expect("scan");
        assert!(
            scanned < 99_999_999_999_999_999_99u64 / 1000,
            "scan followed symlink and picked up bait seq {}",
            scanned
        );

        // Cleanup
        let _ = fs::remove_file(&scope_abs);
        let _ = fs::remove_dir_all(&target);
    }

    /// Regression guard per plan v5 §5.7 / item L (raised by @codex2 task-35
    /// + @claude2 task-41 §2.2): `claim_memory_file` MUST stay backend-only.
    /// If a future PR accidentally adds the Tauri command attribute above the
    /// function or registers it via `tauri::generate_handler!`, this fails.
    ///
    /// Walks lines and skips doc comments / regular comments so the test
    /// doesn't self-match its own description text or the module's INVARIANTS
    /// doc-block.
    #[test]
    fn claim_memory_file_is_not_a_tauri_command() {
        // CARGO_MANIFEST_DIR points to src-tauri/.
        let manifest = std::env::var("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR must be set during tests");

        // Build the attribute pattern at runtime to keep the literal off the
        // `storage.rs` page entirely (avoids self-match even outside comments).
        let attr_pattern = format!("#[{}::{}]", "tauri", "command");

        // Check 1: storage.rs has no Tauri-command attribute on any
        // non-comment line.
        let storage_src = std::fs::read_to_string(format!("{}/src/fsd/storage.rs", manifest))
            .expect("storage.rs readable");
        for (lineno, line) in storage_src.lines().enumerate() {
            let trimmed = line.trim_start();
            // Skip line comments + doc comments + module doc-comments.
            if trimmed.starts_with("//") {
                continue;
            }
            assert!(
                !line.contains(&attr_pattern),
                "storage.rs:{}: must not contain a Tauri command attribute on a code line — \
                 the FSD claim helper is backend-only",
                lineno + 1
            );
        }

        // Check 2: lib.rs's invoke_handler! does not name the FSD claim
        // helper. Same comment-skip discipline.
        let lib_src =
            std::fs::read_to_string(format!("{}/src/lib.rs", manifest)).expect("lib.rs readable");
        let fn_name = concat!("claim_memo", "ry_file"); // avoid literal self-match
        let inbox_fn_name = concat!("claim_inbo", "x_file"); // sibling primitive (plan v6 PR-1)
        for (lineno, line) in lib_src.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") {
                continue;
            }
            assert!(
                !line.contains(fn_name),
                "lib.rs:{}: must not reference the FSD claim helper",
                lineno + 1
            );
            assert!(
                !line.contains(inbox_fn_name),
                "lib.rs:{}: must not reference the inbox claim helper",
                lineno + 1
            );
        }
    }
}
