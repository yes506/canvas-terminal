// Rust side of the resilience-recovery contract (webcontent-death-recovery).
//
// The FE layer (src/lib/resilience/, landed at 48b4f7f) already invokes every
// command in this module; the serde shapes are pinned by
// src/lib/resilience/types.ts (camelCase on the wire). This module supplies:
//
//   - a PID-stable durable store at
//     `~/.cache/canvas-terminal/resilience/session-<pid>/` — deliberately a
//     DIFFERENT root than collab-memory, so the window-close wipe
//     (`memory::clear_process_memory_root()`) never touches it, and a webview
//     reload (PID unchanged — jetsam kills only the WebContent helper) reads
//     the same directory it wrote;
//   - the durable heartbeat / launch-generation / death-evidence trio that
//     lets a FRESH JS context learn its predecessor died (the in-memory
//     heartbeat dies with the context — IWebContentWatchdog contract);
//   - the durable recovery-session store (persist/load/claim/clear) that
//     carries recovery INTENT across the reload;
//   - the topology snapshot store (opaque JSON — the FE owns the schema);
//   - the focus-probe watchdog + A-path death handler: on window focus, eval
//     `window.__ct_probe?.()` (which triggers an immediate FE heartbeat — no
//     extra IPC), and if the durable last-beat does not advance within the
//     probe timeout while the gap exceeds the death threshold, record
//     observedTermination, mint the recovery session (dead JS cannot mint —
//     "or by Rust on the A path" per the system design) and reload the
//     webview. `WKWebView.reload()` restarts a dead WebContent process.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use super::memory;

/// Watchdog thresholds — plan Q2 defaults ("adjust empirically; constants in
/// one place"). The probe timeout is how long the eval'd `__ct_probe` beat may
/// take to land; the gap threshold mirrors
/// `resilienceConfig.deathSuspicionThresholdMs` on the FE side.
const PROBE_TIMEOUT_MS: u64 = 3_000;
const DEATH_GAP_THRESHOLD_MS: i64 = 10_000;
/// Clamp bounds for the FE-supplied recovery-session TTL (plan node 5).
const TTL_MIN_MS: i64 = 1_000;
const TTL_MAX_MS: i64 = 24 * 60 * 60 * 1_000;

const WATCHDOG_FILE: &str = "watchdog.json";
const RECOVERY_SESSION_FILE: &str = "recovery-session.json";
const TOPOLOGY_FILE: &str = "topology.json";

// ---------------------------------------------------------------------------
// Durable store primitives (plan node 1)
// ---------------------------------------------------------------------------

fn resilience_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let dir = home
        .join(".cache")
        .join("canvas-terminal")
        .join("resilience");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create resilience directory: {}", e))?;
    Ok(dir)
}

pub(crate) fn session_dir() -> Result<PathBuf, String> {
    let dir = resilience_root()?.join(format!("session-{}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create resilience session directory: {}", e))?;
    Ok(dir)
}

// Small local mirrors of memory.rs's private session-<pid> helpers. Duplicated
// (15 lines) rather than widening memory.rs's visibility — the two stores are
// intentionally independent roots with independent lifecycles.
fn parse_session_pid(path: &std::path::Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?;
    name.strip_prefix("session-")?.parse::<u32>().ok()
}

