# Spike 4 — App Nap / SIGSTOP suspension during draining

Owner pair: @claude3 + @codex3 (per plan-rev-2 §3)
First-reviewer (Option B acceleration): @claude1
Spec source: `docs/worktree/spec.md` §11 spike #4 (post E4 correction:
heartbeat-expiry / wedged, NOT nonce mismatch)
Status: **draft → executing**

---

## Hypothesis (per E4-corrected spec §11)

After SIGSTOP > `heartbeat_timeout_secs + wedge_grace_secs`, the reaper
observes the lease as `wedged` (heartbeat expired per §3.4), SIGKILLs
the process group, and proceeds idempotently. A subsequent SIGCONT
does not corrupt cleanup because the killed process is gone — and even
if its PID were reused, the new process won't have our nonce.

Note: SIGSTOP does **not** invalidate the nonce. Nonce mismatch is the
PID-reuse hazard, not the suspension hazard. The stale condition is
heartbeat expiry → quiescent → wedged.

## Falsifier

Reaper does not detect the wedged state within `heartbeat_timeout_secs +
wedge_grace_secs`, OR a SIGCONT'd agent that survives somehow corrupts
cleanup.

## Harness

Rust simulating the supervisor + reaper relationship:
1. Spawn a child process (the "agent") that posts heartbeats every
   `heartbeat_interval` seconds by writing to a heartbeat file
2. Parent (acting as reaper) periodically reads the heartbeat file
3. Send SIGSTOP to child; observe heartbeat staleness over time
4. After `heartbeat_timeout + wedge_grace`, parent SIGKILLs the child's
   process group
5. Verify: child is dead; subsequent SIGCONT (we send to PID; will fail
   if killed) does not affect cleanup state

Acceptance: heartbeat staleness is detected within timeout window;
SIGKILL succeeds; resumed-agent simulation does not corrupt the
"cleanup" (we model cleanup as a sentinel file the reaper writes
post-kill).

## Files

- `README.md` — this file
- `rust/Cargo.toml` — minimal manifest with `nix`
- `rust/src/main.rs` — supervisor+reaper simulation harness
- `results.md` — reviewer run outputs
