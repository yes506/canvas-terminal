//! Axum server bound to 127.0.0.1:0.
//!
//! Day 1: auth round-trip + /api/health.
//! Day 2: snapshot + raw-file endpoints (this file).
//! Day 3: SSE live updates + rust-embed SPA bundle (this file).
//!
//! Routes after Day 2-3:
//!  - `GET /?t=TOKEN`                       — token exchange → cookie + redirect
//!  - `GET /`                               — embedded SPA `index.html`
//!  - `GET /assets/{file}`                  — embedded SPA bundle assets
//!  - `GET /api/health`                     — health JSON
//!  - `GET /api/sessions/current/snapshot`  — file roster for the live session
//!  - `GET /api/sessions/current/files/*p`  — raw text content for one file
//!  - `GET /api/sessions/current/events`    — SSE stream of file-change events
//!
//! Lifecycle: when `session_alive` flips to false (set in lib.rs::on_window_event
//! Destroyed arm), `/api/health` reports `session_alive: false`, the snapshot
//! and files endpoints short-circuit to a "session ended" payload, and the SSE
//! stream returns HTTP 410 Gone. The file-watcher task also notices and exits.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, HeaderValue, Request, Response, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Redirect,
    },
    routing::get,
    Json, Router,
};
use futures::stream::Stream;
use rand::RngCore;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Notify};

use super::state::Running;
use crate::commands::memory::{get_memory_dir, validate_relative_path};

/// Maximum bytes returned by the raw-files endpoint. Mirrors `read_memory_file`'s
/// MAX_MEMORY_FILE_SIZE (10 MB) so the dashboard surface and the IPC surface
/// share the same limit. If the IPC ever raises its limit, raise this in lockstep.
const MAX_RAW_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// File-watcher poll interval. Matches the inbox poller cadence in
/// `collaboratorStore.ts` (2s) so dashboard updates feel "as fresh as the
/// agents themselves".
const WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// SSE event channel buffer. Sized for short bursts of file changes from a
/// multi-agent session (a few-dozen files written within one tick); slow
/// consumers fall back to `Lagged` errors which the stream layer turns into
/// a no-op continue. See `broadcast_stream` below.
const EVENTS_CHANNEL_CAP: usize = 256;

/// Embedded SPA bundle. Built by `npm run build:dashboard` into `dist-dashboard/`,
/// then frozen into the Rust binary at compile time.
///
/// `debug-embed` (Cargo.toml) is on so debug builds also use the embedded copy
/// — without it, debug builds would `fs::read` the folder at request time and
/// fail when the binary runs from `target/debug/` with a missing relative path.
#[derive(RustEmbed)]
#[folder = "../dist-dashboard"]
struct DashboardAssets;

/// Bind a fresh listener, generate token + launch_id, kick off the file
/// watcher, and start the axum server on the shared Tauri runtime.
///
/// Caller is `commands::dashboard::ensure_started` (Tauri command), which
/// holds the `Mutex<Option<Running>>` lock for the duration so concurrent
/// "Open Dashboard" clicks don't double-bind.
pub async fn start(session_alive: Arc<AtomicBool>) -> Result<Running, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind 127.0.0.1:0: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {}", e))?
        .port();

    let token = random_hex(16); // 128-bit
    let launch_id = random_hex(8); // 64-bit; only used as cookie name suffix

    let shutdown = Arc::new(Notify::new());
    let (events_tx, _) = broadcast::channel::<DashboardEvent>(EVENTS_CHANNEL_CAP);

    let session_dir = get_memory_dir().map_err(|e| format!("session dir: {}", e))?;

    let server_state = ServerState {
        token: token.clone(),
        launch_id: launch_id.clone(),
        port,
        session_alive: session_alive.clone(),
        events_tx: events_tx.clone(),
        session_dir: session_dir.clone(),
    };

    // Spawn the file watcher. Exits when session_alive flips to false.
    {
        let session_alive = session_alive.clone();
        let session_dir = session_dir.clone();
        tauri::async_runtime::spawn(async move {
            run_file_watcher(session_dir, events_tx, session_alive).await;
        });
    }

    let app = build_router(server_state);
    let shutdown_signal = shutdown.clone();

    // Spawn on Tauri's shared tokio runtime — see v4 §3.11 spike gate #1.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(async move { shutdown_signal.notified().await })
            .await
        {
            eprintln!("[dashboard] axum::serve exited: {}", e);
        }
    });

    Ok(Running {
        port,
        token,
        shutdown,
    })
}

