import { invoke } from "@tauri-apps/api/core";
import type { IRecoveryOrchestrator } from "./IRecoveryOrchestrator";
import type { ITopologySnapshot } from "./ITopologySnapshot";
import type { IRecoverySession } from "./IRecoverySession";
import type { IPtyReattachClient } from "./IPtyReattachClient";
import type { IResilienceStore } from "../../stores/IResilienceStore";
import type {
  RootCauseSign,
  RecoveryDecision,
  RecoveryLaunch,
  RecoveryOutcome,
  DeathEvidence,
  TopologySnapshot,
  SnapshotPane,
} from "./types";
import { topologySnapshotService } from "./TopologySnapshotService";
import { recoverySessionClient } from "./RecoverySessionClient";
import { ptyReattachClient } from "./PtyReattachClient";
import { resilienceStore } from "../../stores/resilienceStore";
import { useCollaboratorStore } from "../../stores/collaboratorStore";
import { resilienceConfig } from "./config";

// ---------------------------------------------------------------------------
// Adoption-readiness barrier (plan node 12b) + bootstrap reload seed.
//
// Module-scope, NOT class members: the restored components (useTerminal's
// adopt branch, AgentMiniTerminal's adopt mode) signal readiness here without
// holding an orchestrator reference, and the bootstrap seeds the
// reload-in-progress flag BEFORE the first React render — the class field
// alone cannot be seeded pre-render without changing the planner-committed
// interface surface.
//
// Why the barrier exists (plan rev-2 3-way HIGH): `restoreShell()` only
// mutates Zustand stores; the `pty-data-{sessionId}` listeners are installed
// later, when React mounts the restored panes. Calling `reattach_pty` before
// those mounts would flush the Rust replay ring into the void. The barrier
// holds `resumeAfterReload()`'s Phase 2 until every expected adopt-mode mount
// has subscribed its listener (or the timeout lapses — timed-out ids are
// reported lost, never silently skipped).
// ---------------------------------------------------------------------------

/** Seeded true by the bootstrap when a durable pending session exists, so
 *  `isReloadInProgress()` suppresses teardown from the very first mount.
 *  Cleared on every `resumeAfterReload` exit path. */
let bootstrapReloadPending = false;

let barrierExpected: Set<string> | null = null;
const barrierReady = new Set<string>();
let barrierAllReady: (() => void) | null = null;
let barrierArmedResolve: (() => void) | null = null;
let barrierArmedPromise: Promise<void> | null = null;

/** Pre-render seed (bootstrap Phase A). */
export function seedReloadInProgress(pending: boolean): void {
  bootstrapReloadPending = pending;
  if (pending && barrierArmedPromise === null) {
    barrierArmedPromise = new Promise((resolve) => {
      barrierArmedResolve = resolve;
    });
  }
}

/**
 * Resolves once the barrier has been ARMED with the restored-session id set
 * (i.e. `restoreShell()` has seeded the stores) — or once recovery aborted
 * before arming. The bootstrap awaits this before the first render so the
 * default-tab effect never races the restore (tabs are already non-empty).
 */
export function adoptionBarrierArmed(): Promise<void> {
  return barrierArmedPromise ?? Promise.resolve();
}

/** Whether `sessionId` belongs to the in-flight restore (adopt, don't spawn). */
export function isRestoredSessionId(sessionId: string): boolean {
  return barrierExpected?.has(sessionId) ?? false;
}

/** Called by adopt-mode mounts AFTER their pty-data listener is subscribed. */
export function signalAdoptionReady(sessionId: string): void {
  if (!barrierExpected?.has(sessionId)) return;
  barrierReady.add(sessionId);
  if (barrierReady.size >= barrierExpected.size) {
    barrierAllReady?.();
  }
}

function armAdoptionBarrier(sessionIds: string[]): void {
  barrierExpected = new Set(sessionIds);
  barrierReady.clear();
  barrierArmedResolve?.();
}

/** Await all expected adoptions; returns the ids that timed out (⇒ lost). */
async function awaitAdoptionReadiness(timeoutMs: number): Promise<string[]> {
  if (!barrierExpected || barrierExpected.size === 0) return [];
  if (barrierReady.size >= barrierExpected.size) return [];
  await new Promise<void>((resolve) => {
    barrierAllReady = resolve;
    const timer = setTimeout(resolve, timeoutMs);
    // Wrap so an all-ready resolution also clears the timer.
    const prior = barrierAllReady;
    barrierAllReady = () => {
      clearTimeout(timer);
      prior();
    };
    // Re-check: signals that landed between the size check and handler
    // installation must not strand the barrier.
    if (barrierReady.size >= barrierExpected!.size) barrierAllReady();
  });
  barrierAllReady = null;
  return [...barrierExpected].filter((id) => !barrierReady.has(id));
}

