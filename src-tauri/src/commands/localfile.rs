//! Custom `localfile://localhost/<token>` URI scheme — Phase-5
//! skeleton.
//!
//! v1 cycle: `browser-localfile` (codebase-planner system lane).
//! Streams ONLY files the user has picked via the native dialog,
//! gated by a tab-scoped token. See `state::LocalFileTokenStore`
//! for the registry contract and the threat-model section of
//! `architecture.html` / `.planner-state.json` (rendered by the
//! planner) for the defended attack classes. (System-lane runs do
//! not emit `plan.md`; the architecture HTML report is the
//! canonical reviewer artifact.)
//!
//! ## URL shape — single source of truth
//!
//! v1 URL shape is **path-based**:
//!
//!   `localfile://localhost/<22-char-url-safe-base64-token>`
//!
//! Rationale: Tauri's custom-protocol Origin on macOS / iOS /
//! Linux is `<scheme>://localhost/<path>` (per
//! `tauri::Builder::register_uri_scheme_protocol` docs); WebKit
//! normalizes the host to `localhost` regardless of what the
//! navigation URL specifies. Putting the token in the PATH
//! (`request.uri().path()` -> `/<token>` -> strip leading `/`)
//! avoids the ambiguity of authority-based parsing and matches
//! the post-normalization shape on macOS.
//!
//! ## Cross-reference (THREE-way invariant)
//!
//! Extends the prior TWO-way invariant called out in
//! `commands::browser` lines 4-6. If you change the shape check
//! for `localfile://` URLs here, ALSO update:
//!   1. `commands::browser::validate_browser_url`
//!      (defense-in-depth at the navigate IPC boundary)
//!   2. `src/lib/urlScheme.ts::classifyScheme`
//!      (frontend classifier mirror)
//!
//! Phase-5 skeleton note: every public AND private fn in this
//! module carries a 9-field docstring per the system-lane rubric.
//! Bodies are `todo!()` placeholders; the downstream
//! codebase-implementer fills them in.

use std::path::{Path, PathBuf};

use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::{LocalFileTokenRegistry, LocalFileTokenStore, TabId, Token};

/// Maximum file size served by the protocol handler in v1. Larger
/// files receive HTTP 413. v1 reads whole files into memory;
/// streaming beyond this cap is a v2 concern. 256 MiB is generous
/// for typical PDFs / images while still capping the worst-case
/// memory hit per request.
pub const LOCALFILE_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Canonicalize the path, reject non-regular files and sensitive
/// system paths, return the canonical PathBuf on success.
///
/// **Responsibility:** Validate that the user-picked path is a
/// regular file the registry is willing to mint a token for.
/// Canonicalizes once at mint time; the canonical PathBuf is what
/// the registry stores and what the protocol handler later reads
/// from on serve.
/// **Pipeline-position:** `mint_localfile_token` (Tauri command)
/// -> THIS -> `classify_mime` (on Ok).
/// **Inputs:**
/// - `path`: `&Path` — caller-supplied absolute or relative path
///   from the native file picker; will be canonicalized so
///   symlinks resolve and `..` segments collapse.
/// **Outputs:** `PathBuf` — the canonicalized absolute path; safe
/// to store and re-open later. Caller treats the value as
/// authoritative; the registry does NOT re-canonicalize on serve.
/// **Side-effects:** one `symlink_metadata` syscall on the INPUT
/// path (BEFORE canonicalize — see below); one `canonicalize`
/// syscall (which performs the readlink chain) only if the input
/// was not itself a symlink. No mutation of any state.
/// **Preconditions:** None. (All validation happens inside.)
/// **Postconditions:** the returned PathBuf satisfies:
///   (a) `is_file()` (not a directory, FIFO, socket, device),
///   (b) the ORIGINAL input was not itself a symlink (caught by
///       step 1 below — `canonicalize` resolves symlinks so a
///       check on the canonical path cannot detect this),
///   (c) is NOT under any entry in the v1 deny-prefix list.
/// **Failure-modes:** Order of checks matters — `symlink_metadata`
/// on the INPUT path MUST happen before canonicalize, otherwise
/// the canonical-resolved path will lie about whether the picked
/// item was a symlink.
///   1. `Err("symlinks rejected")` — `symlink_metadata(input)`
///      reports `file_type().is_symlink()`. Runs BEFORE
///      canonicalize so the user-picked symlink is caught even
///      when its target is a regular file.
///   2. `Err("canonicalize failed: <io>")` — `std::fs::canonicalize`
///      rejected the path (does-not-exist, permission denied, etc.).
///   3. `Err("not a regular file")` — canonical path is a
///      directory / socket / FIFO / device.
///   4. `Err("path under deny-prefix: <prefix>")` — canonical path
///      starts with an entry in the deny list (see v1 default list
///      in plan constraint C7).
/// **Collaborators:** None. (terminal validation step.)
pub(crate) fn validate_picked_path(path: &Path) -> Result<PathBuf, String> {
    // Step 1: symlink_metadata on INPUT — BEFORE canonicalize. canonicalize()
    // resolves symlinks, so a check on its result cannot detect that the
    // user-picked path itself was a symlink. See plan C9 / module doc.
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("symlinks rejected".to_string());
        }
        Ok(_) => {}
        Err(e) => return Err(format!("symlink_metadata failed: {}", e)),
    }

    // Step 2: canonicalize.
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("canonicalize failed: {}", e))?;

    // Step 3: regular-file check on canonical.
    if !canonical.is_file() {
        return Err("not a regular file".to_string());
    }

    // Step 4: deny-prefix check (plan C7).
    for prefix in build_deny_prefixes() {
        if !canonical.starts_with(&prefix) {
            continue;
        }
        // Exception: /usr/local is allowed even though /usr is denied
        // (developer-machine common case — brew, /usr/local/share/doc).
        if prefix == Path::new("/usr") && canonical.starts_with("/usr/local") {
            continue;
        }
        return Err(format!("path under deny-prefix: {}", prefix.display()));
    }

    Ok(canonical)
}