#[derive(Clone)]
struct ServerState {
    token: String,
    launch_id: String,
    port: u16,
    session_alive: Arc<AtomicBool>,
    events_tx: broadcast::Sender<DashboardEvent>,
    /// Absolute path to the current `session-{pid}/` dir. Snapshot/files
    /// handlers root all lookups inside this dir.
    session_dir: PathBuf,
}

fn build_router(state: ServerState) -> Router {
    Router::new()
        .route("/", get(root_handler))
        .route("/assets/*path", get(asset_handler))
        .route("/api/health", get(health_handler))
        .route("/api/sessions/current/snapshot", get(snapshot_handler))
        .route("/api/sessions/current/files/*path", get(file_handler))
        .route("/api/sessions/current/events", get(events_handler))
        .layer(middleware::from_fn_with_state(state.clone(), auth_layer))
        .layer(middleware::from_fn(security_headers_layer))
        .with_state(state)
}

#[derive(Deserialize)]
struct RootQuery {
    t: Option<String>,
}

/// Token-bearing first hit. On success, sets the per-launch cookie and
/// redirects (HTTP 303 See Other; see the inline comment in the handler
/// below for the 302-vs-303 rationale) to `/` so the browser address bar
/// (and history) only retain the token-less URL.
///
/// On no-token hit, returns the SPA `index.html` from the embedded bundle.
async fn root_handler(
    State(state): State<ServerState>,
    Query(q): Query<RootQuery>,
    headers: HeaderMap,
) -> Response<Body> {
    if !state.session_alive.load(Ordering::SeqCst) {
        return ended_response();
    }

    if let Some(t) = q.t.as_deref() {
        if t != state.token {
            return unauthorized();
        }
        // Valid token in URL → set cookie + redirect.
        //
        // No `Secure` flag on the cookie because the dashboard binds
        // `127.0.0.1` over plain HTTP. Browsers are exempt from
        // Secure-only-on-HTTPS for localhost (RFC 6265bis §4.1.2.6),
        // but a `Secure` cookie set over HTTP is silently dropped on
        // some browsers. Do NOT "fix" this by adding `Secure` — the
        // cookie would no longer arrive on follow-up requests.
        let cookie = format!(
            "ct_dash_{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400",
            state.launch_id, state.token
        );
        // axum's `Redirect::to` emits HTTP 303 See Other, which is
        // semantically correct for token exchange (the next request
        // is unconditionally GET with no body, no method preservation
        // from the original request). v4/v5 plan said "302" but 303 is
        // the right status code for this redirect-after-state-change
        // pattern. Functionally identical for our GET → GET flow on
        // every browser we target.
        let mut resp = Redirect::to("/").into_response();
        resp.headers_mut()
            .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
        // Don't cache the token-bearing redirect — see v4 §3.12.
        resp.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return resp;
    }

    // No `?t=` — already authenticated by cookie (auth_layer ran). Serve SPA.
    if !has_valid_cookie(&state, &headers) {
        return unauthorized();
    }
    serve_embedded("index.html")
}

/// Serve a file from the embedded SPA bundle. Path is the URL `*path` capture
/// (already past the `/assets/` prefix), so we re-prefix with `assets/` to look
/// it up inside the embedded folder.
async fn asset_handler(AxumPath(path): AxumPath<String>) -> Response<Body> {
    let key = format!("assets/{}", path);
    serve_embedded(&key)
}

