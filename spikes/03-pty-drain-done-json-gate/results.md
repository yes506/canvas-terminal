# Spike 3 Results

## Run 1 — @claude1 (first reviewer; Option B acceleration) — 2026-05-02

**Environment**: macOS Darwin 25.4.0, stable Rust toolchain
**Command**: `cargo run --manifest-path rust/Cargo.toml --quiet`
**Result**: **PASS 2/2 scenarios**

```
=== Spike 3: PTY drain across .done.json gate ===

scenario A: happy path
  drainer observed complete .done.json: true
  parsed: agent_id=agent-A summary="happy path complete"
  tempfile cleaned by rename: true
  snapshot file count: 1
  scenario A: PASS

scenario B: mid-write kill (no rename)
  pre-state: .done.json.tmp exists with truncated json (partial)
  drainer observed complete .done.json: false
  drainer observed partial .done.json: false
  .done.json.tmp still present: true
  .done.json present: false
  scenario B: PASS (drainer correctly never sees .done.json; falls through to Path B per S11)

=== Spike 3 result: PASS ===
```

**Hypothesis status**: confirmed.
- **Scenario A** (happy path): PTY-spawned shell wrote
  `.done.json.tmp` then atomically renamed to `.done.json`; drainer
  successfully read complete JSON via `serde_json::from_reader` per
  S1; tempfile cleaned by the rename
- **Scenario B** (mid-write kill): partial `.done.json.tmp` exists but
  no `.done.json` ever appeared; drainer correctly never observed a
  half-state. Per S11 precedence rule, this case falls through to
  Path B `forced_close`

**Falsifier status**: NOT TRIPPED. The S1 atomicity protocol holds
under PTY conditions: `tempfile + rename` is observably atomic from
the drainer's perspective; no half-state is visible.

**Implication for Phase 5 (Draining)**: agent code (or supervisor
wrapper around external CLI) MUST write `.done.json` via the
tempfile+rename pattern. This is the spec-mandated S1 protocol.
Drainer code MUST use `serde_json::from_reader` to validate
completeness — readers that succeed on partial files (e.g.,
streaming parsers with no end-of-document validation) would falsify
this assumption.

**Implication for spec**: no amendment needed; S1 protocol holds.

**Caveat / honest scope**:
- This spike validates the **drainer-side** atomicity observation,
  using tempfile+rename. It does NOT validate that all agent
  implementations (Claude Code CLI, Codex CLI, etc.) actually USE
  tempfile+rename for `.done.json`. That's a Phase 5 + supervisor-
  wrapper concern: the supervisor may need to intercept agent
  completion artifacts and write the final `.done.json` itself if
  the agent uses non-atomic write semantics.

---

## Run 2 — @claude3 — _pending_

(Append your run output. Worth augmenting with a real-process race
test (spawn a write+rename in PTY then SIGKILL between write and
rename) to strengthen scenario B confidence.)

## Run 3 — @codex3 — 2026-05-03

**Environment**: macOS Darwin, stable Rust toolchain
**Command**: `cargo run --manifest-path spikes/03-pty-drain-done-json-gate/rust/Cargo.toml --quiet`
**Result**: **PASS 2/2 scenarios**

Observed:
- Scenario A: drainer observed complete `.done.json`, parsed `agent_id=agent-A`, confirmed tempfile was cleaned by rename, and snapshot file count was 1.
- Scenario B: partial `.done.json.tmp` existed, `.done.json` never appeared, and drainer did not observe partial JSON.

Compile warning seen in the throwaway harness:
- unused import `std::path::Path`

**Confirmation**: matches @claude1's PASS. Falsifier not tripped. The S1 tempfile+rename protocol is valid from the drainer side.

---

## Pair convergence

**Converged: PASS** between @claude1 and @codex3.

Spike 3 can be treated as empirically confirmed for Phase 1. The Phase 5 implementation still must ensure the completion artifact is supervisor-controlled or otherwise forced through the same tempfile+rename protocol; this spike validates the protocol, not arbitrary external CLI write behavior.
