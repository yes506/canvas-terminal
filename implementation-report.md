# Implementation report — browser-localfile

## Source

- Planner marker: `system` from commit `d41d8cb` on `feat/browser-integration`
- Planner artifacts: `architecture.html` (197 lines), `architecture.mmd` (4 lines)
- Source basis: planner's Phase-5 skeleton at `commands/localfile.rs` + `state.rs` LocalFileTokenStore trait, with 9-field docstring contracts for all 10 method nodes
- Constraints honored at impl time: C1 three-way invariant, C7 deny-prefix list (planner-committed), C8 async handler, C9 path-based URL shape, F8 revocation hooks

## Work queue summary

- Total items: 10
- Completed: 10
- Blocked: 0

## Files changed

| Path | Δ lines | Notes |
|---|---|---|
| `src-tauri/Cargo.toml` | +1 / 0 | +`mime_guess = "2"`; tokio features +`fs` |
| `src-tauri/Cargo.lock` | (auto) | regenerated for `mime_guess` |
| `src-tauri/src/state.rs` | ~80 / ~10 | filled 4 trait bodies (`mint`, `lookup`, `revoke_for_tab`, `clear`); +1 `#[allow(dead_code)]` on `TokenEntry::minted_at` (v1 C6 — no TTL, intentional) |
| `src-tauri/src/commands/localfile.rs` | ~140 / ~50 | filled 6 fn bodies; added private helpers `build_deny_prefixes`, `disposition_for_mime`, `empty_response`; removed `#[allow(unused_imports)]` (trait now used) |
| `src-tauri/src/commands/browser.rs` | ~70 / ~10 | extended `validate_browser_url` localfile branch; added `LocalFileTokenRegistry` param to `destroy_browser_tab[_impl]`, `destroy_all_browser_tabs[_impl]`, `navigate_browser_tab`; F8 revocation hooks; +2 unit tests with 8 case asserts |
| `src-tauri/src/lib.rs` | +20 / -6 | `.manage(LocalFileTokenRegistry::new())`; `register_asynchronous_uri_scheme_protocol("localfile", ...)`; added `mint_localfile_token` to invoke_handler; updated `WindowEvent::Destroyed` + `RunEvent::Exit` to pass localfile_registry through |
| `src/lib/urlScheme.ts` | +15 | C1 mirror — strict `localfile://localhost/<22>` allow branch, malformed `localfile:` returns filter |
| `src/lib/urlScheme.test.ts` | +50 | new "LOCALFILE (C1 / C9)" describe block with 8 cases mirroring the Rust unit tests |
| `src/lib/browserIpc.ts` | +18 | `mintLocalFileToken(tabId, path)` wrapper |
| `src/components/browser/OpenFileButton.tsx` | NEW 65 | dialog → mint → navigate; errors via existing `setTabError` channel |
| `src/components/browser/NavControls.tsx` | +2 | mount OpenFileButton as leftmost icon |
| `.gitignore` | +1 | `.implementer-state.json` |

## Validation

- **Baseline exit (`BASE_BRANCH` HEAD, before any impl)**: 0 (cargo test --lib: 12/12 passing)
- **Final validation command**: `(cd src-tauri && cargo test --lib) && npm test && npm run build`
- **Final exit**: 0 (clean first run after one fix to test fixtures — see "Per-item outcomes")
- **Auto-fix attempts used**: 0/3 (no Phase-4 loop fired; the lone fix happened during Phase 3 self-check)

```
cargo test --lib:   running 14 tests
                    14 passed; 0 failed; 0 ignored
npm test:           Test Files  12 passed (12)
                    Tests  216 passed (216)
npm run build:      app:        ✓ built in 3.53s
                    dashboard:  ✓ built in 473ms
```

## Per-item outcomes