fn serve_embedded(key: &str) -> Response<Body> {
    match DashboardAssets::get(key) {
        Some(asset) => {
            let mime = guess_mime(key);
            let mut resp = Response::new(Body::from(asset.data.into_owned()));
            resp.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
            // SPA bundle assets are content-hashed by Vite, so they're safe to
            // cache aggressively. index.html is NOT — it references the latest
            // hashed bundle and must be re-fetched. The security_headers_layer
            // already injects no-store as a default; override here only for
            // hashed assets.
            if key.starts_with("assets/") {
                resp.headers_mut().insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                );
            }
            resp
        }
        None => not_found(),
    }
}

/// Map filename extension to a static MIME type. Limited to the types the
/// Vite dashboard bundle actually emits — no need for the full mime_guess
/// dependency for a one-page SPA.
fn guess_mime(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("map") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[derive(serde::Serialize)]
struct Health {
    ok: bool,
    port: u16,
    pid: u32,
    session_alive: bool,
}

async fn health_handler(State(state): State<ServerState>) -> Json<Health> {
    Json(Health {
        ok: true,
        port: state.port,
        pid: std::process::id(),
        session_alive: state.session_alive.load(Ordering::SeqCst),
    })
}

#[derive(Serialize)]
struct SnapshotEntry {
    /// Path relative to the session dir, e.g. `inbox/claude1/msg.json`.
    /// Forward-slash separated on every platform so the SPA can use it as a
    /// stable key without normalizing.
    path: String,
    size: u64,
    /// Last-modified time, epoch milliseconds.
    mtime_ms: u64,
}

#[derive(Serialize)]
#[serde(tag = "status")]
enum SnapshotResponse {
    #[serde(rename = "alive")]
    Alive {
        pid: u32,
        files: Vec<SnapshotEntry>,
    },
    #[serde(rename = "ended")]
    Ended,
}

async fn snapshot_handler(State(state): State<ServerState>) -> Json<SnapshotResponse> {
    if !state.session_alive.load(Ordering::SeqCst) {
        return Json(SnapshotResponse::Ended);
    }
    let mut files = Vec::new();
    walk_session(&state.session_dir, &state.session_dir, &mut files);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Json(SnapshotResponse::Alive {
        pid: std::process::id(),
        files,
    })
}

fn walk_session(base: &Path, current: &Path, out: &mut Vec<SnapshotEntry>) {
    let Ok(entries) = std::fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip dotfiles (atomic-write tmp files start with a dot — the dashboard
        // shouldn't see those mid-rename).
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }
        // symlink_metadata so we don't follow symlinks out of the session dir.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk_session(base, &path, out);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(base) else {
            continue;
        };
        // Normalize to forward slashes so the SPA never has to care about the
        // host OS. macOS-only today, but the constant cost is one allocation.
        let rel_str = rel
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(s) => s.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(SnapshotEntry {
            path: rel_str,
            size: meta.len(),
            mtime_ms,
        });
    }
}

#[derive(Serialize)]
struct FileResponse {
    path: String,
    content: String,
    size: u64,
    mtime_ms: u64,
}

