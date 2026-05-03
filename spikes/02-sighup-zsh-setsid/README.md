# Spike 2 — SIGHUP under zsh + setsid

Owner pair: @claude2 + @codex2 (per plan-rev-2 §3 — largest spike per claude3 round-3 N4)
First-reviewer (Option B acceleration): @claude1
Spec source: `docs/worktree/spec.md` §11 spike #2
Status: **draft → executing**

---

## Hypothesis

An agent process started with `setsid` survives SIGHUP when its parent
zsh pane closes; the agent's parent becomes init (or a subreaper);
cleanup hooks fire on the agent's natural exit.

## Falsifier

Agent dies on pane close even with `setsid`, OR agent survives but
cleanup hooks never fire because no exit signal arrives.

## Harness

Pure-Rust simulation of the parent-pane-closes scenario. The "pane"
is simulated by:
1. Parent process (this binary, supervisor mode) spawns a child shell
   that does `setsid` then runs the agent
2. Parent sends SIGHUP to the shell process group AND exits the shell
   (simulating zsh dying when its tty closes)
3. Verify agent process survives (PID still exists; can be signaled)
4. Send SIGTERM to agent → agent exits cleanly via its own signal
   handler (which writes a "cleanup-done" file, simulating Path B
   cleanup hooks)

If `setsid` worked, the agent should be in a different session/pgid
from the dying shell, so SIGHUP to the shell's process group does
NOT propagate to the agent.

## Acceptance

≥2 reviewers, both observe: (a) agent survives the simulated pane
close, (b) cleanup hook (sentinel file write) fires on subsequent
SIGTERM.

## Files

- `README.md` — this file
- `rust/Cargo.toml` — minimal manifest with `nix`
- `rust/src/main.rs` — simulation harness
- `results.md` — reviewer run outputs