fn is_process_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Remove resilience session dirs whose owning process is dead. Called once at
/// app setup — mirrors `memory::clear_stale_sessions`. A live session's dir is
/// never touched, so a reload (same PID) keeps its evidence.
pub fn clear_stale_resilience_sessions() -> Result<(), String> {
    let root = resilience_root()?;
    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(pid) = parse_session_pid(&path) else {
            continue;
        };
        if is_process_alive(pid) {
            continue;
        }
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_json_file<T: serde::de::DeserializeOwned>(name: &str) -> Result<Option<T>, String> {
    let path = session_dir()?.join(name);
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map(Some)
            .map_err(|e| format!("parse {}: {}", name, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_json_file<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    let dir = session_dir()?;
    let serialized = serde_json::to_string(value).map_err(|e| e.to_string())?;
    // Atomic engine shared with the scoped memory IPC — readers (the fresh
    // context's bootstrap) see old or new content, never a torn write.
    memory::write_file_atomic_under(&dir, name, &serialized)?;
    Ok(())
}

fn delete_file(name: &str) -> Result<(), String> {
    let path = session_dir()?.join(name);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Durable watchdog state (plan nodes 2, 3, 4, 8)
// ---------------------------------------------------------------------------

/// Durable per-process watchdog record. `beat_generation` snapshots the
/// launch generation at the moment of the last beat, so
/// `reloadedSinceLastBeat` is a RUST-INTERNAL comparison — the fresh JS
/// context has no prior in-memory baseline to compare against
/// (DeathEvidence docstring, round-4 fix).
#[derive(Serialize, Deserialize, Clone, Default)]
struct WatchdogRecord {
    last_beat_at: Option<i64>,
    launch_count: u64,
    beat_generation: u64,
    observed_termination: bool,
}

/// Process-global watchdog bookkeeping. The durable record is mirrored in
/// memory (single writer discipline via the mutex); `probe_in_flight`
/// serializes focus probes so rapid focus toggles can't stack verdicts.
struct WatchdogInner {
    record: WatchdogRecord,
    loaded: bool,
}

static PROBE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn watchdog_state() -> &'static Mutex<WatchdogInner> {
    static STATE: std::sync::OnceLock<Mutex<WatchdogInner>> = std::sync::OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(WatchdogInner {
            record: WatchdogRecord::default(),
            loaded: false,
        })
    })
}

/// Read-modify-write helper over the durable watchdog record. Loads the
/// on-disk record on first touch (the Rust process — and this static —
/// survive a webview reload; the lazy load only serves the cold app start),
/// applies `f`, persists, and returns a clone of the updated record.
fn with_watchdog<F: FnOnce(&mut WatchdogRecord)>(f: F) -> Result<WatchdogRecord, String> {
    let mut guard = watchdog_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !guard.loaded {
        if let Some(rec) = read_json_file::<WatchdogRecord>(WATCHDOG_FILE)? {
            guard.record = rec;
        }
        guard.loaded = true;
    }
    f(&mut guard.record);
    write_json_file(WATCHDOG_FILE, &guard.record)?;
    Ok(guard.record.clone())
}

fn read_watchdog() -> Result<WatchdogRecord, String> {
    let mut guard = watchdog_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !guard.loaded {
        if let Some(rec) = read_json_file::<WatchdogRecord>(WATCHDOG_FILE)? {
            guard.record = rec;
        }
        guard.loaded = true;
    }
    Ok(guard.record.clone())
}

/// Forward a liveness beat to the durable sink (IWebContentWatchdog.reportBeat
/// counterpart). A new beat also clears any stale `observed_termination` — a
/// beating context is alive, so the prior incident's positive verdict must not
/// leak into the next evidence read.
#[tauri::command]
pub fn report_heartbeat(at: i64) -> Result<(), String> {
    with_watchdog(|rec| {
        rec.last_beat_at = Some(at);
        rec.beat_generation = rec.launch_count;
        rec.observed_termination = false;
    })?;
    Ok(())
}

/// Increment the webview launch generation. Wired to tauri's
/// `on_page_load(Finished)` for the main webview in lib.rs (plan node 3) —
/// every page (re)load, including the watchdog's own recovery reload,
/// increments it. `reloadedSinceLastBeat` compares this against the
/// generation captured at the last beat.
pub fn record_page_load() {
    let _ = with_watchdog(|rec| {
        rec.launch_count += 1;
    });
}

/// Wire shape of `DeathEvidence` — pinned by src/lib/resilience/types.ts.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeathEvidence {
    pub observed_termination: bool,
    pub last_good_beat_at: Option<i64>,
    pub gap_ms: Option<i64>,
    pub launch_count: u64,
    pub reloaded_since_last_beat: bool,
}