async fn file_handler(
    State(state): State<ServerState>,
    AxumPath(path): AxumPath<String>,
) -> Response<Body> {
    if !state.session_alive.load(Ordering::SeqCst) {
        return ended_response();
    }
    if let Err(e) = validate_relative_path(&path) {
        return text_status(StatusCode::BAD_REQUEST, e);
    }
    let full = state.session_dir.join(&path);

    // symlink_metadata + reject — the IPC writers never create symlinks in this
    // tree, but defense-in-depth: a planted symlink must not let the dashboard
    // read arbitrary files from the user's home dir.
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(m) => m,
        Err(_) => return not_found(),
    };
    if meta.is_symlink() {
        return text_status(
            StatusCode::FORBIDDEN,
            "Refusing to follow a symlink".to_string(),
        );
    }
    if !meta.is_file() {
        return not_found();
    }
    if meta.len() > MAX_RAW_FILE_BYTES {
        return text_status(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("File exceeds {} bytes", MAX_RAW_FILE_BYTES),
        );
    }

    let bytes = match std::fs::read(&full) {
        Ok(b) => b,
        Err(e) => return text_status(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    // Lossy UTF-8 decode: the session dir is markdown + JSON, but if a binary
    // sneaks in (e.g. an attached image) we'd rather render replacement chars
    // than 500. The SPA can decide whether to render or hex-dump.
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let body = FileResponse {
        path: path.clone(),
        content,
        size: meta.len(),
        mtime_ms,
    };
    let json = match serde_json::to_string(&body) {
        Ok(s) => s,
        Err(e) => return text_status(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let mut resp = Response::new(Body::from(json));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    resp
}

// The shared `File` prefix is intentional: the variants serialize to
// `kebab-case` discriminants (`file-added`, `file-changed`, `file-removed`)
// over the wire to the SPA, and the prefix keeps the wire format namespaced.
// Renaming to `Added/Changed/Removed` would shorten the discriminants too,
// breaking the SPA's `ev.kind === "file-added"` checks.
#[allow(clippy::enum_variant_names)]
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum DashboardEvent {
    FileAdded { path: String, mtime_ms: u64 },
    FileChanged { path: String, mtime_ms: u64 },
    FileRemoved { path: String },
}

async fn events_handler(
    State(state): State<ServerState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, Response<Body>> {
    if !state.session_alive.load(Ordering::SeqCst) {
        return Err(ended_response());
    }
    let rx = state.events_tx.subscribe();
    let stream = broadcast_stream(rx);
    let sse = Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    );
    Ok(sse)
}

/// Adapt a `tokio::sync::broadcast::Receiver` into a `Stream` of SSE events
/// without pulling in `tokio-stream`. Lagged receivers (slow consumer fell
/// behind the channel buffer) skip the missed events and continue — a missed
/// file-changed event will be re-sent the next tick anyway because the
/// watcher's diff is mtime-based, not edge-triggered.
fn broadcast_stream(
    rx: broadcast::Receiver<DashboardEvent>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    futures::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let json = serde_json::to_string(&ev).unwrap_or_else(|_| "{}".to_string());
                    let event = Event::default().event("file").data(json);
                    return Some((Ok(event), rx));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

/// Background task: poll the session dir every WATCH_INTERVAL, diff against
/// the previous mtime snapshot, broadcast added/changed/removed events.
///
/// Exits when `session_alive` flips to false (shutdown handler will then
/// drain in-flight SSE responses via `with_graceful_shutdown`).
async fn run_file_watcher(
    session_dir: PathBuf,
    events_tx: broadcast::Sender<DashboardEvent>,
    session_alive: Arc<AtomicBool>,
) {
    let mut prev: HashMap<String, u64> = HashMap::new();
    // Seed with the current state so the first tick doesn't fire FileAdded for
    // every existing file (the SPA gets the initial roster from /snapshot).
    {
        let mut entries = Vec::new();
        walk_session(&session_dir, &session_dir, &mut entries);
        for e in entries {
            prev.insert(e.path, e.mtime_ms);
        }
    }

    let mut interval = tokio::time::interval(WATCH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        if !session_alive.load(Ordering::SeqCst) {
            return;
        }
        let mut current_entries = Vec::new();
        walk_session(&session_dir, &session_dir, &mut current_entries);
        let mut current: HashMap<String, u64> = HashMap::with_capacity(current_entries.len());
        for entry in current_entries {
            current.insert(entry.path, entry.mtime_ms);
        }

        for (path, mtime) in &current {
            match prev.get(path) {
                Some(prev_mtime) if prev_mtime == mtime => {}
                Some(_) => {
                    let _ = events_tx.send(DashboardEvent::FileChanged {
                        path: path.clone(),
                        mtime_ms: *mtime,
                    });
                }
                None => {
                    let _ = events_tx.send(DashboardEvent::FileAdded {
                        path: path.clone(),
                        mtime_ms: *mtime,
                    });
                }
            }
        }
        for path in prev.keys() {
            if !current.contains_key(path) {
                let _ = events_tx.send(DashboardEvent::FileRemoved { path: path.clone() });
            }
        }
        prev = current;
    }
}

/// Auth layer: accepts cookie OR ?t= OR Authorization: Bearer.
/// Skips the check for the bare `GET /` with a `?t=` token (root_handler does its own
/// validation and sets the cookie). For everything else, missing/invalid auth = 401.
async fn auth_layer(
    State(state): State<ServerState>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    let path = req.uri().path();
    let query = req.uri().query().unwrap_or("");

    // First-hit token-bearing root: defer to root_handler for the actual
    // token validation + cookie issuance. Match the parameter NAME exactly
    // (a `?t=...` parameter), not the substring `t=` — `query.contains("t=")`
    // would match `?text=foo` and forward it for handler-level rejection.
    // The substring approach was not a security bug (root_handler validates
    // via `Query<RootQuery>` and returns 401 for non-matching tokens), but
    // a future contributor reading the substring check might assume it IS
    // the security boundary and copy the pattern unsafely.
    if path == "/" && query.split('&').any(|kv| kv == "t" || kv.starts_with("t=")) {
        return next.run(req).await;
    }

    // Cookie?
    if has_valid_cookie(&state, req.headers()) {
        return next.run(req).await;
    }

    // Bearer header?
    if let Some(h) = req.headers().get(header::AUTHORIZATION) {
        if let Ok(s) = h.to_str() {
            if let Some(rest) = s.strip_prefix("Bearer ") {
                if rest == state.token {
                    return next.run(req).await;
                }
            }
        }
    }

    // Query token (for SSE — EventSource can't set Authorization)?
    if query.split('&').any(|kv| {
        let mut it = kv.splitn(2, '=');
        matches!((it.next(), it.next()), (Some("t"), Some(v)) if v == state.token)
    }) {
        return next.run(req).await;
    }

    unauthorized()
}

fn has_valid_cookie(state: &ServerState, headers: &HeaderMap) -> bool {
    let want_name = format!("ct_dash_{}", state.launch_id);
    let Some(cookie_header) = headers.get(header::COOKIE) else {
        return false;
    };
    let Ok(s) = cookie_header.to_str() else {
        return false;
    };
    s.split(';').any(|pair| {
        let pair = pair.trim();
        let mut it = pair.splitn(2, '=');
        matches!((it.next(), it.next()), (Some(name), Some(value)) if name == want_name && value == state.token)
    })
}

/// Apply security headers (CSP / Referrer-Policy / nosniff / etc.) to every
/// response. v4 §3.6 promotes these from Phase 2 to MVP.
async fn security_headers_layer(req: Request<Body>, next: Next) -> Response<Body> {
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    h.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
        ),
    );
    // Cache-Control on every API/HTML response so reloads always reach the server.
    // Hashed bundle assets opt out via the override in `serve_embedded`.
    if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    resp
}

fn unauthorized() -> Response<Body> {
    let mut resp = Response::new(Body::from("unauthorized"));
    *resp.status_mut() = StatusCode::UNAUTHORIZED;
    resp
}

fn not_found() -> Response<Body> {
    let mut resp = Response::new(Body::from("not found"));
    *resp.status_mut() = StatusCode::NOT_FOUND;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

fn text_status(status: StatusCode, body: String) -> Response<Body> {
    let mut resp = Response::new(Body::from(body));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

fn ended_response() -> Response<Body> {
    let mut resp = Response::new(Body::from(
        "Canvas Terminal session ended. Reopen the dashboard from the app menu.",
    ));
    *resp.status_mut() = StatusCode::GONE;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

fn random_hex(byte_len: usize) -> String {
    let mut buf = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

#[cfg(test)]
mod tests {
    //! Focused HTTP handler tests covering the dashboard server's security and
    //! lifecycle invariants. We drive the axum `Router` via `tower::ServiceExt::oneshot`
    //! rather than binding a real socket — keeps tests fast and lets us assert
    //! response shape without networking.
    //!
    //! Coverage targets the issues five reviewing agents flagged as worth
    //! locking in: auth bypass regressions, path-traversal rejection, and the
    //! session-ended response shape. The happy-path snapshot/SSE work is
    //! covered by the existing build + manual smoke; tests here are about the
    //! invariants where regressions would be silent or security-relevant.

    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    /// Build a `ServerState` with a fixed token + a temp dir as session_dir.
    /// Each test gets a fresh tempdir name so parallel runs can't collide.
    fn test_state() -> ServerState {
        let (events_tx, _) = broadcast::channel::<DashboardEvent>(EVENTS_CHANNEL_CAP);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_dir = std::env::temp_dir().join(format!("ct-dash-test-{}", nanos));
        std::fs::create_dir_all(&session_dir).unwrap();
        ServerState {
            token: "test-token".to_string(),
            launch_id: "abc123".to_string(),
            port: 0,
            session_alive: Arc::new(AtomicBool::new(true)),
            events_tx,
            session_dir,
        }
    }

    fn req(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn req_authed(uri: &str, token: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header("Authorization", format!("Bearer {}", token))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn api_health_requires_auth() {
        let app = build_router(test_state());
        let resp = app.oneshot(req("/api/health")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn api_health_with_bearer_succeeds() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(req_authed("/api/health", "test-token"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn api_health_with_wrong_bearer_is_unauthorized() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(req_authed("/api/health", "wrong-token"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// Regression guard for the auth_layer "skip first-hit token" bypass: the
    /// check must match parameter NAME `t`, not the substring `t=`. Otherwise
    /// `?text=foo` would skip auth and reach root_handler. root_handler does a
    /// second-line validation so this isn't a security bug today, but it's a
    /// trap for future contributors copying the pattern.
    #[tokio::test]
    async fn root_with_text_param_does_not_bypass_auth() {
        let app = build_router(test_state());
        let resp = app.oneshot(req("/?text=foo")).await.unwrap();
        // Without a cookie or matching token, this must be 401.
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// `validate_relative_path` rejects `..`, so the file endpoint should
    /// return 400 — never 200, never reach the filesystem walker.
    #[tokio::test]
    async fn file_endpoint_rejects_path_traversal() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(req_authed(
                "/api/sessions/current/files/../etc/passwd",
                "test-token",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// When `session_alive=false`, the snapshot endpoint must short-circuit to
    /// `{ "status": "ended" }` (HTTP 200) so the SPA can flip its pill without
    /// having to also handle a 410 from the snapshot path. `/api/health`
    /// likewise still returns 200 with `session_alive: false`.
    #[tokio::test]
    async fn snapshot_returns_ended_when_session_dead() {
        let state = test_state();
        state.session_alive.store(false, Ordering::SeqCst);
        let app = build_router(state);
        let resp = app
            .oneshot(req_authed(
                "/api/sessions/current/snapshot",
                "test-token",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = to_bytes(resp.into_body(), 4096).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["status"], "ended");
    }

    /// Files endpoint returns 410 Gone when the session is dead — distinct
    /// from snapshot's `{status:"ended"}` shape because the file body would
    /// be a much larger response and the SPA's fetch wrapper switches on
    /// status code anyway.
    #[tokio::test]
    async fn file_endpoint_returns_410_when_session_dead() {
        let state = test_state();
        state.session_alive.store(false, Ordering::SeqCst);
        let app = build_router(state);
        let resp = app
            .oneshot(req_authed(
                "/api/sessions/current/files/anything.md",
                "test-token",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::GONE);
    }

    /// The auth_layer skips for `/?t=...` but the underlying root_handler
    /// must still reject a wrong token value.
    #[tokio::test]
    async fn root_with_wrong_token_query_is_unauthorized() {
        let app = build_router(test_state());
        let resp = app.oneshot(req("/?t=not-the-token")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