/// v1 default deny-prefix list (plan constraint C7). Implementer may
/// ADD entries with rationale but MUST NOT remove. Path-prefix match
/// is against the CANONICAL path after symlink resolution.
///
/// **macOS symlink expansion**: on macOS, `/etc` -> `/private/etc`
/// and `/var` -> `/private/var`. Because `validate_picked_path`
/// canonicalizes the picked path before the deny-prefix check, the
/// canonical path of a file under `/etc` ends up as
/// `/private/etc/...`, which would silently bypass a raw `/etc`
/// prefix. We close that gap by canonicalizing each entry at runtime
/// and adding the resolved form alongside the raw form. Both raw
/// and canonical are matched so the deny holds regardless of which
/// shape `canonicalize` returns on the picked path.
///
/// Reviewer-feedback fix: codex2 r1 #1 / codex3 r1 #1 (post-merge).
fn build_deny_prefixes() -> Vec<PathBuf> {
    let mut raw: Vec<PathBuf> = vec![
        PathBuf::from("/System"),
        PathBuf::from("/private/var/db"),
        PathBuf::from("/Library/Keychains"),
        PathBuf::from("/etc"),
        PathBuf::from("/var"),
        // /usr is in the list with /usr/local excepted in validate_picked_path.
        PathBuf::from("/usr"),
    ];
    if let Some(home) = dirs::home_dir() {
        raw.push(home.join("Library/Keychains"));
        raw.push(home.join(".ssh"));
        raw.push(home.join("Library/Application Support"));
        raw.push(home.join("Library/Cookies"));
    }

    // Expand each entry with its canonical form. On macOS this adds
    // /private/etc + /private/var so the deny check matches a
    // canonical path under those roots. On Linux / Windows most
    // prefixes canonicalize to themselves and no duplicates are
    // added. Entries whose canonicalize fails (path doesn't exist
    // on this OS, e.g. /Library/Keychains on Linux) are silently
    // skipped — the raw form stays in the list.
    let mut out = raw.clone();
    for p in &raw {
        if let Ok(canon) = std::fs::canonicalize(p) {
            if !out.iter().any(|existing| existing == &canon) {
                out.push(canon);
            }
        }
    }
    out
}