/** Drop barrier state on every recovery exit path (also unblocks a bootstrap
 *  waiting on `adoptionBarrierArmed()` when recovery aborts before arming). */
function resetAdoptionBarrier(): void {
  bootstrapReloadPending = false;
  barrierExpected = null;
  barrierReady.clear();
  barrierAllReady = null;
  barrierArmedResolve?.();
  barrierArmedResolve = null;
  barrierArmedPromise = null;
}

/** Test-only reset — vitest isolation for the module-scope barrier state. */
export function _resetAdoptionBarrierForTests(): void {
  resetAdoptionBarrier();
}

/**
 * Collect the session ids that have a backing Rust PTY and therefore need
 * reattach, in tree order. A `terminal` leaf owns one PTY (its own sessionId).
 * A `collaborator` leaf is a CONTAINER — it renders <CollaboratorPane> and has
 * NO PTY of its own; the PTYs live in its per-agent tiles
 * (`leaf.agents[].sessionId`). Reattaching the container id targets a
 * non-existent PTY (Rust returns alive=false) and skips the agent ids that
 * actually survived — so we descend into agents and skip the container id.
 */
export function collectSnapshotSessionIds(snapshot: TopologySnapshot): string[] {
  const ids: string[] = [];
  const walk = (node: SnapshotPane): void => {
    if (node.type === "leaf") {
      if (node.kind === "terminal") {
        ids.push(node.sessionId);
      } else if (node.kind === "collaborator" && node.agents) {
        for (const agent of node.agents) ids.push(agent.sessionId);
      }
      return;
    }
    walk(node.children[0]);
    walk(node.children[1]);
  };
  for (const tab of snapshot.tabs) walk(tab.paneTree);
  return ids;
}

/**
 * Concrete IRecoveryOrchestrator — the reload-crossing recovery control loop,
 * split across the webview reload boundary and joined by the durable
 * IRecoverySession. prepareReloadRecovery runs in the OLD context;
 * resumeAfterReload runs in the FRESH context's bootstrap. The #3 evidence gate
 * (resilienceConfig.recoveryGateOpen, default CLOSED) keeps shouldRecover from
 * authorizing any reload until the staged rollout opens it.
 */
export class RecoveryOrchestrator implements IRecoveryOrchestrator {
  private reloadInProgress = false;

  constructor(
    private readonly topology: ITopologySnapshot = topologySnapshotService,
    private readonly session: IRecoverySession = recoverySessionClient,
    private readonly reattach: IPtyReattachClient = ptyReattachClient,
    private readonly store: IResilienceStore = resilienceStore,
  ) {}

  shouldRecover(sign: RootCauseSign): RecoveryDecision {
    // The #3 evidence gate is the central safety switch of the staged rollout.
    // While closed, NOTHING auto-recovers — only diagnostics accrue.
    if (!resilienceConfig.recoveryGateOpen) {
      return {
        proceed: false,
        sign,
        action: "none",
        reason: "#3 evidence gate closed — diagnostics only",
      };
    }
    switch (sign) {
      case "webcontent-death":
        return {
          proceed: true,
          sign,
          action: "reload-in-place",
          reason: "durable WebContent death — reload-crossing recovery",
        };
      case "js-fatal":
        // B recovers in-tree via the boundary's retry control, not a reload.
        return {
          proceed: false,
          sign,
          action: "none",
          reason: "js-fatal recovers in-tree via boundary retry",
        };
      case "gpu-loss":
        return {
          proceed: false,
          sign,
          action: "none",
          reason: "gpu-loss is advisory only — no auto-reload",
        };
      default:
        return {
          proceed: false,
          sign,
          action: "none",
          reason: "unknown sign — no auto-recovery",
        };
    }
  }

  async prepareReloadRecovery(
    decision: RecoveryDecision,
  ): Promise<RecoveryLaunch> {
    // Ensure a current persisted snapshot exists BEFORE the reload — under
    // hypothesis A the JS context will be gone at recovery time, so recovery
    // must start from durable state, never a post-failure capture.
    const snapshot = await this.topology.capture();
    await this.topology.persist(snapshot);

    // Open the durable session BEFORE requesting the reload. If this throws the
    // caller must NOT reload (else the fresh context boots with no intent) — we
    // simply propagate by not reaching the reload request below.
    const session = await this.session.begin(decision);
    this.reloadInProgress = true;

    if (decision.action === "recreate-webview") {
      // Native recreate is owned by Rust (deferred run); fire-and-forget.
      void invoke("recreate_webview").catch(() => {});
    } else {
      // reload-in-place: tear down + reboot this same webview (PID stable).
      try {
        window.location.reload();
      } catch {
        /* non-browser env (tests) — staging only */
      }
    }

    return {
      token: session.token,
      action: decision.action,
      reloadRequested: true,
    };
  }