/// Post-(re)launch read of the durable death evidence (plan node 4). The FE
/// bootstrap calls this once BEFORE its first new beat overwrites the durable
/// last-beat (IWebContentWatchdog.readDeathEvidence contract).
#[tauri::command]
pub fn read_death_evidence() -> Result<DeathEvidence, String> {
    let rec = read_watchdog()?;
    let now = now_ms();
    let gap_ms = rec.last_beat_at.map(|beat| (now - beat).max(0));
    Ok(DeathEvidence {
        observed_termination: rec.observed_termination,
        last_good_beat_at: rec.last_beat_at,
        gap_ms,
        launch_count: rec.launch_count,
        reloaded_since_last_beat: rec.last_beat_at.is_some()
            && rec.launch_count > rec.beat_generation,
    })
}

// ---------------------------------------------------------------------------
// Durable recovery session (plan node 5)
// ---------------------------------------------------------------------------

/// Wire shapes pinned by src/lib/resilience/types.ts (camelCase). `sign` and
/// `action` stay strings on the Rust side — the FE union types are the source
/// of truth and Rust never branches on values it did not itself write.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDecision {
    pub proceed: bool,
    pub sign: String,
    pub action: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySession {
    pub token: String,
    pub decision: RecoveryDecision,
    pub suppress_teardown: bool,
    pub created_at: i64,
    pub expires_at: i64,
    pub attempts: u32,
    pub max_attempts: u32,
}

fn mint_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "rs-{}-{}-{}",
        std::process::id(),
        nanos,
        TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn build_session(decision: RecoveryDecision, max_attempts: u32, ttl_ms: i64) -> RecoverySession {
    let now = now_ms();
    let ttl = ttl_ms.clamp(TTL_MIN_MS, TTL_MAX_MS);
    RecoverySession {
        token: mint_token(),
        decision,
        suppress_teardown: true,
        created_at: now,
        expires_at: now + ttl,
        attempts: 0,
        max_attempts,
    }
}

/// Durably open a recovery session BEFORE the reload (old-context B path; the
/// A path mints via `handle_death_verdict` below). 3-argument shape per the
/// FE caller `RecoverySessionClient.begin({decision, maxAttempts, ttlMs})` —
/// plan rev 2 HIGH fold.
#[tauri::command]
pub fn persist_recovery_session(
    decision: RecoveryDecision,
    max_attempts: u32,
    ttl_ms: i64,
) -> Result<RecoverySession, String> {
    let session = build_session(decision, max_attempts, ttl_ms);
    write_json_file(RECOVERY_SESSION_FILE, &session)?;
    Ok(session)
}

fn load_session_unexpired() -> Result<Option<RecoverySession>, String> {
    let Some(session) = read_json_file::<RecoverySession>(RECOVERY_SESSION_FILE)? else {
        return Ok(None);
    };
    if session.expires_at <= now_ms() {
        // Expired sessions are treated as absent (and reaped) — the expiry is
        // the outer crash-loop backstop.
        let _ = delete_file(RECOVERY_SESSION_FILE);
        return Ok(None);
    }
    Ok(Some(session))
}

/// Read-only pending-session probe (fresh-context bootstrap). "Nothing
/// pending" is `null`, never an error.
#[tauri::command]
pub fn load_recovery_session() -> Result<Option<RecoverySession>, String> {
    load_session_unexpired()
}

