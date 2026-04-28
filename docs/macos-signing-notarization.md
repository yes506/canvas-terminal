# macOS Code Signing and Notarization

This project builds a macOS app bundle and DMG through Tauri:

- App bundle: `src-tauri/target/release/bundle/macos/Canvas Terminal.app`
- DMG: `src-tauri/target/release/bundle/dmg/Canvas Terminal_<version>_aarch64.dmg` or similar

For public distribution outside the App Store, the macOS app must be signed with a `Developer ID Application` certificate and then notarized by Apple. The notarization ticket should be stapled before you upload the DMG to GitHub Releases or any download site.

## 1. Confirm your signing identity

If you already imported your Apple certificate into Keychain, list the available code-signing identities:

```bash
security find-identity -v -p codesigning
```

Look for an identity similar to:

```text
Developer ID Application: Your Name or Company (TEAMID)
```

Use that full string as `APPLE_SIGNING_IDENTITY`.

## 2. Build a signed app and DMG locally

Tauri can pick up the signing identity from the environment without changing `tauri.conf.json`.

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name or Company (TEAMID)"
npm install
npm run tauri:build
```

If signing succeeds, Tauri signs the generated `.app` and then packages the DMG under:

```bash
src-tauri/target/release/bundle/dmg/
```

## 3. Provide notarization credentials

Tauri supports two notarization auth modes. App Store Connect API keys are the cleaner long-term option.

### Option A: App Store Connect API key

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name or Company (TEAMID)"
export APPLE_API_ISSUER="YOUR_ISSUER_ID"
export APPLE_API_KEY="YOUR_KEY_ID"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_YOUR_KEY_ID.p8"
npm run tauri:build
```

### Option B: Apple ID + app-specific password

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name or Company (TEAMID)"
export APPLE_ID="your-apple-id@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
npm run tauri:build
```

When those variables are present, Tauri submits the signed app for notarization during the build.

## 4. Verify the result

After the build finishes, verify both the signature and notarization status:

```bash
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/Canvas Terminal.app"
spctl --assess --type execute --verbose=4 "src-tauri/target/release/bundle/macos/Canvas Terminal.app"
spctl --assess --type open --verbose=4 src-tauri/target/release/bundle/dmg/*.dmg
```

Expected results:

- `codesign` exits successfully
- `spctl` reports `accepted`
- The authority chain includes `Developer ID Application`

For a deeper signature inspection:

```bash
codesign -dv --verbose=4 "src-tauri/target/release/bundle/macos/Canvas Terminal.app"
```

## 5. Recommended release flow for this repo

For a local release on your Mac:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name or Company (TEAMID)"
export APPLE_API_ISSUER="YOUR_ISSUER_ID"
export APPLE_API_KEY="YOUR_KEY_ID"
export APPLE_API_KEY_PATH="$HOME/private_keys/AuthKey_YOUR_KEY_ID.p8"

npm ci
npm run tauri:build
open src-tauri/target/release/bundle/dmg/Canvas\ Terminal_*.dmg
```

Then upload the notarized DMG from `src-tauri/target/release/bundle/dmg/`.

## 6. Optional: persist the signing identity in Tauri config

If you always use the same local certificate, you can hardcode the identity in `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name or Company (TEAMID)"
    }
  }
}
```

Using the `APPLE_SIGNING_IDENTITY` environment variable is usually safer because it avoids committing personal certificate details.

## 7. CI/CD note

The [release workflow](../.github/workflows/release.yml) signs and notarizes DMGs on GitHub-hosted macOS runners for both `aarch64-apple-darwin` and `x86_64-apple-darwin`. Tags matching `v*` trigger the workflow; on success, the workflow attaches the notarized DMGs to a GitHub Release.

Required repository secrets:

- `APPLE_CERTIFICATE` — base64-encoded `Developer ID Application` `.p12`
- `APPLE_CERTIFICATE_PASSWORD` — password for the `.p12`
- `APPLE_SIGNING_IDENTITY` — the certificate Common Name, e.g. `Developer ID Application: Your Name (TEAMID)`. Used as a hint; the workflow resolves the SHA-1 token from the imported keychain at build time.
- `KEYCHAIN_PASSWORD` — any random string; used only to lock/unlock the temporary build keychain
- `APPLE_API_KEY` — base64-encoded `.p8` private key from App Store Connect
- `APPLE_API_KEY_ID` — the key ID associated with the `.p8`
- `APPLE_API_ISSUER` — the App Store Connect issuer UUID
- `APPLE_TEAM_ID` — your Apple Developer Team ID

How the workflow handles signing and notarization:

1. Imports the `.p12` into a fresh temporary keychain that is added to the user search list and made default.
2. Imports Apple's Developer ID G2 intermediate CA explicitly — macOS runners do not always have it pre-trusted.
3. Resolves the imported certificate to its SHA-1 identity (more robust than passing the CN string).
4. Stages the `.p8` API key under `$RUNNER_TEMP/private_keys/AuthKey_<id>.p8` and exports `APPLE_API_KEY_PATH`.
5. Runs `npx tauri build` inside a retry loop (up to 3 attempts). Tauri signs the `.app`, notarizes it, staples it, then signs and notarizes the DMG and staples that too. The retry exists because Apple's notary service can take 10+ minutes and the runner's NSURLSession occasionally drops the status long-poll with `NSURLError -1009`. Rust artifacts are cached, so retries link in seconds.
6. On failure, the workflow fetches the latest notarization submission's status and `notarytool log` and uploads them as a `notary-debug-<arch>` artifact, so the difference between a transient network drop and an actual Apple rejection is recoverable from CI alone.
7. Runs `codesign --verify`, `spctl`, and `xcrun stapler validate` against the resulting DMG before publishing.

Local builds remain a valid fallback path:

1. Build on your own Mac with the certificate installed in Keychain.
2. Let Tauri sign and notarize during `npm run tauri:build`.
3. Verify with `codesign` and `spctl`.
4. Upload the resulting notarized DMG.