| item_id | status | files_touched | notes |
|---|---|---|---|
| `classify_mime` | completed | localfile.rs, Cargo.toml | `mime_guess::from_path` + octet-stream fallback. One-liner per contract. |
| `validate_picked_path` | completed | localfile.rs | 4-step impl: symlink_metadata(input) → canonicalize → is_file → deny-prefix. `/usr/local` exception per C7. |
| `build_localfile_response` | completed | localfile.rs | Status 200 + full v1 header set + MIME-class disposition. Helper `disposition_for_mime` factored out. |
| `validate_localfile_url_shape` | completed | localfile.rs | Strict prefix match + 22-char length + alphabet check. No URL parsing — direct string ops match the C9 spec exactly. |
| `LocalFileTokenStore::lookup` | completed | state.rs | Returns `None` on miss OR tab-mismatch (deliberate info-leak-prevention per docstring); poison swallowed to `None`. |
| `LocalFileTokenStore::clear` | completed | state.rs | Drain + return count; poison swallowed to 0. |
| `LocalFileTokenStore::revoke_for_tab` | completed | state.rs + browser.rs | `HashMap::retain` for the registry; F8 hooks in browser.rs at destroy/navigate. Required signature change on `destroy_browser_tab_impl` + `destroy_all_browser_tabs_impl` (added `localfile_registry` arg) — in-scope because the plan explicitly listed those as F8 call sites. |
| `LocalFileTokenStore::mint` | completed | state.rs | Under-lock token generation (16 bytes OsRng → `URL_SAFE_NO_PAD` base64 → 22 chars) with collision check capped at 32 retries before `TokenSpaceExhausted`. `rand::rngs::OsRng` (already in deps, no Cargo change beyond mime_guess). |
| `mint_localfile_token` | completed | localfile.rs, lib.rs, Cargo.toml, browserIpc.ts, OpenFileButton.tsx, NavControls.tsx | Tauri command orchestrates validate → classify → mint; lib.rs adds to invoke_handler + .manage; TS plumbing complete (button mounts as leftmost NavControls icon). |
| `localfile_protocol_handler` | completed | localfile.rs, lib.rs | Sync derives tab_id + lookup, then spawns tokio task for fs metadata + read + response build. 404 on miss/mismatch/missing-prefix; 413 on >256MiB; 500 on read error. Registered via `register_asynchronous_uri_scheme_protocol` (C8). |

**Mid-Phase-3 fix (NOT a Phase-4 autofix)**: my unit-test fixture token was 23 chars instead of 22; caught by the first `cargo test --lib` run, fixed in 2 edits (Rust + TS), re-ran clean. Counted as developer error in queue execution, not as a validation auto-fix attempt.

## Scope-discipline self-check

- [x] **No new interfaces / files outside hints**: only `OpenFileButton.tsx` was new, listed in item-9 `files_hinted`.
- [x] **No renames of committed public names**: `LocalFileTokenStore`, `LocalFileTokenRegistry`, `TokenEntry`, `RegistryError`, `Token`, plus all 10 method/fn names unchanged from the planner.
- [x] **No signature changes on planner-committed methods**: the four `LocalFileTokenStore` trait methods + the 6 `commands::localfile` fns kept their exact signatures.
  - *Note*: `destroy_browser_tab_impl`, `destroy_all_browser_tabs_impl`, `navigate_browser_tab` gained a `LocalFileTokenRegistry` param — these are pre-existing functions explicitly listed by the plan (F8) as revocation-hook call sites; modifying them to wire revocation is in-scope by the plan's own constraint. The planner did NOT commit interface signatures on `commands::browser`'s existing public surface; that surface is the plan's "files to modify" set.
- [x] **No edits to `validation_command` configuration**: tests + build scripts unchanged in `package.json`.
- [x] **No edits to files outside the work queue's hint set**: every file edited appears in at least one item's `files_hinted`.

## What is NOT in v1 (deferred per planner out-of-scope)

- Save-as / download endpoint
- Drag-and-drop file → tab
- Directory open / listing
- File-change watching
- Windows / Linux platform validation (path-based protocol + `UriSchemeContext::webview_label` are portable in principle but unverified on those backends in this cycle)
- OS passkey / WebAuthn work

## What the user should sanity-check at Phase 6

1. The "Open File" icon appears at the leftmost position in the browser-drawer's NavControls row.
2. Click → native file picker → pick a PDF / PNG / HTML / TXT → renders inline in the active tab.
3. Pick a file → URL bar shows `localfile://localhost/<22-char-token>`.
4. Type `google.com` in the address bar → tab navigates away; pressing Back returns 404 instead of restoring the file (this is the documented v1 design — re-pick to re-mint).
5. Cmd+W close on the tab → token gone (verifiable by trying to re-navigate from elsewhere).
6. Path-traversal attempt: pick a file in `~/.ssh` (if you have one) → "path under deny-prefix" surfaces in the address bar's error display.

## Markers / commits

- Implementer worktree: `.worktrees/implementer-browser-localfile-61906-77933-24294`
- Implementer branch: `implementer/browser-localfile-61906-77933-24294`
- Impl commit: `91d0285`
- Will land on `feat/browser-integration` as a merge commit with subject `(impl-system, human-confirmed)` on user `confirm merge`.