/// Atomic durable compare-increment-persist (plan node 5): the attempt
/// counter is incremented and PERSISTED before any restore side-effect runs
/// in the FE, so a resume that itself dies cannot retry unboundedly. Token
/// mismatch / absent / expired / exhausted-after-increment all return `null`
/// — the caller clears and fails fast.
#[tauri::command]
pub fn claim_recovery_attempt(token: String) -> Result<Option<RecoverySession>, String> {
    let Some(mut session) = load_session_unexpired()? else {
        return Ok(None);
    };
    if session.token != token {
        return Ok(None);
    }
    session.attempts += 1;
    // Persist FIRST — the increment must survive even if the caller dies
    // immediately after this returns.
    write_json_file(RECOVERY_SESSION_FILE, &session)?;
    if session.attempts > session.max_attempts {
        return Ok(None);
    }
    Ok(Some(session))
}

/// Idempotent clear — a non-matching or already-cleared token is a no-op
/// (guards double-resume).
#[tauri::command]
pub fn clear_recovery_session(token: String) -> Result<(), String> {
    match read_json_file::<RecoverySession>(RECOVERY_SESSION_FILE)? {
        Some(session) if session.token == token => delete_file(RECOVERY_SESSION_FILE),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Topology snapshot store (plan node 6)
// ---------------------------------------------------------------------------

/// The snapshot is OPAQUE to Rust — `TopologySnapshot`'s schema (incl. its
/// `version` field) is owned by the FE (`types.ts` + `restoreShell`'s version
/// check). Storing `serde_json::Value` verbatim means the Rust side can never
/// drift from the FE schema.
#[tauri::command]
pub fn persist_topology(snapshot: serde_json::Value) -> Result<(), String> {
    write_json_file(TOPOLOGY_FILE, &snapshot)
}

#[tauri::command]
pub fn load_topology() -> Result<Option<serde_json::Value>, String> {
    read_json_file::<serde_json::Value>(TOPOLOGY_FILE)
}

// ---------------------------------------------------------------------------
// recreate_webview stub (plan rev 2 decision — claude2 F2)
// ---------------------------------------------------------------------------

/// Deliberate no-op stub. The landed FE fires this invoke (fire-and-forget,
/// error swallowed) when a decision carries `action: "recreate-webview"` —
/// an action this feature never mints (reload-in-place only). Registering an
/// explicit Err turns a latent "command not found" into a documented,
/// debuggable residual; the recreate-webview behavior itself remains a
/// follow-up (plan out-of-scope).
#[tauri::command]
pub fn recreate_webview() -> Result<(), String> {
    Err("recreate_webview is not implemented — this feature ships reload-in-place only \
         (webcontent-death-recovery plan, out-of-scope decision)"
        .to_string())
}

// ---------------------------------------------------------------------------
// Focus-probe watchdog + A-path death handler (plan nodes 7 + 8)
// ---------------------------------------------------------------------------

/// A-path death handling: record the positive verdict, mint the recovery
/// session (the dead JS context cannot — "or by Rust on the A path"), then
/// reload the webview. The minted shape is the NESTED types.ts structure
/// (plan rev 2 MED fold — `sign`/`action` live inside `.decision`).
fn handle_death_verdict<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    gap_ms: i64,
) -> Result<(), String> {
    with_watchdog(|rec| {
        rec.observed_termination = true;
    })?;

    let session = build_session(
        RecoveryDecision {
            proceed: true,
            sign: "webcontent-death".to_string(),
            action: "reload-in-place".to_string(),
            reason: format!(
                "rust watchdog: focus probe unanswered for {}ms with durable last-beat gap {}ms",
                PROBE_TIMEOUT_MS, gap_ms
            ),
        },
        // Mirror the FE policy caps (resilienceConfig.recoveryMaxAttempts /
        // recoverySessionTtlMs). Constants here, not FE-read: the FE that
        // would supply them is dead at mint time.
        2,
        60_000,
    );
    write_json_file(RECOVERY_SESSION_FILE, &session)?;

    eprintln!(
        "[resilience] WebContent death verdict (gap {}ms) — reloading webview (token {})",
        gap_ms, session.token
    );
    window.reload().map_err(|e| e.to_string())
}

/// Focus-triggered liveness probe (plan node 7). Called from lib.rs on
/// `WindowEvent::Focused(true)` for the main window. Public-API-only design:
/// the eval'd `window.__ct_probe?.()` triggers an IMMEDIATE FE heartbeat
/// (registered by bootstrap.ts), so liveness is "the durable last-beat
/// advanced past probe-start within the timeout" — no extra IPC, no response
/// channel needed. A dead WebContent cannot run the eval, the beat never
/// advances, and the gap check fires the A path.
pub fn run_focus_probe<R: tauri::Runtime>(window: tauri::WebviewWindow<R>) {
    // One probe at a time — rapid focus toggles must not stack verdicts.
    if PROBE_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let outcome: Result<(), String> = async {
            // Suppress while a recovery is already pending — the reload we
            // triggered fires Focused(true) again on return; re-probing
            // mid-recovery would double-mint sessions.
            if load_session_unexpired()?.is_some() {
                return Ok(());
            }

            let record = read_watchdog()?;
            let Some(beat_before) = record.last_beat_at else {
                // No beats yet (fresh install / FE bootstrap not up) — no
                // evidence to judge against; never verdict on silence alone.
                return Ok(());
            };

            let t0 = now_ms();
            // The probe: a live context beats immediately (bootstrap wires
            // __ct_probe → heartbeat.recordTick which force-forwards).
            let _ = window.eval("window.__ct_probe && window.__ct_probe();");

            tokio::time::sleep(std::time::Duration::from_millis(PROBE_TIMEOUT_MS)).await;

            let after = read_watchdog()?;
            if after.last_beat_at.map_or(false, |b| b >= t0) {
                return Ok(()); // beat advanced — alive.
            }
            let gap = now_ms() - after.last_beat_at.unwrap_or(beat_before);
            if gap > DEATH_GAP_THRESHOLD_MS {
                handle_death_verdict(&window, gap)?;
            }
            Ok(())
        }
        .await;

        if let Err(e) = outcome {
            eprintln!("[resilience] focus probe failed: {}", e);
        }
        PROBE_IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod resilience_tests {
    //! Store roundtrip + claim semantics + evidence computation (plan node
    //! 16). The watchdog record and session file are process-global, so the
    //! tests serialize on one lock — cargo's parallel test threads would
    //! otherwise interleave read-modify-write cycles.
    use super::*;

    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn decision() -> RecoveryDecision {
        RecoveryDecision {
            proceed: true,
            sign: "webcontent-death".to_string(),
            action: "reload-in-place".to_string(),
            reason: "test".to_string(),
        }
    }

    #[test]
    fn recovery_session_roundtrip_and_clear() {
        let _guard = test_lock();
        let session = persist_recovery_session(decision(), 2, 60_000).unwrap();
        assert_eq!(session.attempts, 0);
        assert!(session.suppress_teardown);
        assert!(session.expires_at > session.created_at);
        // Nested shape survives the disk roundtrip (rev-2 MED fold).
        let loaded = load_recovery_session().unwrap().expect("pending session");
        assert_eq!(loaded.token, session.token);
        assert_eq!(loaded.decision.sign, "webcontent-death");
        assert_eq!(loaded.decision.action, "reload-in-place");
        // Non-matching clear is a no-op; matching clear removes.
        clear_recovery_session("wrong-token".to_string()).unwrap();
        assert!(load_recovery_session().unwrap().is_some());
        clear_recovery_session(session.token.clone()).unwrap();
        assert!(load_recovery_session().unwrap().is_none());
    }

    #[test]
    fn ttl_is_clamped() {
        let _guard = test_lock();
        let session = persist_recovery_session(decision(), 2, -5).unwrap();
        assert!(session.expires_at - session.created_at >= TTL_MIN_MS);
        clear_recovery_session(session.token).unwrap();
        let session = persist_recovery_session(decision(), 2, i64::MAX).unwrap();
        assert!(session.expires_at - session.created_at <= TTL_MAX_MS);
        clear_recovery_session(session.token).unwrap();
    }

    #[test]
    fn expired_session_reads_as_absent() {
        let _guard = test_lock();
        // TTL clamps to the 1s minimum; backdate by writing directly.
        let mut session = build_session(decision(), 2, 60_000);
        session.expires_at = now_ms() - 1;
        write_json_file(RECOVERY_SESSION_FILE, &session).unwrap();
        assert!(load_recovery_session().unwrap().is_none());
        // The expiry read also reaps the file.
        assert!(read_json_file::<RecoverySession>(RECOVERY_SESSION_FILE)
            .unwrap()
            .is_none());
    }

    #[test]
    fn claim_increments_durably_and_exhausts() {
        let _guard = test_lock();
        let session = persist_recovery_session(decision(), 2, 60_000).unwrap();
        // Wrong token claims nothing and does not increment.
        assert!(claim_recovery_attempt("nope".to_string()).unwrap().is_none());
        let c1 = claim_recovery_attempt(session.token.clone())
            .unwrap()
            .expect("first claim");
        assert_eq!(c1.attempts, 1);
        // The increment is durable BEFORE the caller sees it.
        let on_disk = read_json_file::<RecoverySession>(RECOVERY_SESSION_FILE)
            .unwrap()
            .unwrap();
        assert_eq!(on_disk.attempts, 1);
        let c2 = claim_recovery_attempt(session.token.clone())
            .unwrap()
            .expect("second claim");
        assert_eq!(c2.attempts, 2);
        // Third claim exceeds max_attempts=2 → exhausted ⇒ None, but the
        // increment still persisted (crash-loop evidence).
        assert!(claim_recovery_attempt(session.token.clone())
            .unwrap()
            .is_none());
        let on_disk = read_json_file::<RecoverySession>(RECOVERY_SESSION_FILE)
            .unwrap()
            .unwrap();
        assert_eq!(on_disk.attempts, 3);
        clear_recovery_session(session.token).unwrap();
    }

    #[test]
    fn evidence_reflects_beats_generations_and_termination() {
        let _guard = test_lock();
        // Establish a beat at the current generation.
        let now = now_ms();
        report_heartbeat(now).unwrap();
        let ev = read_death_evidence().unwrap();
        assert_eq!(ev.last_good_beat_at, Some(now));
        assert!(!ev.reloaded_since_last_beat);
        assert!(!ev.observed_termination);
        assert!(ev.gap_ms.unwrap_or(0) >= 0);

        // A page load after the beat flips reloadedSinceLastBeat.
        record_page_load();
        let ev = read_death_evidence().unwrap();
        assert!(ev.reloaded_since_last_beat);

        // A new beat re-anchors the generation and clears the flag.
        report_heartbeat(now_ms()).unwrap();
        let ev = read_death_evidence().unwrap();
        assert!(!ev.reloaded_since_last_beat);

        // A death verdict surfaces as observedTermination until the next beat.
        with_watchdog(|rec| rec.observed_termination = true).unwrap();
        assert!(read_death_evidence().unwrap().observed_termination);
        report_heartbeat(now_ms()).unwrap();
        assert!(!read_death_evidence().unwrap().observed_termination);
    }

    #[test]
    fn topology_store_roundtrips_opaque_json() {
        let _guard = test_lock();
        let snapshot = serde_json::json!({
            "version": 1,
            "capturedAt": 123,
            "tabs": [{"id": "t1", "paneTree": {"type": "leaf"}}],
            "activeTabId": "t1"
        });
        persist_topology(snapshot.clone()).unwrap();
        let loaded = load_topology().unwrap().expect("persisted snapshot");
        assert_eq!(loaded, snapshot);
        let _ = delete_file(TOPOLOGY_FILE);
    }

    #[test]
    fn recreate_webview_is_a_documented_stub() {
        let err = recreate_webview().expect_err("stub must not claim success");
        assert!(err.contains("reload-in-place"));
    }
}