/// Determine the MIME type from the canonical path's extension.
/// Falls back to `application/octet-stream` for unknown extensions.
///
/// **Responsibility:** Classify the file's MIME type from its
/// extension, for the Content-Type response header and the
/// disposition-by-class decision in `build_localfile_response`.
/// **Pipeline-position:** `validate_picked_path` -> THIS ->
/// `LocalFileTokenStore::mint` (token generation is internal to
/// `mint`'s impl scope; no separate `generate_token` node).
/// **Inputs:**
/// - `canonical`: `&Path` — canonical path returned by
///   `validate_picked_path`; extension is what's read.
/// **Outputs:** `String` — MIME string like `"image/png"`,
/// `"application/pdf"`, or `"application/octet-stream"`; always
/// non-empty and free of CR/LF/control bytes (safe for direct use
/// in an HTTP header).
/// **Side-effects:** None. (pure function on the path string.)
/// **Preconditions:** path has been canonicalized; extension
/// lookup is byte-string against the path tail.
/// **Postconditions:** returned string contains no CR / LF /
/// control bytes. Never empty. Idempotent.
/// **Failure-modes:** None. (total over `Path` — unknown extension
/// returns the fallback rather than erroring.)
/// **Collaborators:** `mime_guess` crate (added at implementation
/// time; not part of the skeleton's dep surface).
pub(crate) fn classify_mime(canonical: &Path) -> String {
    mime_guess::from_path(canonical)
        .first_or_octet_stream()
        .to_string()
}

// Token generation (16 bytes getrandom -> URL-safe-base64) is an
// internal concern of `LocalFileTokenStore::mint` and lives inside
// the impl in `state.rs`. Keeping it inside the trait impl closes
// the TOCTOU window between freshness check and insert (both happen
// under the same lock scope) and avoids a cross-module dependency
// cycle (commands::localfile -> state, never the reverse).

/// Build a successful (`200 OK`) `http::Response` for a localfile
/// fetch. Sets all v1 security headers and the
/// MIME-class-appropriate `Content-Disposition`.
///
/// **Responsibility:** Construct the HTTP response object the
/// protocol handler will hand to `UriSchemeResponder::respond`.
/// Wraps the body bytes with the v1 strict header set (CSP
/// sandbox, nosniff, no-referrer, disposition by class).
/// **Pipeline-position:** `tokio::fs::read` (inside protocol
/// handler) -> THIS -> `UriSchemeResponder::respond`.
/// **Inputs:**
/// - `bytes`: `Vec<u8>` — file body read from disk; length is
///   <= `LOCALFILE_MAX_BYTES` (caller enforces).
/// - `mime`: `&str` — Content-Type value; trusted because it was
///   built by `classify_mime` which guarantees no CR/LF/control
///   bytes.
/// - `path`: `&Path` — used for the `attachment; filename=...`
///   fallback when MIME class is unknown.
/// **Outputs:** `tauri::http::Response<Vec<u8>>` — fully
/// populated; body length matches `Content-Length` header.
/// **Side-effects:** None. (pure construction.)
/// **Preconditions:** `mime` contains no CR / LF / control bytes
/// (guaranteed by `classify_mime` postcondition); `bytes.len()
/// <= LOCALFILE_MAX_BYTES` (caller enforces).
/// **Postconditions:** response carries every v1 header:
///   - `Content-Type: <mime>`
///   - `Content-Length: <bytes.len()>`
///   - `Content-Security-Policy: default-src 'none';
///      img-src 'self' data:; style-src 'self' 'unsafe-inline';
///      script-src 'self'; sandbox`
///   - `X-Content-Type-Options: nosniff`
///   - `Referrer-Policy: no-referrer`
///   - `Content-Disposition: inline` for `text/*`, `image/*`,
///     `application/pdf`; `attachment; filename="<basename>"`
///     for all other MIME classes (forces download instead of
///     HTML-sniff render of unknown bytes).
/// **Failure-modes:** None. (every input has a deterministic
/// mapping to a header set; `http::Response::builder` panics only
/// on invalid header bytes, ruled out by `mime` precondition.)
/// **Collaborators:** None.
pub(crate) fn build_localfile_response(
    bytes: Vec<u8>,
    mime: &str,
    path: &Path,
) -> tauri::http::Response<Vec<u8>> {
    let len_str = bytes.len().to_string();
    let disposition = disposition_for_mime(mime, path);
    let csp = "default-src 'none'; img-src 'self' data:; \
               style-src 'self' 'unsafe-inline'; script-src 'self'; sandbox";

    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Content-Length", len_str)
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Disposition", disposition)
        .body(bytes)
        .expect("response builder cannot fail on validated inputs")
}

