# Operations runbook

Operational procedures for the Canvas Terminal updater pipeline.

---

## Updater key custody

Canvas Terminal uses Tauri's Ed25519 signed-update flow. Every released
`.app.tar.gz` is signed with a private key; the public key is embedded in the
shipped app's `tauri.conf.json` and verifies the signature at install time.

### About the public key in `tauri.conf.json`

`src-tauri/tauri.conf.json` contains `plugins.updater.pubkey`, which is a
base64-encoded Ed25519 public key. **Public keys are safe to commit** — only
the private key (held in 1Password and offline backup, see below) can produce
valid signatures. If you find yourself wondering "why is there a base64 blob
in committed config?", that's why.

### Generating the keypair (one-time, before the first updater-enabled release)

**Do this before any version bump**, including Phase 0's v0.3.8 cut.
`scripts/bump-version.sh` refuses to bump while the placeholder pubkey is
still present (defense against shipping a dead-on-arrival auto-updater), so
you'll hit the guard otherwise. Generating the keypair is independent of
which version ships first — the same pubkey is shipped in v0.3.8 (where the
updater code isn't called) and v0.3.9+ (where it is). It only needs to be
done once.

```bash
mkdir -p ~/.tauri
node_modules/.bin/tauri signer generate -w ~/.tauri/canvas-terminal-updater.key
```

Outputs:
- `~/.tauri/canvas-terminal-updater.key` — private key (NEVER commit)
- `~/.tauri/canvas-terminal-updater.key.pub` — public key

Replace the placeholder pubkey in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`) with the contents of the `.pub` file (single line,
no surrounding whitespace).

### Storing the private key

The private key produces signatures that all installed Canvas Terminal apps
will accept. **If the private key is lost, every installed copy of Canvas
Terminal is permanently cut off from auto-updates.** Store it in at least
two places:

1. **Primary**: 1Password, full file contents + the password used at
   `signer generate` time.
2. **Offline backup**: age-encrypted file on a USB stick or printed paper key,
   stored in a sealed envelope. Document the location.

### GitHub Actions secrets

For the release pipeline to sign updater tarballs:

- `TAURI_SIGNING_PRIVATE_KEY`: full file contents of
  `~/.tauri/canvas-terminal-updater.key` (multi-line — GitHub Secrets handles
  this fine).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password.

Add both via `Settings → Secrets and variables → Actions` on the production
repo (`yes506/canvas-terminal`).

---

## Recovery procedures

### If the private key is lost

The signature embedded in any future `latest.json` will not match what
installed apps verify against. Existing installs cannot auto-update past their
current version.

Recovery:

1. Generate a brand-new keypair (`tauri signer generate`).
2. Replace the pubkey in `tauri.conf.json` with the new public key.
3. Cut a release containing the new pubkey. Tag it loudly (e.g.,
   `v1.0.0-keyrotation`) in the release notes.
4. **Existing users must do a one-time manual download** of this release —
   their installed app cannot auto-update because the signature on the new
   `latest.json` won't verify against the old embedded pubkey.
5. From the rotation release onward, auto-update resumes normally.

### If a bad `latest.json` ships

Examples: wrong version string, tampered signature, broken artifact URL.

Recovery is **forward-only**:

1. Cut a higher-version tag with a corrected manifest.
2. Do **not** delete the bad release. HTTP caches (CDN, browser, Tauri's
   plugin internals) won't honor a delete; meanwhile users discover the bad
   release at the old URL until your higher-version manifest replaces
   `releases/latest/`.

The updater plugin always pulls
`https://github.com/yes506/canvas-terminal/releases/latest/download/latest.json`,
which GitHub resolves to the most-recent non-prerelease release. Once the
corrected higher-version release is up, all installed clients will pick it
up on their next auto-check.

---

## Smoke-test cycle (per release)

Before promoting a release candidate to production, validate the full
auto-update flow against a dedicated test repository.

### One-time setup

1. Create private repo `yes506/canvas-terminal-updater-test`. No secrets
   needed in this repo.
2. The production repo already contains `src-tauri/tauri.test.conf.json`,
   which overrides only the updater endpoint to point at the test repo.

### Per-release flow

1. **During Phase 1 implementation**: dev branch stays at v0.3.8 (Phase 0's
   restored installable baseline) but accumulates all updater code. Do NOT
   bump the version until smoke is green.

2. **Build the test client locally** with the test config patch:
   ```bash
   node_modules/.bin/tauri build --config src-tauri/tauri.test.conf.json
   ```
   `getVersion()` returns "0.3.8" (no edits needed). The app contains all
   updater code. The endpoint is overridden to the test repo.

3. **Bump to v0.3.9 and create the rc tag manually** (`scripts/bump-version.sh`
   currently rejects prerelease suffixes, so the rc is tagged manually):
   ```bash
   ./scripts/bump-version.sh 0.3.9
   git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
   git commit -m "chore: bump version to v0.3.9"
   git tag -a v0.3.9-rc.1 -m "Smoke test rc"
   git push && git push origin v0.3.9-rc.1
   ```
   Production `release.yml` runs end-to-end with prod secrets, producing real
   signed/notarized DMGs + `.app.tar.gz` + `.sig` as a **prerelease** GitHub
   Release. The artifacts have version `0.3.9` baked in (matching what the
   version files say); the GitHub Release is named `v0.3.9-rc.1`.

4. **Locally**, download the rc artifacts:
   ```bash
   gh release download v0.3.9-rc.1 \
     -p '*.app.tar.gz' -p '*.app.tar.gz.sig' \
     --repo yes506/canvas-terminal
   ```

5. **In the test repo**, manually upload as a non-prerelease `v0.3.9` release.
   The artifacts have version `0.3.9` baked in (from step 3's bump), so the
   manifest correctly says `"version": "0.3.9"` and matches what the binary
   reports — no semver loop:
   ```bash
   SIG_SI=$(cat Canvas-Terminal_0.3.9_apple-silicon.app.tar.gz.sig)
   SIG_IN=$(cat Canvas-Terminal_0.3.9_intel.app.tar.gz.sig)
   BASE="https://github.com/yes506/canvas-terminal-updater-test/releases/download/v0.3.9"
   cat > latest.json <<EOF
   {
     "version": "0.3.9",
     "notes": "Smoke test build",
     "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
     "platforms": {
       "darwin-aarch64": { "signature": "${SIG_SI}", "url": "${BASE}/Canvas-Terminal_0.3.9_apple-silicon.app.tar.gz" },
       "darwin-x86_64":  { "signature": "${SIG_IN}", "url": "${BASE}/Canvas-Terminal_0.3.9_intel.app.tar.gz" }
     }
   }
   EOF
   gh release create v0.3.9 *.app.tar.gz *.app.tar.gz.sig latest.json \
     --title "v0.3.9 (smoke test)" \
     --repo yes506/canvas-terminal-updater-test
   ```

   (Apple notarization is bound to bundle ID, not URL — re-uploading the same
   signed `.app.tar.gz` to a different repo preserves Gatekeeper validity. No
   prod secrets ever touch the test repo.)

6. Install the v0.3.8 test client built in step 2 on a clean Mac account.

### Fresh-install reset (DESTRUCTIVE — test account only)

Run between scenarios that require a clean install state. Removes the
installed app and all user state for Canvas Terminal:

```bash
osascript -e 'quit app "Canvas Terminal"' 2>/dev/null
rm -rf "/Applications/Canvas Terminal.app" \
       "$HOME/Library/Application Support/com.canvas-terminal.dev" \
       "$HOME/Library/Caches/com.canvas-terminal.dev" \
       "$HOME/Library/Preferences/com.canvas-terminal.dev.plist"
```

(Note: settings live under `com.canvas-terminal.dev/` — the bundle identifier
— not `Canvas Terminal/`, the product name. Tauri's `app_config_dir()` uses
the identifier on macOS.)

### Smoke-test scenarios

| # | Scenario | Pass criterion |
|---|---|---|
| 1 | Cold launch with default settings (auto-check ON) | Banner appears within ~3s with v0.3.9 detected |
| 2 | Click `Install` | Progress visible; on completion → "Restart now" prompt; click → relaunched app reports v0.3.9 |
| 3 | Click `Skip this version` (after fresh-install reset) | Banner hides; relaunching does not re-show; settings file shows `last_skipped_version: "0.3.9"` |
| 4 | Negative — tampered signature (after fresh-install reset) | Edit one byte of test repo's `latest.json` signature; install fresh v0.3.8; banner shows recovery-oriented message; does NOT install |
| 5 | Negative — offline | Disable network; auto-check fails silently; manual `Check for Updates…` shows graceful error |
| 6 | Negative — manifest 404 (after fresh-install reset) | Delete test repo's `latest.json`; auto-check silent; manual check shows graceful error |
| 7 | End-to-end install→relaunch round-trip | Step 2 covers it. Then run `xcrun stapler validate "/Applications/Canvas Terminal.app"` and `spctl --assess --type execute "/Applications/Canvas Terminal.app"` — both must succeed and `spctl` must report `source=Notarized Developer ID`. |
| 8 | Round-trip relaunched app behavior | After step 2's relaunch, manual `Check for Updates…` from now-v0.3.9 → banner shows "Canvas Terminal is up to date." and auto-dismisses after ~4s (binary 0.3.9 == manifest 0.3.9, no loop) |
| 9 | Auto-check disabled gates auto path but not manual | Fresh-install reset, then before launching the app: <br>`mkdir -p "$HOME/Library/Application Support/com.canvas-terminal.dev"` <br>`echo '{"auto_check_updates": false, "last_skipped_version": null}' > "$HOME/Library/Application Support/com.canvas-terminal.dev/settings.json"` <br>Launch — confirm no banner appears within 5s — then `Check for Updates…` and confirm it works |
| 10 | **Post-update offline launch (Gatekeeper offline validation)** | After step 2's relaunch and the scenario-7 validations, quit Canvas Terminal. Disable network (`networksetup -setairportpower en0 off` and unplug ethernet). Relaunch `/Applications/Canvas Terminal.app`. **Confirm it launches cleanly with no "Apple could not verify Canvas Terminal" dialog.** This validates that the auto-update install path (Tauri's plugin uses Rust `tar::Archive::unpack` internally, which has different xattr-handling semantics from GNU `tar --xattrs`) preserves enough of the staple ticket for offline Gatekeeper validation. The CI's `verify-staple-roundtrip.sh` proves the *tarball* is correct; this scenario proves the *user-side install* is correct. Re-enable network (`networksetup -setairportpower en0 on`) when done. |

### Promote rc to production

Once **all scenarios (1-10)** pass on the test repo, promote on the same
commit as the rc tag (version files already say `0.3.9`). Scenario 10
(post-update offline launch) is the one that validates the actual user-side
install path — do NOT skip it; it covers a class of breakage (xattr/staple
loss during Tauri's plugin extraction) that none of scenarios 1-9 exercises.

```bash
git tag -a v0.3.9 -m "Release v0.3.9"
git push origin v0.3.9
```

Production `release.yml` runs again; tag has no `-` → `prerelease: false` →
release lands at `releases/latest/`. From v0.3.9 onward, installed clients
will receive auto-update prompts on the next post-mount check.

---

## Migration notes

### v0.3.8 → v0.3.9 is a one-time manual install

v0.3.8 has no updater code, so installed v0.3.8 cannot auto-update to v0.3.9.
Users must manually download the v0.3.9 DMG from GitHub Releases and replace
`/Applications/Canvas Terminal.app`. State this loudly in the v0.3.9 release
notes and in README's "Updating" section.

From v0.3.9 onward, updates are automatic.
