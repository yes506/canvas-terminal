# Spike 4 Results

## Run 1 — @claude1 (first reviewer; Option B acceleration) — 2026-05-02

**Environment**: macOS Darwin 25.4.0, stable Rust toolchain
**Command**: `cargo run --manifest-path rust/Cargo.toml --quiet`
**Compressed timing**: heartbeat_interval=200ms, heartbeat_timeout=1500ms,
wedge_grace=1000ms (so wedged detection target = <2500ms after SIGSTOP)

**Result**: **PASS**

```
=== Spike 4: SIGSTOP suspension + reaper takeover ===

supervisor: spawned agent pid=24081
supervisor: initial heartbeat read = Some(91.004083ms)

phase 1: SIGSTOP agent
phase 1: wedged detected at Some(2.496769959s) after SIGSTOP (target: <7500ms)

phase 2: SIGKILL process group
phase 2: agent exit status = ExitStatus(unix_wait_status(9))
phase 2: killed cleanly = true

phase 3: write cleanup sentinel post-SIGKILL
phase 3: SIGCONT(dead pid) → Err (correct) (expect Err = correct)
phase 3: cleanup sentinel uncorrupted = true

=== Spike 4 result: PASS ===
```

**Hypothesis status**: confirmed.
- Wedged detection landed at 2.497s after SIGSTOP — exactly within
  one heartbeat tick of the heartbeat_timeout + wedge_grace = 2500ms
  threshold (i.e., the next 100ms reaper poll after the threshold).
- SIGKILL cleanly terminated the suspended agent.
- SIGCONT to the dead PID returned `Err(ESRCH)` — there's no process
  to corrupt cleanup with.
- Cleanup sentinel content unchanged.

**Falsifier status**: NOT TRIPPED. Reaper detected within budget;
SIGCONT'd-resumed agent could not corrupt cleanup (because the dead
PID can't be CONT'd).

**E4 correction validated**: SIGSTOP did NOT change the nonce. Stale
detection happened via heartbeat expiry (quiescent → wedged), exactly
as the post-E4-corrected spec §11 spike #4 hypothesis says.

**Caveat for Phase 4 implementation**: this spike kills by PID, not
process group. spec.md §6.3 + S9 require `killpg`. A real
implementation must call `setsid()` on agent spawn so the agent has
its own pgid, then `killpg(pgid, SIGKILL)`. The mechanism is the
same; the correctness comes from including all child processes the
agent may have spawned.

**Implication for spec**: no amendment needed; the assumption holds.

---

## Run 2 — @claude3 — _pending_

(Append your run output. Note timing-sensitive: very busy systems may
push wedged detection beyond the 2.5s target by hundreds of ms.
Increase budget if needed but document.)

## Run 3 — @codex3 — 2026-05-03

**Environment**: macOS Darwin, stable Rust toolchain
**Command**: `cargo run --manifest-path spikes/04-app-nap-sigstop-during-draining/rust/Cargo.toml --quiet`
**Result**: **PASS**

Observed:
- Initial heartbeat read succeeded.
- After `SIGSTOP`, wedged detection occurred at `2.484993875s`, within the compressed timing budget.
- `SIGKILL` terminated the suspended agent with wait status 9.
- `SIGCONT` to the dead PID returned an error, and cleanup sentinel content remained uncorrupted.

Compile warning seen in the throwaway harness:
- unused import `killpg`

**Confirmation**: matches @claude1's PASS. Falsifier not tripped. The corrected heartbeat-expiry model, not nonce mismatch, is the right mechanism.

---

## Pair convergence

**Converged: PASS** between @claude1 and @codex3.

Spike 4 can be treated as empirically confirmed for Phase 1. Phase 4/5 production code must use process-group kill (`killpg`) after `setsid()` provisioning, even though this harness validates the core suspended-process recovery path with a single child.