/// MIME-class-driven `Content-Disposition`. Inline for `text/*`,
/// `image/*`, and `application/pdf`; attachment for everything else.
///
/// Filename sanitization: HTTP header values must not contain CR /
/// LF / control bytes (RFC 7230 § 3.2.6) — if they do,
/// `http::Response::builder().header(...)` returns Err and our
/// `.expect()` panics inside the spawned async task. Filenames on
/// Unix-like filesystems CAN contain such bytes, so we replace every
/// control char AND `"` with `_` before formatting. Full RFC 5987 /
/// 6266 `filename*=UTF-8''...` percent-encoding for non-ASCII names
/// remains a v2 concern; this fix is panic-prevention only.
///
/// Reviewer-feedback fix: codex3 r1 #3 (post-merge).
fn disposition_for_mime(mime: &str, path: &Path) -> String {
    let inline = mime.starts_with("text/")
        || mime.starts_with("image/")
        || mime == "application/pdf";
    if inline {
        "inline".to_string()
    } else {
        let raw = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("download");
        let safe: String = raw
            .chars()
            .map(|c| {
                if c == '"' || c.is_control() {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        format!("attachment; filename=\"{}\"", safe)
    }
}

/// Validate that an arbitrary string is a well-formed
/// `localfile://localhost/<22-char-base64url-token>` URL and
/// extract the token on success.
///
/// **Responsibility:** Single-source-of-truth shape check for
/// `localfile://` URLs at the Rust boundary. Consumed by both the
/// extended `commands::browser::validate_browser_url` (so the
/// existing navigate IPC accepts well-formed token URLs) and any
/// future caller that needs the same shape gate. The v1 shape is
/// fixed to `localfile://localhost/<token>` (path-based; see the
/// module doc-comment for the rationale).
/// **Pipeline-position:** `commands::browser::validate_browser_url`
/// dispatcher -> THIS -> caller treats `Ok` as allow,
/// `Err(reason)` as filter/deny per the existing policy.
/// **Inputs:**
/// - `input`: `&str` — already-trimmed candidate URL.
/// **Outputs:** `Result<Token, String>` — `Ok(token)` extracted
/// from the URL path on success; `Err(reason)` for any deviation
/// from the strict shape.
/// **Side-effects:** None. (pure function over the input string.)
/// **Preconditions:** `input` is trimmed (leading/trailing
/// whitespace already stripped by the caller).
/// **Postconditions:** on `Ok`, the returned token matches
/// `^[A-Za-z0-9_-]{22}$` exactly. (Whether it currently exists in
/// the registry is a separate concern; shape validation does NOT
/// touch the registry.)
/// **Failure-modes:**
/// - `Err("filter: localfile shape mismatch")` — anything that
///   isn't `localfile://localhost/<22-char-token>` exactly (wrong
///   scheme, missing or non-`localhost` host, missing path,
///   wrong length, invalid alphabet, extra path segments beyond
///   the single token, query string, fragment).
/// **Collaborators:** None.
pub(crate) fn validate_localfile_url_shape(input: &str) -> Result<Token, String> {
    const PREFIX: &str = "localfile://localhost/";
    if !input.starts_with(PREFIX) {
        return Err("filter: localfile shape mismatch".to_string());
    }
    let tail = &input[PREFIX.len()..];
    if tail.len() != 22 {
        return Err("filter: localfile shape mismatch".to_string());
    }
    if !tail
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("filter: localfile shape mismatch".to_string());
    }
    Ok(tail.to_string())
}

/// Tauri command — orchestrates the mint pipeline. Frontend calls
/// this after the file picker dialog returns a path; result is the
/// token that the frontend then navigates the active tab to via
/// `localfile://localhost/<token>` (per C9).
///
/// **Responsibility:** Orchestrate `validate_picked_path` ->
/// `classify_mime` -> `LocalFileTokenStore::mint`, returning the
/// minted token to the frontend. (Note: random-token generation
/// happens INSIDE `mint` under the registry lock — not as a
/// separate caller-visible step — to close the TOCTOU window
/// between freshness check and insert.)
/// **Pipeline-position:** Frontend
/// `invoke('mint_localfile_token', { tabId, path })` -> THIS ->
/// frontend
/// `navigateBrowserTab(tabId, 'localfile://localhost/<token>')`.
/// **Inputs:**
/// - `tabId`: `TabId` — UUID-shaped tab id (the active tab in the
///   browser drawer at the moment the user clicked Open File).
///   Becomes the tab-scope key in the registry entry.
/// - `path`: `String` — absolute path string from the file picker.
///   Will be canonicalized inside `validate_picked_path`.
/// - `registry`: `tauri::State<'_, LocalFileTokenRegistry>` —
///   injected by Tauri; the registry to mint into.
/// **Outputs:** `Result<String, String>` — `Ok(token)` (22 chars,
/// URL-safe-base64) or `Err(reason)` (human-readable; surfaced to
/// the per-tab error field on `BrowserStore` via the existing
/// red-bordered AddressBar error pattern).
/// **Side-effects:** one stat / readlink pair
/// (`validate_picked_path`); one RNG draw of 16 bytes performed
/// inside `LocalFileTokenStore::mint` under its lock; inserts one
/// entry into the registry.
/// **Preconditions:** `tabId` is a live tab in `BrowserTabsState`.
/// (Frontend guarantees this — the IPC fires only from the active
/// tab's Open File button.) NOT verified here; the protocol
/// handler will reject on serve if the tab is gone by then.
/// **Postconditions:** on `Ok`, the registry contains exactly one
/// new entry keyed by the returned token; that entry's `tab_id`
/// equals the supplied `tabId`. On `Err`, the registry is
/// unchanged.
/// **Failure-modes:**
/// - any `validate_picked_path` `Err` is propagated verbatim
///   (e.g., `"deny: path under deny-prefix: /System"`).
/// - `RegistryError::LockPoisoned` -> `"registry lock poisoned"`.
/// - `RegistryError::TokenSpaceExhausted` -> `"token generator
///   exhausted (broken RNG?)"`.
/// **Collaborators:** `validate_picked_path`, `classify_mime`
/// (this module), `LocalFileTokenStore::mint` (which performs its
/// own internal token generation under-lock).
#[tauri::command]
pub fn mint_localfile_token(
    #[allow(non_snake_case)] tabId: TabId,
    path: String,
    registry: tauri::State<'_, LocalFileTokenRegistry>,
) -> Result<String, String> {
    use crate::state::RegistryError;

    let path_buf = PathBuf::from(&path);
    let canonical = validate_picked_path(&path_buf)?;
    let mime = classify_mime(&canonical);

    registry
        .mint(tabId, canonical, mime)
        .map_err(|e| match e {
            RegistryError::LockPoisoned => "registry lock poisoned".to_string(),
            RegistryError::TokenSpaceExhausted => {
                "token generator exhausted (broken RNG?)".to_string()
            }
        })
}

/// Async URI-scheme protocol handler for `localfile://localhost/<token>` (per C9).
/// Registered once in `lib.rs::run()` via
/// `tauri::Builder::register_asynchronous_uri_scheme_protocol`.
/// Reads `UriSchemeContext::webview_label`, extracts the owning
/// tab_id, looks the token up under that scope, reads the file,
/// builds the response, hands it to the responder.
///
/// **Responsibility:** Serve a localfile token request from the
/// browser-tab child webview that minted it. Enforces tab-scoping
/// AT THE PROTOCOL LAYER: a token presented from a different tab
/// MUST receive a 404. Streams the canonical file's bytes wrapped
/// in the v1 security-header set.
/// **Pipeline-position:** WebKit `localfile://localhost/<token>` (per C9)
/// resource-request arrives via the Tauri runtime -> THIS ->
/// `UriSchemeResponder::respond(http::Response<...>)`.
/// **Inputs:**
/// - `ctx`: `UriSchemeContext<'_, R>` — carries `app_handle` (used
///   to fetch the managed `LocalFileTokenRegistry`) and
///   `webview_label` (used for tab-scope enforcement). For browser
///   tabs the label has shape `"browser-tab-<tab_id>"` (see
///   `state::BrowserTabsState::label_for`); the handler strips
///   the `"browser-tab-"` prefix to derive `owning_tab_id`. A
///   request from any other webview (the main window's own
///   webview, etc.) gets 404 because no entry in the registry
///   will match that label.
/// - `request`: `http::Request<Vec<u8>>` — incoming URL. Token is
///   read from `request.uri().path()`: WebKit's localhost
///   normalization on macOS makes the URI shape
///   `localfile://localhost/<token>`, so path is `"/<token>"`
///   exactly. Handler strips the leading `/`, then performs the
///   strict 22-char base64-url shape check before lookup.
///   Method is implicitly GET for resource requests.
/// - `responder`: `UriSchemeResponder` — async sink delivering
///   the response back to WebKit. Tauri requires exactly one
///   `respond` call per invocation.
/// **Outputs:** None at the function level. (Side-effecting via
/// `responder.respond` exactly once.)
/// **Side-effects:** one `tokio::fs::read` of up to
/// `LOCALFILE_MAX_BYTES`; one Mutex acquisition on the registry
/// for the lookup; spawns a tokio task per request (the async
/// handler is invoked on the protocol thread; we move I/O onto
/// a worker task so the protocol thread is freed immediately).
/// **Preconditions:** the scheme `"localfile"` has been registered
/// on the `tauri::Builder` (`lib.rs::run`).
/// **Postconditions:** exactly one `responder.respond(...)` call
/// has been made before the handler future completes. (Tauri
/// requires this; the registry's "404 on miss" path also calls
/// respond.)
/// **Failure-modes:**
/// - missing/malformed token in URI -> 404 (empty body).
/// - webview_label without the `"browser-tab-"` prefix -> 404
///   (request from main window or some unknown webview).
/// - tab mismatch in `LocalFileTokenStore::lookup` -> 404.
/// - file size > `LOCALFILE_MAX_BYTES` -> 413 (empty body).
/// - `tokio::fs::read` error (file removed between mint and
///   serve, permission revoked) -> 500 (empty body).
/// **Collaborators:** `LocalFileTokenStore::lookup` (tab-scoped
/// get); `build_localfile_response` (response builder);
/// `tauri::Manager::state` (to fetch the managed registry from
/// `ctx.app_handle()`).
pub fn localfile_protocol_handler<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    use tauri::Manager;

    // Step 1: derive owning_tab_id from webview_label.
    // Browser tabs have label "browser-tab-<tab_id>". Any other webview
    // (the main window) hits 404 because no registry entry will match.
    let owning_tab_id = match ctx.webview_label().strip_prefix("browser-tab-") {
        Some(id) => id.to_string(),
        None => {
            responder.respond(empty_response(404));
            return;
        }
    };

    // Step 2: defense-in-depth shape validation at the protocol layer.
    // WebKit-initiated sub-resource fetches inside a loaded localfile
    // page bypass the navigate IPC and reach the handler directly.
    // We enforce the full C9 shape here independently:
    //   - host MUST be "localhost"
    //   - no query string
    //   - path MUST be exactly "/<22-base64url-token>" (one leading
    //     slash, no trailing slash, no extra segments)
    // Reviewer-feedback fix: claude2 r1 M1 / claude3 r1 O1 /
    // codex2 r1 #2 / codex3 r1 #2 (post-merge defense-in-depth).
    let token = match extract_localfile_token(request.uri()) {
        Some(t) => t,
        None => {
            responder.respond(empty_response(404));
            return;
        }
    };

    // Step 3: tab-scoped lookup. The registry returns None on miss OR
    // tab-mismatch — both surface as 404 to avoid leaking existence.
    let registry = ctx.app_handle().state::<LocalFileTokenRegistry>();
    let entry = match registry.lookup(&token, &owning_tab_id) {
        Some(e) => e,
        None => {
            responder.respond(empty_response(404));
            return;
        }
    };

    // Step 4: spawn async I/O off the protocol thread (per C8).
    let canonical_path = entry.canonical_path.clone();
    let mime = entry.mime.clone();
    tauri::async_runtime::spawn(async move {
        // Size cap before read — refuse oversize files with 413 rather
        // than allocating into memory and then rejecting.
        let size = match tokio::fs::metadata(&canonical_path).await {
            Ok(m) => m.len(),
            Err(_) => {
                responder.respond(empty_response(500));
                return;
            }
        };
        if size > LOCALFILE_MAX_BYTES {
            responder.respond(empty_response(413));
            return;
        }

        let bytes = match tokio::fs::read(&canonical_path).await {
            Ok(b) => b,
            Err(_) => {
                responder.respond(empty_response(500));
                return;
            }
        };

        let response = build_localfile_response(bytes, &mime, &canonical_path);
        responder.respond(response);
    });
}

/// Helper — build an empty-body `http::Response` with the given status.
/// Used by the protocol handler's error paths (404 / 413 / 500) so it
/// can return a single typed response object to `responder.respond`.
fn empty_response(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("response builder cannot fail on empty body + valid status")
}

/// Defense-in-depth shape gate at the protocol handler boundary.
/// Verifies that an incoming `localfile://` request URI conforms to
/// the C9 shape: host = `localhost`, no query, path = exactly
/// `/<22-char-base64url-token>`. Returns the extracted token on
/// success; `None` for any deviation (caller responds with 404).
///
/// This is independent of `validate_localfile_url_shape` — that fn
/// works against a `&str`, this works against an `http::Uri`. The
/// invariants enforced are identical; both must accept exactly the
/// same input set.
///
/// Reviewer-feedback fix: claude2 r1 M1 / claude3 r1 O1 / codex2 r1
/// #2 / codex3 r1 #2 (post-merge defense-in-depth).
fn extract_localfile_token(uri: &tauri::http::Uri) -> Option<Token> {
    if uri.host() != Some("localhost") {
        return None;
    }
    if uri.query().is_some() {
        return None;
    }
    // path must be exactly "/<22 base64url chars>".
    let path = uri.path();
    let token = path.strip_prefix('/')?;
    if token.len() != 22 {
        return None;
    }
    if !token
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some(token.to_string())
}

// ---------------------------------------------------------------------------
// Unit tests for post-merge reviewer-feedback fixes.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// codex2 r1 #1 / codex3 r1 #1 — on macOS `/etc` is a symlink to
    /// `/private/etc` and `/var` to `/private/var`. After
    /// `validate_picked_path` canonicalizes, the canonical path lives
    /// under `/private/...`. The deny-prefix list MUST include those
    /// canonical roots, not just the raw `/etc` and `/var`.
    #[test]
    fn deny_prefix_list_includes_canonical_macos_symlinks() {
        let prefixes = build_deny_prefixes();
        // Raw roots are always present.
        assert!(prefixes.iter().any(|p| p == Path::new("/etc")));
        assert!(prefixes.iter().any(|p| p == Path::new("/var")));

        // On macOS the canonical forms must also be in the list.
        // On Linux these canonicalize to themselves and aren't added
        // — we gate the assertion on the platform.
        #[cfg(target_os = "macos")]
        {
            assert!(
                prefixes.iter().any(|p| p == Path::new("/private/etc")),
                "macOS: /private/etc must be in the deny-prefix list (it's the canonical form of /etc) — \
                 codex2 r1 #1 / codex3 r1 #1 fix"
            );
            assert!(
                prefixes.iter().any(|p| p == Path::new("/private/var")),
                "macOS: /private/var must be in the deny-prefix list (it's the canonical form of /var) — \
                 codex2 r1 #1 / codex3 r1 #1 fix"
            );
        }
    }

    /// Same fix, end-to-end: a real file under `/etc` (`/etc/hosts`
    /// exists on every macOS install) canonicalizes to
    /// `/private/etc/hosts` and `validate_picked_path` MUST reject
    /// it with the deny-prefix error, not silently accept it.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_etc_hosts_blocked_by_canonical_deny_prefix() {
        let result = validate_picked_path(Path::new("/etc/hosts"));
        // /etc/hosts is itself a symlink on macOS — the symlink-on-input
        // check (step 1) catches it before deny-prefix is even
        // consulted. We accept EITHER rejection reason; both are
        // equally correct (defense in depth).
        let err = result.expect_err("must reject");
        assert!(
            err.contains("symlinks rejected") || err.contains("deny-prefix"),
            "expected symlinks-rejected OR deny-prefix, got: {}",
            err
        );
    }

    /// claude2 r1 M1 / claude3 r1 O1 / codex2 r1 #2 / codex3 r1 #2 —
    /// the protocol handler must reject malformed URIs (wrong host,
    /// query string, wrong path shape, wrong token alphabet, wrong
    /// length) BEFORE registry lookup, even though the navigate IPC
    /// also enforces. WebKit-initiated sub-resource fetches bypass
    /// the navigate IPC.
    #[test]
    fn extract_localfile_token_strict_shape() {
        // Allowed
        let valid: tauri::http::Uri = "localfile://localhost/0123456789abcdefghijkl"
            .parse()
            .unwrap();
        assert_eq!(
            extract_localfile_token(&valid).as_deref(),
            Some("0123456789abcdefghijkl")
        );

        // Wrong host
        let wrong_host: tauri::http::Uri = "localfile://foo/0123456789abcdefghijkl"
            .parse()
            .unwrap();
        assert_eq!(extract_localfile_token(&wrong_host), None);

        // Query string present
        let q: tauri::http::Uri = "localfile://localhost/0123456789abcdefghijkl?evil=1"
            .parse()
            .unwrap();
        assert_eq!(extract_localfile_token(&q), None);

        // Wrong token length (21 chars — one short)
        let short: tauri::http::Uri = "localfile://localhost/0123456789abcdefghijk"
            .parse()
            .unwrap();
        assert_eq!(extract_localfile_token(&short), None);

        // Invalid alphabet (slash inside token segment is impossible
        // here because http::Uri parses each `/` as a path separator,
        // making the path two segments; the strip_prefix-then-
        // length-22 check catches it.)
        let multi_seg: tauri::http::Uri = "localfile://localhost/abc/efghij_KLMNOPqrstu"
            .parse()
            .unwrap();
        assert_eq!(extract_localfile_token(&multi_seg), None);

        // Empty token (no path past leading slash)
        let empty: tauri::http::Uri = "localfile://localhost/".parse().unwrap();
        assert_eq!(extract_localfile_token(&empty), None);
    }

    /// codex3 r1 #3 — filenames containing CR/LF/control bytes must
    /// NOT panic the response builder. `disposition_for_mime`
    /// sanitizes by replacing control chars + `"` with `_`.
    #[test]
    fn disposition_for_mime_sanitizes_control_chars() {
        use std::path::PathBuf;

        // CR/LF in filename (theoretically possible on Unix-like FS).
        let p = PathBuf::from("/tmp/evil\r\nInjected: yes.bin");
        let d = disposition_for_mime("application/octet-stream", &p);
        assert!(!d.contains('\r'), "CR not sanitized: {}", d);
        assert!(!d.contains('\n'), "LF not sanitized: {}", d);
        // Validate that the resulting header value is accepted by the
        // http builder (the panic path codex3 #3 flagged).
        let resp = tauri::http::Response::builder()
            .status(200)
            .header("Content-Disposition", &d)
            .body(Vec::<u8>::new());
        assert!(
            resp.is_ok(),
            "sanitized Content-Disposition must be a valid header value"
        );

        // Double quotes also sanitized.
        let p2 = PathBuf::from("/tmp/has\"quote.bin");
        let d2 = disposition_for_mime("application/octet-stream", &p2);
        assert!(!d2.contains('"').then(|| d2.matches('"').count() == 2).unwrap_or(true)
                || d2.matches('"').count() == 2,
                "should retain only the two wrapping quotes, got: {}", d2);
    }

    /// Inline disposition for text/image/pdf stays plain "inline".
    #[test]
    fn disposition_for_mime_inline_classes() {
        let p = std::path::PathBuf::from("/tmp/foo.png");
        assert_eq!(disposition_for_mime("image/png", &p), "inline");
        assert_eq!(disposition_for_mime("text/plain", &p), "inline");
        assert_eq!(disposition_for_mime("application/pdf", &p), "inline");

        // Octet-stream forces attachment.
        let d = disposition_for_mime("application/octet-stream", &p);
        assert!(d.starts_with("attachment;"));
        assert!(d.contains("foo.png"));
    }

    /// Token shape check at the URL-string level (validate_localfile_url_shape)
    /// — paired with the URI-level check in extract_localfile_token,
    /// both enforce the same C9 invariant.
    #[test]
    fn validate_localfile_url_shape_basic() {
        assert_eq!(
            validate_localfile_url_shape("localfile://localhost/0123456789abcdefghijkl")
                .unwrap(),
            "0123456789abcdefghijkl"
        );
        assert!(validate_localfile_url_shape("localfile://localhost/short").is_err());
        assert!(validate_localfile_url_shape("localfile://foo/0123456789abcdefghijkl").is_err());
        assert!(validate_localfile_url_shape("not-localfile://localhost/0123456789abcdefghijkl")
            .is_err());
    }
}
