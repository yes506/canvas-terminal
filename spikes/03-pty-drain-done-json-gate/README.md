# Spike 3 — PTY drain across `.done.json` gate

Owner pair: @claude3 + @codex3 (per plan-rev-2 §3)
First-reviewer (Option B acceleration): @claude1
Spec source: `docs/worktree/spec.md` §11 spike #3
Status: **draft → executing**

---

## Hypothesis

The PTY can be kept alive long enough for `.done.json` to be written
atomically (per S1: tempfile + rename), observed by the drainer via
`serde_json::from_reader`, and a complete diff snapshot taken before
teardown. Path A's atomicity protocol holds under realistic timing.

## Falsifier

PTY dies before snapshot. `.done.json` is partial (e.g., `tempfile.json`
exists but `.done.json` does not). The drainer reads a half-written
file or sees an inconsistent worktree state.

## Harness

Rust using `portable-pty` (same crate canvas-terminal uses, version 0.8).
1. Spawn a shell in a PTY (the "agent")
2. Send the agent a script: write `.done.json.tmp` → atomic rename to
   `.done.json` → exit
3. Drainer (this binary, supervisor mode) polls for `.done.json`
   complete via `serde_json::from_reader` per S1
4. Repeat with adversarial timing: agent killed mid-write (before
   rename) → drainer must NOT see a partial `.done.json`

The acceptance check covers TWO conditions:
- **Happy path**: agent completes write+rename → drainer reads complete
  JSON → snapshot OK
- **Mid-write kill path**: agent killed BETWEEN tempfile write AND
  rename → drainer never sees `.done.json`; correctly falls through
  to Path B (forced_close) per spec §2 precedence rule (S11)

## Acceptance

≥2 reviewers, both observe complete `.done.json` AND complete diff
snapshot under contrived close-mid-write timing AND no half-state
where drainer sees partial `.done.json`.

## Files

- `README.md` — this file
- `rust/Cargo.toml` — portable-pty 0.8 + serde_json + tempfile
- `rust/src/main.rs` — two-scenario harness
- `results.md` — reviewer run outputs
