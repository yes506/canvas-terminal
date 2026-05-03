# Spike 2 Results

## Run 1 — @claude1 (first reviewer; Option B acceleration) — 2026-05-02

**Environment**: macOS Darwin 25.4.0, stable Rust toolchain
**Command**: `cargo run --manifest-path rust/Cargo.toml --quiet`
**Result**: **PASS**

```
=== Spike 2: SIGHUP under setsid ===

supervisor: spawned shell pid=24331
supervisor: shell exited with ExitStatus(unix_wait_status(0))
supervisor: agent pid=24332 discovered
supervisor: my pgid=24305 agent pgid=24331
supervisor: setsid created separate pgid = true

phase 2: SIGHUP to supervisor's pgid (should NOT kill agent)
phase 2: agent alive after shell exit = true

phase 3: SIGTERM agent → cleanup hook fires
phase 3: agent died in Some(51.909667ms)
phase 3: cleanup hook fired = true

=== Spike 2 result: PASS ===
```

**Hypothesis status**: confirmed.
- `setsid()` in the simulated shell created a separate pgid (24331)
  distinct from the supervisor's pgid (24305) → SIGHUP to supervisor's
  pgrp would NOT propagate to the agent
- The agent (pid 24332) survived its parent shell's exit (clean
  decoupling)
- SIGTERM triggered the agent's cleanup handler, which wrote the
  `cleanup` sentinel before exiting

**Falsifier status**: NOT TRIPPED. Agent did not die on shell exit;
cleanup hook fired on the subsequent SIGTERM.

**Caveats / honest limitations**:
- This is a *simulation*. A real terminal pane closing sends SIGHUP
  via the kernel's tty layer to all processes in the controlling tty's
  pgrp BEFORE the shell exits. The simulation does not exercise the
  kernel tty path; it tests the structural decoupling that `setsid`
  provides.
- The `mut agent` warning + 1 `static_mut_refs` warning are stylistic
  in throwaway spike code; not load-bearing.
- A more rigorous future test would use `script(1)` to allocate a real
  pty + send SIGWINCH/EOF, but the structural property the spec relies
  on (separate pgid → SIGHUP isolation) is what this spike actually
  validates, and it does so correctly.

**Implication for Phase 3 / Phase 4**: agent provisioning code MUST
call `setsid()` (via `unistd::setsid` or equivalent in the spawn
chain) so the agent is in its own session/pgid. Without this, pane
close cascades into the agent. Spec.md §6.3 + §7 already require
process-group operations; Phase 3 provisioner must wire setsid() in.

**Implication for spec**: no amendment needed; structural assumption
holds.

---

## Run 2 — @claude2 — _pending_

(Append your run output. If you have access to a real terminal
emulator, augmenting with a `script(1)`-based real-tty test would
strengthen the convergence claim.)

## Run 3 — @codex2 — 2026-05-03

**Environment**: macOS Darwin, stable Rust toolchain
**Command**: `cargo run --manifest-path spikes/02-sighup-zsh-setsid/rust/Cargo.toml --quiet`
**Result**: **PASS**

Observed:
- `setsid` created a separate process group (`agent pgid=30522`,
  supervisor pgid `30520` in my run).
- The agent survived the shell/supervisor SIGHUP simulation.
- SIGTERM terminated the agent and the cleanup hook wrote its
  sentinel.

Compile warnings seen in the throwaway harness:
- `unused_mut` on `agent`
- `static_mut_refs` warning for the cleanup-path static

**Confirmation**: matches @claude1's PASS. Falsifier not tripped.

**Scope note**: this confirms the structural `setsid` process-group
isolation property, not a real terminal-emulator pane-close path. I
agree with the existing caveat that a future real-PTY/script(1) test
would strengthen evidence, but Phase 3 can proceed if provisioner code
always calls `setsid()` before handing control to the agent process.

---

## Pair convergence

**Converged: PASS** between @claude1 and @codex2.

Spike 2 can be treated as empirically confirmed for Phase 1, with the
implementation requirement that Phase 3 agent spawning wires `setsid()`
into the spawn chain.

---

## Additional confirmation — @codex3 — 2026-05-03

**Environment**: macOS Darwin, stable Rust toolchain
**Command**: `cargo run --manifest-path spikes/02-sighup-zsh-setsid/rust/Cargo.toml --quiet`
**Result**: **PASS**

Observed:
- `setsid` created a separate process group (`agent pgid=27722`, supervisor pgid `27719` in my run).
- Agent survived the shell/supervisor SIGHUP simulation.
- SIGTERM terminated the agent and the cleanup hook wrote its sentinel.

Compile warnings seen in the throwaway harness:
- `unused_mut` on `agent`
- `static_mut_refs` warning for the cleanup path static

**Confirmation**: matches @claude1's PASS. Falsifier not tripped.

**Note**: This remains a structural SIGHUP simulation, not a real terminal-pane close. I agree with the existing caveat that a future `script(1)`/real-PTY augmentation would strengthen this spike, but it does not block Phase 2 if the provisioner always calls `setsid()`.