  async resumeAfterReload(evidence: DeathEvidence): Promise<RecoveryOutcome> {
    const start = Date.now();
    const pending = await this.session.loadPending();
    if (!pending) {
      // No durable session — this was not an orchestrated reload.
      resetAdoptionBarrier();
      return {
        success: false,
        restoredSessions: 0,
        lostSessions: [],
        elapsedMs: Date.now() - start,
        phase: "failed",
      };
    }

    // Seed the in-memory flag from the durable session BEFORE any mount so
    // collaborator teardown suppresses kill_pty.
    this.reloadInProgress = true;

    // Crash-loop guard: durably claim ONE attempt BEFORE any restore side-effect.
    const claimed = await this.session.claimAttempt(pending.token);
    if (!claimed || claimed.attempts > claimed.maxAttempts) {
      await this.session.clear(pending.token);
      this.reloadInProgress = false;
      resetAdoptionBarrier();
      this.store.transition("failed");
      return {
        success: false,
        restoredSessions: 0,
        lostSessions: [],
        elapsedMs: Date.now() - start,
        phase: "failed",
      };
    }

    // A/bootstrap path: mint a fresh incident (boundaryCaught=false — the prior
    // boundary state died with the old context). Sign provenance for an EXPECTED
    // resume comes from session.decision.sign, NOT a fresh classifySign of
    // `evidence`, so a self-induced (B-escalation) reload is not mislabeled.
    void evidence; // unexpected-reload classification path is not taken here
    const incidentId = this.store.beginIncident();
    this.store.transition("suspect");
    this.store.recordSign(claimed.decision.sign, incidentId);
    this.store.transition("recovering");

    try {
      const snapshot = await this.topology.loadPersisted();
      if (!snapshot) {
        throw new Error("no durable snapshot to restore");
      }
      // Phase 1: rebuild shell with original ids (teardown suppressed via flag).
      const report = this.topology.restoreShell(snapshot);
      const lost: string[] = [...report.failedSessions];
      let restored = 0;

      // Adoption-readiness barrier (plan node 12b): arm with the full
      // restored-id set — arming also unblocks the bootstrap's pre-render
      // wait, so the first render mounts the RESTORED tabs (never the
      // default-tab fallback) — then hold Phase 2 until every adopt-mode
      // mount has subscribed its pty-data listener. Replay must never be
      // emitted into a listenerless void (rev-2 3-way HIGH).
      const allIds = collectSnapshotSessionIds(snapshot);
      armAdoptionBarrier(allIds);
      const timedOut = await awaitAdoptionReadiness(
        resilienceConfig.adoptionReadinessTimeoutMs,
      );
      for (const sessionId of timedOut) {
        lost.push(sessionId);
      }
      const readyIds = allIds.filter((id) => !timedOut.includes(id));

      // Phase 2: rebind each surviving PTY + replay its ring. A dead PTY comes
      // back alive=false (becomes a lost/exited tile, not a throw).
      for (const sessionId of readyIds) {
        try {
          const result = await this.reattach.reattach(sessionId, {
            maxBytes: resilienceConfig.replayBudgetBytes,
          });
          if (result.alive) restored += 1;
          else {
            lost.push(sessionId);
            // Dead-PTY collaborator tiles restore as exited shells that keep
            // handle/nickname/log identity (design policy: never dropped,
            // never auto-respawned). Unknown ids (terminal leaves) no-op.
            useCollaboratorStore.getState().setAgentStatus(sessionId, "exited");
          }
        } catch {
          lost.push(sessionId);
          useCollaboratorStore.getState().setAgentStatus(sessionId, "exited");
        }
      }

      this.store.transition("recovered");
      await this.session.clear(pending.token);
      this.reloadInProgress = false;
      resetAdoptionBarrier();
      return {
        success: lost.length === 0,
        restoredSessions: restored,
        lostSessions: lost,
        elapsedMs: Date.now() - start,
        phase: "recovered",
      };
    } catch (err) {
      this.store.transition("failed");
      await this.session.clear(pending.token);
      this.reloadInProgress = false;
      resetAdoptionBarrier();
      throw err;
    }
  }

  isReloadInProgress(): boolean {
    // OR-in the bootstrap seed: the durable pending session is known BEFORE
    // the first render (Phase A), long before resumeAfterReload's own field
    // write — and the very first mounts must already suppress teardown.
    return this.reloadInProgress || bootstrapReloadPending;
  }

  abort(reason: string): void {
    console.warn(`[resilience] recovery aborted: ${reason}`);
    this.reloadInProgress = false;
    // Durable clear is async; resolve the pending token best-effort.
    void this.session
      .loadPending()
      .then((s) => (s ? this.session.clear(s.token) : undefined))
      .catch(() => {
        /* swallowed — expiry guard backstops an uncleared session */
      });
    this.store.transition("failed");
  }
}

/** Shared singleton. */
export const recoveryOrchestrator = new RecoveryOrchestrator();
