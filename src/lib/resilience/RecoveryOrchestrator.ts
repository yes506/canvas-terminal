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
import { resilienceConfig } from "./config";

/** Collect every leaf session id of a persisted snapshot, in tree order. */
function collectSnapshotSessionIds(snapshot: TopologySnapshot): string[] {
  const ids: string[] = [];
  const walk = (node: SnapshotPane): void => {
    if (node.type === "leaf") {
      ids.push(node.sessionId);
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

      // Phase 2: rebind each surviving PTY + replay its ring. A dead PTY comes
      // back alive=false (becomes a lost/exited tile, not a throw).
      for (const sessionId of collectSnapshotSessionIds(snapshot)) {
        try {
          const result = await this.reattach.reattach(sessionId, {
            maxBytes: resilienceConfig.replayBudgetBytes,
          });
          if (result.alive) restored += 1;
          else lost.push(sessionId);
        } catch {
          lost.push(sessionId);
        }
      }

      this.store.transition("recovered");
      await this.session.clear(pending.token);
      this.reloadInProgress = false;
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
      throw err;
    }
  }

  isReloadInProgress(): boolean {
    return this.reloadInProgress;
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
