//! Localhost dashboard server (v4+v5 plan).
//!
//! Architecture: an axum HTTP server bound to `127.0.0.1:0` inside the Tauri
//! process, serving a separate Vite-built SPA over the existing
//! `~/.cache/canvas-terminal/collab-memory/session-{pid}/` tree. The dashboard
//! is read-only in MVP. The server is lazy-started (first `open_dashboard()`
//! Tauri command call binds a port); subsequent calls reuse the same port.
//!
//! Lifecycle: `SESSION_ALIVE` on the shared `DashboardInfo` flips to `false`
//! as the FIRST statement of `WindowEvent::Destroyed` in `lib.rs`. This causes
//! the server to:
//!  - return `{ session_alive: false }` from `/api/health`,
//!  - return HTTP 410 Gone from `/api/sessions/current/events`
//!    and `/api/sessions/current/files/*path`,
//!  - short-circuit `/api/sessions/current/snapshot` to a `{ status: "ended" }`
//!    payload.
//!
//! The session is scoped to the live process (`current`); cross-process
//! enumeration was dropped from the v5 plan because every Tauri instance
//! binds its own dashboard server on its own port.
//!
//! `with_graceful_shutdown` then drains in-flight requests cleanly. The
//! file-watcher task notices `session_alive == false` on its next tick
//! (≤ WATCH_INTERVAL after destroy) and exits.
//!
//! Auth: per-launch random hex token. First load `GET /?t=TOKEN` is a server
//! handler that validates the token, sets a per-launch cookie
//! (`ct_dash_<launch_id>`), and redirects (HTTP 303 See Other; see
//! `server::root_handler` for the 302-vs-303 rationale) to `/`. The token
//! never enters browser history. Subsequent requests authenticate via cookie
//! OR query OR `Authorization: Bearer` header (header for non-EventSource
//! API callers that want to avoid query-string token visibility).
//!
//! The launch_id and cookie name are NOT injected into the SPA bundle. The
//! SPA only needs `credentials: 'include'`; the browser attaches all
//! `ct_dash_*` cookies for the origin and the server matches its own.

pub mod server;
pub mod state;

pub use state::DashboardInfo;
